// SPDX-License-Identifier: MIT

package main

// The catalog's own commands (`vertra catalog ...`): what a catalog
// repository's CI and its contributors run, through the repository's
// ./vertra wrapper (the pinned vertra, checksum-verified). They validate,
// build, test, scan and publish a catalog's products, and release the
// catalog for each install's console to pull; none of them calls a console
// or a cluster. `vertra catalog create` (catalog.go) makes the repository.
//
//	vertra catalog validate [PRODUCT ...]   product.yaml and team.yaml, tests present
//	vertra catalog check    [PRODUCT ...]   validate, build, test and scan: what a PR runs
//	vertra catalog publish  [PRODUCT ...]   check, then push and sign
//	vertra catalog release                  push and sign the catalog's release: every team,
//	                                        SecretStore, product and template, as of this commit
//	vertra catalog changed  --base REF      the products changed since REF, as JSON
//	vertra catalog secret-stores check [TEAM ...]
//	vertra catalog bases [--update]         pin every Dockerfile's FROM to its digest
//	vertra catalog migrate                  rewrite a catalog from before format v2 or the rename

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/catalogtool"
)

// errReported ends a command that reported its own problems: exit 1, no
// more said.
var errReported = errors.New("reported")

// catalogCommands are the catalog's own commands, for `vertra catalog`.
func catalogCommands() []*cobra.Command {
	var cmds []*cobra.Command
	for _, name := range []string{"validate", "check", "publish"} {
		cmds = append(cmds, catalogProductsCmd(name))
	}
	return append(cmds, catalogChangedCmd(), catalogSecretStoresCmd(), catalogReleaseCmd(), catalogBasesCmd(), catalogMigrateCmd())
}

func openCatalog() (*catalogtool.Catalog, error) {
	root, err := catalogtool.Root()
	if err != nil {
		return nil, err
	}
	return catalogtool.New(root), nil
}

// result turns a command's verdict into its exit.
func catalogResult(ok bool, err error) error {
	if err != nil {
		return err
	}
	if !ok {
		return errReported
	}
	return nil
}

func printJSONList(list []string) error {
	if list == nil {
		list = []string{}
	}
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

func catalogProductsCmd(name string) *cobra.Command {
	short := map[string]string{
		"validate": "Check product.yaml and team.yaml, and that tests are present",
		"check":    "Validate, build, test and scan: what a pull request runs",
		"publish":  "Check, then push and sign each product",
	}[name]
	var changed string
	cmd := &cobra.Command{
		Use:   name + " [PRODUCT ...]",
		Short: short,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			var since *string
			if cmd.Flags().Changed("changed") {
				since = &changed
			}
			return catalogResult(c.Products(cmd.Context(), name, args, since))
		},
	}
	cmd.Flags().StringVar(&changed, "changed", "", "the products changed since `REF`")
	return cmd
}

func catalogChangedCmd() *cobra.Command {
	var base string
	cmd := &cobra.Command{
		Use:   "changed --base REF",
		Short: "List the products changed since REF, as JSON",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return printJSONList(c.ChangedProducts(base, c.AllProducts()))
		},
	}
	cmd.Flags().StringVar(&base, "base", "", "the `REF` to compare with")
	_ = cmd.MarkFlagRequired("base")
	return cmd
}

func catalogSecretStoresCmd() *cobra.Command {
	stores := &cobra.Command{Use: "secret-stores", Short: "Check teams' SecretStore files (a release carries them to each install)"}
	stores.AddCommand(&cobra.Command{
		Use:   "check [TEAM ...]",
		Short: "Check teams' SecretStore files",
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			teams := args
			if len(teams) == 0 {
				teams = c.SecretStoreTeams()
			}
			return catalogResult(c.SecretStoresCheck(teams), nil)
		},
	})
	return stores
}

func catalogReleaseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "release",
		Short: "Push and sign the catalog's release (every team, product and template, as of this commit) for each install to pull",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return catalogResult(c.Release(cmd.Context()))
		},
	}
}

func catalogBasesCmd() *cobra.Command {
	var update bool
	cmd := &cobra.Command{
		Use:   "bases",
		Short: "Pin every Dockerfile's FROM to its digest",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			return c.Bases(update)
		},
	}
	cmd.Flags().BoolVar(&update, "update", false, "re-pin already pinned bases to what their tag names now")
	return cmd
}

func catalogMigrateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "migrate",
		Short: "Rewrite an older catalog: from before format v2, or from before the rename to Vertra",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := openCatalog()
			if err != nil {
				return err
			}
			changed, problems, err := c.Migrate()
			if err != nil {
				return err
			}
			for _, p := range problems {
				fmt.Fprintln(os.Stderr, "  "+p)
			}
			fmt.Printf("%d file(s) rewritten in format %s. Review the diff, then run vertra catalog validate.\n", changed, catalogtool.APIVersion)
			return catalogResult(len(problems) == 0, nil)
		},
	}
}
