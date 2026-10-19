// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/rburns629/acyclix/cli/internal/access"
	"github.com/rburns629/acyclix/cli/internal/awscloud"
	"github.com/rburns629/acyclix/cli/internal/catalog"
	"github.com/rburns629/acyclix/cli/internal/config"
	"github.com/rburns629/acyclix/cli/internal/consoleapi"
	"github.com/rburns629/acyclix/cli/internal/gcp"
	"github.com/rburns629/acyclix/cli/internal/githost"
	"github.com/rburns629/acyclix/cli/internal/install"
	"github.com/rburns629/acyclix/cli/internal/modules"
	"github.com/rburns629/acyclix/cli/internal/plan"
	"github.com/rburns629/acyclix/cli/internal/platform"
	"github.com/rburns629/acyclix/cli/internal/tofu"
	"github.com/rburns629/acyclix/cli/internal/tools"
)

// The catalog CI token's scopes: everything its workflows do, nothing more
// (README "Publishing"). Purging gets its own token.
var (
	catalogScopes = []string{"products:register", "teams:create", "teams:retire", "secret-stores:apply"}
	purgeScopes   = []string{"teams:delete"}
)

func (a *app) catalogCmd() *cobra.Command {
	var yes, planOnly, noSmoke bool
	cmd := &cobra.Command{
		Use:   "catalog [env]",
		Short: "Create the catalog repository on GitHub, its first team and starters, and smoke-test it",
		Long: "Creates the catalog repository from the catalog template (with the first team and the\n" +
			"starters for the languages picked), sets its variables and secrets (tokens minted on the\n" +
			"console, never shown), pushes it, waits for its CI to publish, and runs a starter.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, c, err := a.load(args)
			if err != nil {
				return err
			}
			return a.catalog(cmd.Context(), cmd.OutOrStdout(), dir, c, yes, planOnly, noSmoke)
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "approve without asking")
	cmd.Flags().BoolVar(&planOnly, "plan-only", false, "show what it would do and stop")
	cmd.Flags().BoolVar(&noSmoke, "no-smoke-test", false, "don't wait for CI or run a starter")
	return cmd
}

// catalogSetup is what the catalog needs from the install.
type catalogSetup struct {
	registry, consoleURL, certificate string
	// variables are the repository's cloud sign-in variables.
	variables [][2]string
	// certificateStatus reads the console certificate's status again
	// ("Active" once it's usable).
	certificateStatus func() string
}

