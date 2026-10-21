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
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/access"
	"github.com/rburns629/vertra/cli/internal/awscloud"
	"github.com/rburns629/vertra/cli/internal/catalog"
	"github.com/rburns629/vertra/cli/internal/catalogtool"
	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/consoleapi"
	"github.com/rburns629/vertra/cli/internal/gcp"
	"github.com/rburns629/vertra/cli/internal/githost"
	"github.com/rburns629/vertra/cli/internal/modules"
	"github.com/rburns629/vertra/cli/internal/plan"
	"github.com/rburns629/vertra/cli/internal/platform"
	"github.com/rburns629/vertra/cli/internal/tofu"
	"github.com/rburns629/vertra/cli/internal/tools"
)

// What earlier versions set on a catalog repository: the console it called
// and its tokens, from before consoles pulled its release, and every
// variable under the platform's name before 2026-10-20 (Acyclix). Removed
// from the repository, and the tokens revoked, when `vertra catalog create` runs
// again.
var (
	oldCatalogVariables = []string{"ACYCLIX_CONSOLE_URL", "ACYCLIX_REGISTRY", "ACYCLIX_SIGNING_MODE", "ACYCLIX_SIGNING_KEY"}
	oldCatalogSecrets   = [][2]string{{"", "ACYCLIX_TOKEN"}, {"purge", "ACYCLIX_PURGE_TOKEN"}}
)

func oldTokenLabels(repo string) []string {
	return []string{"catalog CI: " + repo, "catalog purge: " + repo}
}

// catalogCmd is everything about a catalog: making its repository
// (create, here), and its own commands (catalog_commands.go).
func (a *app) catalogCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "catalog",
		Short: "A catalog: create its repository; validate, test, publish and release its products",
	}
	cmd.AddCommand(a.catalogCreateCmd())
	cmd.AddCommand(catalogCommands()...)
	return cmd
}