func (a *app) catalog(ctx context.Context, out io.Writer, dir string, c *config.Config, yes, planOnly, noSmoke bool) error {
	cat := c.Catalog
	if cat.Repo() == "" {
		return errors.New("no catalog in the config: `acyclixctl config set catalog.owner <owner>` (and catalog.repository, catalog.team), or `acyclixctl init --force`")
	}
	if (c.Target != "gcp" && c.Target != "aws") || !c.Console.Public {
		return errors.New("the catalog's CI needs to reach the console over HTTPS: a gcp or aws install with console.public")
	}
	if c.Acyclix != "source" {
		return errors.New("the catalog template comes from a source checkout until released CLIs embed it (cli/DESIGN.md, step 8)")
	}
	statuses := tools.CheckAll(ctx, tools.ForCatalog())
	for _, s := range statuses {
		if !s.OK() {
			return fmt.Errorf("%s: %s %s", s.Tool, s.Problem, s.Install)
		}
	}

	// What the install made: the registry, the console's address, the
	// federation; and the GitHub side.
	setup, err := a.catalogSetup(ctx, dir, c)
	if err != nil {
		return err
	}
	gh := githost.NewGitHub(a.runner)
	if err := sameIdentity(c.Access.GitHub, access.CheckGitHub(ctx, a.runner.Exec).Identity); err != nil {
		return err
	}
	me, err := gh.Me(ctx)
	if err != nil {
		return err
	}
	if missing := me.MissingScopes(); len(missing) > 0 {
		return fmt.Errorf("your gh token lacks %s: `gh auth refresh -s %s`", strings.Join(missing, ", "), strings.Join(missing, ","))
	}
	org, err := gh.IsOrganization(ctx, cat.Owner)
	if err != nil {
		return err
	}
	exists, err := gh.Exists(ctx, cat.Repo())
	if err != nil {
		return err
	}
	// One that exists but is empty (a run stopped before its push) gets
	// the push.
	push := !exists
	if exists {
		if push, err = gh.HasBranches(ctx, cat.Repo()); err != nil {
			return err
		}
		push = !push
		if !push && !cat.UseExisting {
			return fmt.Errorf("github.com/%s already exists and isn't the one this install chose: `acyclixctl config set catalog.useExisting true` to use it (its contents stay), or another catalog.repository", cat.Repo())
		}
	}
	// Environments (the publish job's main-only gate, the reviewed purge)
	// need a paid plan on a private repository; on GitHub Free the
	// workflows run without them and the secrets sit at repository level.
	// An unknown plan counts as free: GitHub doesn't always say.
	paid := me.Plan != "" && me.Plan != "free"
	environments := cat.Visibility == "public" || (!org && paid)
	owners := "@" + cat.Owner
	if org {
		owners = "@" + cat.Owner + "/catalog-admins"
	}

	p := &plan.Plan{Title: fmt.Sprintf("Catalog github.com/%s (%s) for Acyclix [%s]", cat.Repo(), cat.Visibility, envName(dir))}
	starters := strings.Join(cat.Languages, ", ")
	if starters == "" {
		starters = "none"
	}
	p.Settings = []plan.Line{
		{Label: "Signed in", Text: fmt.Sprintf("%s on GitHub (%s plan); gh runs as you", me.Login, orDefault(me.Plan, "unknown"))},
		{Label: "Team", Text: fmt.Sprintf("%s, with starters in %s", cat.Team, starters)},
		{Label: "Owners", Text: owners + " approve every change (CODEOWNERS)"},
		{Label: "Publishes to", Text: setup.registry + ", signing in through federation (main only, no key)"},
		{Label: "Console", Text: setup.consoleURL + " (certificate " + setup.certificate + ")"},
	}
	if exists && !push {
		p.Changes = append(p.Changes, plan.Line{Label: "Exists", Text: "the repository is left as it is: only its variables and secrets are set (new tokens)"})
	} else if exists {
		p.Changes = append(p.Changes, plan.Line{Label: "Will push", Text: fmt.Sprintf("main to the existing, empty repository: the template, teams/%s and its starters", cat.Team)})
	} else {
		p.Changes = append(p.Changes,
			plan.Line{Label: "Will create", Text: fmt.Sprintf("github.com/%s, %s, from the catalog template", cat.Repo(), cat.Visibility)},
			plan.Line{Label: "Will push", Text: fmt.Sprintf("main: the template, teams/%s and its starters", cat.Team)})
	}
	p.Changes = append(p.Changes,
		plan.Line{Label: "Will set", Text: "variables ACYCLIX_CONSOLE_URL, ACYCLIX_REGISTRY, ACYCLIX_SIGNING_MODE (none), " + variableNames(setup.variables)},
		plan.Line{Label: "Will mint", Text: "the catalog's console token (" + strings.Join(catalogScopes, ", ") + "), stored as the secret ACYCLIX_TOKEN without being shown"},
		plan.Line{Label: "Will create", Text: "team " + cat.Team + " in the console (its namespace too), so the first publish has it"})
	if environments {
		p.Changes = append(p.Changes, plan.Line{Label: "Environments", Text: "catalog-publish and " + cat.Team + " (main only), purge (main only, you review) with its own token (teams:delete)"})
	} else {
		p.Notes = append(p.Notes, "Skipped: Environments and branch rules, which a private repository needs a paid GitHub plan for. The publish job still runs from main only (federation refuses other branches), but its token is a repository secret, and the purge workflow has no token.")
	}
	if setup.certificate != "Active" {
		p.Notes = append(p.Notes, "The console's certificate isn't active yet, and CI calls the console as soon as main is pushed: this waits for it (Google issues it within an hour of apply) before pushing.")
	}
	if !noSmoke && len(cat.Languages) > 0 {
		p.Notes = append(p.Notes, "Then: waits for CI on the push, and runs the "+config.Languages[cat.Languages[0]]+" starter as a smoke test.")
	}
	p.Render(out)
	if planOnly {
		return nil
	}
	if !yes {
		ok, err := a.ask.Confirm("Go ahead?", false)
		if err != nil {
			return err
		}
		if !ok || !a.ask.Interactive {
			return errStopped
		}
	}

	// The console, as the admin, over a port-forward: works before the
	// certificate does.
	password, err := a.ask.Secret("Password of "+c.Admin.Email+" on the console", "ACYCLIX_ADMIN_PASSWORD")
	if err != nil {
		return err
	}
	fwd, err := platform.ForwardConsole(ctx, c)
	if err != nil {
		return err
	}
	defer fwd.Stop()
	api := consoleapi.New(fwd.URL)
	if err := api.SignIn(ctx, c.Admin.Email, password); err != nil {
		return err
	}
	if err := api.CreateTeam(ctx, cat.Team); err != nil {
		return err
	}

	repo := cat.Repo()
	work := ""
	if push {
		work, err = os.MkdirTemp("", "acyclix-catalog-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(work)
		products, err := catalog.Assemble(catalog.Options{
			Template: filepath.Join(c.Source, "catalog-template"), Team: cat.Team, Owners: owners,
			Languages: cat.Languages, Registry: setup.registry, Console: setup.consoleURL,
		}, work)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "Assembled the catalog: team %s, starters %s.\n", cat.Team, strings.Join(products, ", "))
		if err := validateCatalog(ctx, work); err != nil {
			return err
		}
		if !exists {
			fmt.Fprintln(out, "Creating", "github.com/"+repo, "...")
			if err := gh.CreateRepository(ctx, cat.Owner, cat.Repository, cat.Visibility, "Acyclix catalog: what teams offer, as products", org); err != nil {
				return err
			}
			// This install made it: later runs may update it.
			c.Catalog.UseExisting = true
			if err := c.Save(dir); err != nil {
				return err
			}
		}
	}

	// AWS trusts the repository by the subject GitHub's tokens carry, which
	// (immutable subjects) pins its id: known only now it exists.
	if c.Target == "aws" {
		if err := a.trustCatalogSubject(ctx, out, dir, c, gh, repo); err != nil {
			return err
		}
	}

	// Variables and secrets before the push, so its first CI run has them.
	// Another cloud's sign-in, left from before, would make the publish job
	// try a cloud this install doesn't use.
	for _, name := range cloudVariables {
		if !hasVariable(setup.variables, name) {
			if err := gh.DeleteVariable(ctx, repo, name); err != nil {
				return err
			}
		}
	}
	for _, v := range append([][2]string{
		{"ACYCLIX_CONSOLE_URL", setup.consoleURL}, {"ACYCLIX_REGISTRY", setup.registry}, {"ACYCLIX_SIGNING_MODE", "none"},
	}, setup.variables...) {
		if err := gh.SetVariable(ctx, repo, v[0], v[1]); err != nil {
			return err
		}
	}
	// Stored first, then the tokens it replaces revoked: the repository
	// never holds a revoked one.
	label := "catalog CI: " + repo
	tokenID, token, err := api.MintToken(ctx, label, catalogScopes)
	if err != nil {
		return err
	}
	if err := gh.SetSecret(ctx, repo, "", "ACYCLIX_TOKEN", token); err != nil {
		return err
	}
	token = ""
	if n, err := api.RevokeOthers(ctx, label, tokenID); err != nil {
		return err
	} else if n > 0 {
		fmt.Fprintf(out, "Revoked the %d older catalog token(s) this one replaces.\n", n)
	}
	if environments {
		myID, err := gh.UserID(ctx, me.Login)
		if err != nil {
			return err
		}
		for _, env := range []struct {
			name      string
			reviewers []int64
		}{{"catalog-publish", nil}, {cat.Team, nil}, {"purge", []int64{myID}}} {
			if err := gh.CreateEnvironment(ctx, repo, env.name, env.reviewers); err != nil {
				return fmt.Errorf("environment %s: %w", env.name, err)
			}
		}
		purgeLabel := "catalog purge: " + repo
		purgeID, purge, err := api.MintToken(ctx, purgeLabel, purgeScopes)
		if err != nil {
			return err
		}
		if err := gh.SetSecret(ctx, repo, "purge", "ACYCLIX_PURGE_TOKEN", purge); err != nil {
			return err
		}
		if _, err := api.RevokeOthers(ctx, purgeLabel, purgeID); err != nil {
			return err
		}
	}
	if push {
		if setup.certificate != "Active" {
			fmt.Fprintln(out, "Waiting for the console's certificate before pushing (CI calls the console at once)...")
			if err := waitFor(ctx, 75*time.Minute, time.Minute, func() (bool, error) {
				return setup.certificateStatus() == "Active", nil
			}); err != nil {
				return fmt.Errorf("the console's certificate isn't active yet (`acyclixctl status`); run `acyclixctl catalog` again once it is: %w", err)
			}
			setup.certificate = "Active"
		}
		fmt.Fprintln(out, "Pushing main...")
		if err := gh.Push(ctx, work, repo); err != nil {
			return err
		}
	}
	fmt.Fprintf(out, "The catalog is at https://github.com/%s\n", repo)
	if noSmoke || len(cat.Languages) == 0 {
		return nil
	}
	return a.smokeTest(ctx, out, c, gh, api, setup)
}

// catalogSetup reads what the install made from the module's outputs.
func (a *app) catalogSetup(ctx context.Context, dir string, c *config.Config) (*catalogSetup, error) {
	tf := tofu.In(a.runner, dir)
	outputs, err := tf.Outputs(ctx)
	if err != nil {
		return nil, fmt.Errorf("read the install's cloud side (run `acyclixctl apply` first): %w", err)
	}
	if c.Target == "aws" {
		return a.catalogSetupAWS(ctx, c, outputs)
	}
	cloud, err := cloudFromGCP(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.CatalogProvider == "" {
		return nil, errors.New("the install has no federation for the catalog yet: run `acyclixctl apply` (it creates it from catalog.owner and catalog.repository)")
	}
	if cloud.ConsoleIP == "" {
		return nil, errors.New("the console has no public address yet: run `acyclixctl apply` with console.public")
	}
	if err := gcp.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	return &catalogSetup{
		registry:    cloud.TaskRegistry,
		consoleURL:  "https://" + install.ConsoleHostname(c, cloud.ConsoleIP),
		certificate: orDefault(install.CertificateStatus(ctx, a.runner, c), "not requested"),
		variables: [][2]string{
			{"GCP_WORKLOAD_IDENTITY_PROVIDER", cloud.CatalogProvider}, {"PUBLISH_GCP_SERVICE_ACCOUNT", cloud.CatalogServiceAccount},
		},
		certificateStatus: func() string { return install.CertificateStatus(ctx, a.runner, c) },
	}, nil
}

// catalogSetupAWS is catalogSetup for aws: ECR, the GitHub role, and the
// console's ACM certificate.
func (a *app) catalogSetupAWS(ctx context.Context, c *config.Config, outputs map[string]json.RawMessage) (*catalogSetup, error) {
	cloud, _, err := cloudFromAWS(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.CatalogServiceAccount == "" {
		return nil, errors.New("the install has no GitHub role for the catalog yet: run `acyclixctl apply` (it creates it from catalog.owner and catalog.repository)")
	}
	if cloud.ConsoleHost == "" {
		return nil, errors.New("the console has no public address yet: set console.public and console.zone, then `acyclixctl apply`")
	}
	if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	status := func() string {
		if awscloud.CertificateStatus(ctx, a.runner, c, cloud.ConsoleCertificate) == "ISSUED" {
			return "Active"
		}
		return "not issued yet"
	}
	return &catalogSetup{
		registry:          cloud.TaskRegistry,
		consoleURL:        "https://" + cloud.ConsoleHost,
		certificate:       status(),
		variables:         [][2]string{{"AWS_ROLE_ARN", cloud.CatalogServiceAccount}, {"AWS_REGION", c.AWS.Region}},
		certificateStatus: status,
	}, nil
}

// cloudVariables are every cloud's sign-in variables the template reads.
var cloudVariables = []string{"GCP_WORKLOAD_IDENTITY_PROVIDER", "PUBLISH_GCP_SERVICE_ACCOUNT", "AWS_ROLE_ARN", "AWS_REGION"}

func hasVariable(vars [][2]string, name string) bool {
	for _, v := range vars {
		if v[0] == name {
			return true
		}
	}
	return false
}

func variableNames(vars [][2]string) string {
	var names []string
	for _, v := range vars {
		names = append(names, v[0])
	}
	return strings.Join(names, ", ")
}

// smokeTest waits for the certificate and CI on the pushed commit, then
// runs the first starter through the console and reports what it returned.
func (a *app) smokeTest(ctx context.Context, out io.Writer, c *config.Config, gh *githost.GitHub, api *consoleapi.Client, setup *catalogSetup) error {
	cat := c.Catalog
	if setup.certificate != "Active" {
		return errors.New("the console's certificate isn't active yet: CI can't reach the console (`acyclixctl status`)")
	}
	commit, err := gh.Head(ctx, cat.Repo(), "main")
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Waiting for CI on", commit[:7], "...")
	runs, err := waitForRuns(ctx, gh, cat.Repo(), commit)
	if err != nil {
		return err
	}
	if failed := failedRuns(runs); len(failed) > 0 {
		// Once more, for what failed: the console may have just become
		// reachable, or a runner may have stumbled.
		fmt.Fprintln(out, "Rerunning what failed once...")
		for _, r := range failed {
			if err := gh.Rerun(ctx, cat.Repo(), r.ID); err != nil {
				return err
			}
		}
		time.Sleep(10 * time.Second)
		if runs, err = waitForRuns(ctx, gh, cat.Repo(), commit); err != nil {
			return err
		}
	}
	for _, r := range runs {
		fmt.Fprintf(out, "  %-22s %s\n", r.Workflow, r.Conclusion)
	}
	if len(failedRuns(runs)) > 0 {
		return fmt.Errorf("CI failed on the first push: see the runs at https://github.com/%s/actions", cat.Repo())
	}

	product := config.Languages[cat.Languages[0]]
	dag := map[string]any{
		"name":      "acyclixctl smoke test",
		"requestId": fmt.Sprintf("acyclixctl-smoke-%d", time.Now().Unix()),
		"tasks": []map[string]any{{
			"id": "smoke", "image": fmt.Sprintf("%s/%s/%s:latest", setup.registry, cat.Team, product),
			"action": "transform", "team": cat.Team,
			"inputs": map[string]any{"text": "hello from acyclixctl"},
		}},
	}
	id, err := api.Submit(ctx, dag)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Running %s/%s (execution %s)...\n", cat.Team, product, id)
	var execution *consoleapi.Execution
	if err := waitFor(ctx, 15*time.Minute, 5*time.Second, func() (bool, error) {
		execution, err = api.Get(ctx, id)
		if err != nil {
			return false, err
		}
		return execution.State == "SUCCEEDED" || execution.State == "FAILED" || execution.State == "CANCELLED", nil
	}); err != nil {
		return err
	}
	for _, t := range execution.Tasks {
		fmt.Fprintf(out, "  %s: %s %v %v\n", t.ID, t.State, t.Outputs, t.Failure)
	}
	if execution.State != "SUCCEEDED" {
		return fmt.Errorf("the smoke test %s", strings.ToLower(execution.State))
	}
	fmt.Fprintln(out, "The catalog works: a merge publishes, and its products run.")
	return nil
}

// waitForRuns waits until every run on commit has completed.
func waitForRuns(ctx context.Context, gh *githost.GitHub, repo, commit string) ([]githost.Run, error) {
	var runs []githost.Run
	err := waitFor(ctx, 45*time.Minute, 20*time.Second, func() (bool, error) {
		var err error
		runs, err = gh.Runs(ctx, repo, commit)
		if err != nil || len(runs) == 0 {
			return false, err
		}
		for _, r := range runs {
			if r.Status != "completed" {
				return false, nil
			}
		}
		return true, nil
	})
	return runs, err
}

func failedRuns(runs []githost.Run) []githost.Run {
	var failed []githost.Run
	for _, r := range runs {
		if r.Conclusion != "success" && r.Conclusion != "skipped" {
			failed = append(failed, r)
		}
	}
	return failed
}

func waitFor(ctx context.Context, limit, every time.Duration, done func() (bool, error)) error {
	deadline := time.Now().Add(limit)
	for {
		ok, err := done()
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("gave up after %s", limit)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
}

// validateCatalog runs the catalog's own checks on the assembled commit,
// when Python is there for catalogctl.
func validateCatalog(ctx context.Context, dir string) error {
	if _, err := exec.LookPath("python3"); err != nil {
		return nil
	}
	cmd := exec.CommandContext(ctx, "./catalogctl", "validate")
	cmd.Dir = dir
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("the assembled catalog fails `catalogctl validate`:\n%s", buf.String())
	}
	return nil
}

// trustCatalogSubject reads the repository's OIDC subject prefix and, if the
// publish role doesn't trust it yet, records it and updates the role's trust.
func (a *app) trustCatalogSubject(ctx context.Context, out io.Writer, dir string, c *config.Config, gh *githost.GitHub, repo string) error {
	prefix, err := gh.SubjectPrefix(ctx, repo)
	if err != nil {
		return err
	}
	if prefix == c.Catalog.SubjectPrefix || (c.Catalog.SubjectPrefix == "" && prefix == "repo:"+repo) {
		return nil
	}
	fmt.Fprintf(out, "GitHub names the repository %s in its tokens: updating the publish role to trust exactly that...\n", prefix)
	c.Catalog.SubjectPrefix = prefix
	if err := c.Save(dir); err != nil {
		return err
	}
	tf := tofu.In(a.runner, dir)
	if err := modules.Write("aws", tf.Path); err != nil {
		return err
	}
	if err := tf.Init(ctx); err != nil {
		return err
	}
	if err := a.writeAWSVars(ctx, c, tf, false); err != nil {
		return err
	}
	return tf.ApplyOnly(ctx, "aws_iam_role.publish[0]")
}