func (a *app) catalogCreateCmd() *cobra.Command {
	var yes, planOnly, noSmoke bool
	cmd := &cobra.Command{
		Use:   "create [env]",
		Short: "Create the catalog repository on GitHub, its first team and starters, and smoke-test it",
		Long: "Creates the catalog repository from the catalog template (with the first team and the\n" +
			"starters for the languages picked), sets its variables (the registry and its sign-in: no\n" +
			"console credential, since the console pulls the catalog's release), pushes it, waits for\n" +
			"its CI to publish, has the console apply the release, and runs a starter.",
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
	registry string
	// variables are the repository's cloud sign-in variables.
	variables [][2]string
}

func (a *app) catalog(ctx context.Context, out io.Writer, dir string, c *config.Config, yes, planOnly, noSmoke bool) error {
	cat := c.Catalog
	if cat.Repo() == "" {
		return errors.New("no catalog in the config: `vertra config set catalog.owner <owner>` (and catalog.repository, catalog.team), or `vertra init --force`")
	}
	if c.Target != "gcp" && c.Target != "aws" {
		return errors.New("the catalog's CI publishes to the install's registry: a gcp or aws install")
	}
	if c.Vertra != "source" {
		return errors.New("the catalog template comes from a source checkout until released CLIs embed it (cli/DESIGN.md, step 8)")
	}
	statuses := tools.CheckAll(ctx, tools.ForCatalog())
	for _, s := range statuses {
		if !s.OK() {
			return fmt.Errorf("%s: %s %s", s.Tool, s.Problem, s.Install)
		}
	}

	// What the install made: the registry and the federation; and the GitHub
	// side.
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
			return fmt.Errorf("github.com/%s already exists and isn't the one this install chose: `vertra config set catalog.useExisting true` to use it (its contents stay), or another catalog.repository", cat.Repo())
		}
	}
	// Environments (the publish job's main-only gate, the reviewed image deletion)
	// need a paid plan on a private repository; on GitHub Free the
	// workflows run without them and the secrets sit at repository level.
	// An unknown plan counts as free: GitHub doesn't always say.
	paid := me.Plan != "" && me.Plan != "free"
	environments := cat.Visibility == "public" || (!org && paid)
	owners := "@" + cat.Owner
	if org {
		owners = "@" + cat.Owner + "/catalog-admins"
	}

	p := &plan.Plan{Title: fmt.Sprintf("Catalog github.com/%s (%s) for Vertra [%s]", cat.Repo(), cat.Visibility, envName(dir))}
	starters := strings.Join(cat.Languages, ", ")
	if starters == "" {
		starters = "none"
	}
	p.Settings = []plan.Line{
		{Label: "Signed in", Text: fmt.Sprintf("%s on GitHub (%s plan); gh runs as you", me.Login, orDefault(me.Plan, "unknown"))},
		{Label: "Team", Text: fmt.Sprintf("%s, with starters in %s", cat.Team, starters)},
		{Label: "Owners", Text: owners + " approve every change (CODEOWNERS)"},
		{Label: "Publishes to", Text: setup.registry + ", signing in through federation (main only, no key)"},
		{Label: "Release", Text: setup.registry + "/catalog-release, which the console reads and applies (no console credential in CI)"},
	}
	if exists && !push {
		p.Changes = append(p.Changes, plan.Line{Label: "Exists", Text: "the repository is left as it is: only its variables are set"})
	} else if exists {
		p.Changes = append(p.Changes, plan.Line{Label: "Will push", Text: fmt.Sprintf("main to the existing, empty repository: the template, teams/%s and its starters", cat.Team)})
	} else {
		p.Changes = append(p.Changes,
			plan.Line{Label: "Will create", Text: fmt.Sprintf("github.com/%s, %s, from the catalog template", cat.Repo(), cat.Visibility)},
			plan.Line{Label: "Will push", Text: fmt.Sprintf("main: the template, teams/%s and its starters", cat.Team)})
	}
	p.Changes = append(p.Changes,
		plan.Line{Label: "Will set", Text: "variables VERTRA_REGISTRY, VERTRA_SIGNING_MODE (none), " + variableNames(setup.variables)},
		plan.Line{Label: "Will remove", Text: "a console URL and tokens an earlier vertra gave the repository, if any (and revoke those tokens)"})
	if environments {
		p.Changes = append(p.Changes, plan.Line{Label: "Environments", Text: "catalog-publish (main only), purge (main only, you review: deleting a removed team's images)"})
	} else {
		p.Notes = append(p.Notes, "Skipped: Environments and branch rules, which a private repository needs a paid GitHub plan for. The publish job still runs from main only (federation refuses other branches).")
	}
	p.Notes = append(p.Notes, "Team "+cat.Team+" (and its namespace) is made by the console when it applies the first release, not before.")
	if !noSmoke && len(cat.Languages) > 0 {
		p.Notes = append(p.Notes, "Then: waits for CI on the push, has the console apply the release, and runs the "+config.Languages[cat.Languages[0]]+" starter as a smoke test.")
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

	// The console, as the admin, over a port-forward: it needn't be public.
	password, err := a.ask.Secret("Password of "+c.Admin.Email+" on the console", "VERTRA_ADMIN_PASSWORD")
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

	repo := cat.Repo()
	work := ""
	if push {
		work, err = os.MkdirTemp("", "vertra-catalog-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(work)
		products, err := catalog.Assemble(catalog.Options{
			Template: filepath.Join(c.Source, "catalog-template"), Team: cat.Team, Owners: owners,
			Languages: cat.Languages, Registry: setup.registry,
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
			if err := gh.CreateRepository(ctx, cat.Owner, cat.Repository, cat.Visibility, "Vertra catalog: what teams offer, as products", org); err != nil {
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

	// Variables before the push, so its first CI run has them.
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
		{"VERTRA_REGISTRY", setup.registry}, {"VERTRA_SIGNING_MODE", "none"},
	}, setup.variables...) {
		if err := gh.SetVariable(ctx, repo, v[0], v[1]); err != nil {
			return err
		}
	}
	for _, name := range oldCatalogVariables {
		if err := gh.DeleteVariable(ctx, repo, name); err != nil {
			return err
		}
	}
	for _, s := range oldCatalogSecrets {
		if err := gh.DeleteSecret(ctx, repo, s[0], s[1]); err != nil {
			return err
		}
	}
	for _, label := range oldTokenLabels(repo) {
		if n, err := api.RevokeOthers(ctx, label, ""); err != nil {
			return err
		} else if n > 0 {
			fmt.Fprintf(out, "Revoked %d console token(s) the catalog no longer needs (%s).\n", n, label)
		}
	}
	if environments {
		myID, err := gh.UserID(ctx, me.Login)
		if err != nil {
			return err
		}
		for _, env := range []struct {
			name      string
			reviewers []int64
		}{{"catalog-publish", nil}, {"purge", []int64{myID}}} {
			if err := gh.CreateEnvironment(ctx, repo, env.name, env.reviewers); err != nil {
				return fmt.Errorf("environment %s: %w", env.name, err)
			}
		}
	}
	if push {
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
		return nil, fmt.Errorf("read the install's cloud side (run `vertra apply` first): %w", err)
	}
	if c.Target == "aws" {
		return a.catalogSetupAWS(ctx, c, outputs)
	}
	cloud, err := cloudFromGCP(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.CatalogProvider == "" {
		return nil, errors.New("the install has no federation for the catalog yet: run `vertra apply` (it creates it from catalog.owner and catalog.repository)")
	}
	if err := gcp.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	return &catalogSetup{
		registry: cloud.TaskRegistry,
		variables: [][2]string{
			{"GCP_WORKLOAD_IDENTITY_PROVIDER", cloud.CatalogProvider}, {"PUBLISH_GCP_SERVICE_ACCOUNT", cloud.CatalogServiceAccount},
		},
	}, nil
}

// catalogSetupAWS is catalogSetup for aws: ECR and the GitHub role.
func (a *app) catalogSetupAWS(ctx context.Context, c *config.Config, outputs map[string]json.RawMessage) (*catalogSetup, error) {
	cloud, _, err := cloudFromAWS(outputs)
	if err != nil {
		return nil, err
	}
	if cloud.CatalogServiceAccount == "" {
		return nil, errors.New("the install has no GitHub role for the catalog yet: run `vertra apply` (it creates it from catalog.owner and catalog.repository)")
	}
	if err := awscloud.Credentials(ctx, a.runner, c); err != nil {
		return nil, err
	}
	return &catalogSetup{
		registry:  cloud.TaskRegistry,
		variables: [][2]string{{"AWS_ROLE_ARN", cloud.CatalogServiceAccount}, {"AWS_REGION", c.AWS.Region}},
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

// smokeTest waits for CI on the pushed commit, has the console apply the
// release it pushed, then runs the first starter through the console and
// reports what it returned.
func (a *app) smokeTest(ctx context.Context, out io.Writer, c *config.Config, gh *githost.GitHub, api *consoleapi.Client, setup *catalogSetup) error {
	cat := c.Catalog
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
		// Once more, for what failed: a runner may have stumbled.
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

	// Now rather than at the console's next look.
	applied, err := api.SyncCatalog(ctx)
	if err != nil {
		return err
	}
	switch {
	case applied.Release == "":
		return errors.New("the console reads no catalog release: run `vertra apply` (it sets the console's catalog.release)")
	case applied.Error != "":
		return fmt.Errorf("the console couldn't read the catalog's release: %s", applied.Error)
	case len(applied.Problems) > 0:
		return fmt.Errorf("the console applied the release except:\n  %s", strings.Join(applied.Problems, "\n  "))
	}
	fmt.Fprintf(out, "The console applied the release (commit %.7s).\n", applied.Commit)

	product := config.Languages[cat.Languages[0]]
	id, err := api.Submit(ctx, "vertra smoke test", fmt.Sprintf("vertra-smoke-%d", time.Now().Unix()), []consoleapi.Task{{
		ID: "smoke", Image: fmt.Sprintf("%s/%s/%s:latest", setup.registry, cat.Team, product),
		Action: "transform", Team: cat.Team,
		Inputs: map[string]any{"text": "hello from vertra"},
	}})
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Running %s/%s (execution %s)...\n", cat.Team, product, id)
	execution, err := api.Wait(ctx, id, 15*time.Minute)
	if err != nil {
		return err
	}
	for _, t := range execution.Tasks {
		fmt.Fprintf(out, "  %s: %s %v %s\n", t.ID, t.State, t.Outputs, t.Failure)
	}
	if execution.State != "SUCCEEDED" {
		return fmt.Errorf("the smoke test %s", strings.ToLower(execution.State))
	}
	fmt.Fprintln(out, "The catalog works: a merge publishes and releases, the console applies it, and its products run.")
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

// validateCatalog runs the catalog's own checks (`vertra catalog validate`)
// on the assembled commit, before anything is pushed.
func validateCatalog(ctx context.Context, dir string) error {
	c := catalogtool.New(dir)
	var buf bytes.Buffer
	c.Stdout, c.Stderr = &buf, &buf
	ok, err := c.Products(ctx, "validate", nil, nil)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("the assembled catalog fails `vertra catalog validate`:\n%s", buf.String())
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
