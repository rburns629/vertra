// SPDX-License-Identifier: MIT

// catalogctl validates, builds, tests, scans and publishes a catalog's
// products, and releases the catalog for each install's console to pull. A
// catalog runs it through its ./catalogctl wrapper, which downloads this
// binary (pinned, checksum-verified); see cli/DESIGN.md. It never calls a
// console: each console reads the release and applies it.
//
//	catalogctl validate [PRODUCT ...]   product.yaml and team.yaml, tests present
//	catalogctl check    [PRODUCT ...]   validate, build, test and scan: what a PR runs
//	catalogctl publish  [PRODUCT ...]   check, then push and sign
//	catalogctl release                  push and sign the catalog's release: every team,
//	                                    SecretStore and product, as of this commit
//	catalogctl changed  --base REF      the products changed since REF, as JSON
//
//	catalogctl secret-stores check [TEAM ...]
//	catalogctl bases [--update]         pin every Dockerfile's FROM to its digest
//	catalogctl migrate                  rewrite a catalog from before format v2 or the rename
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/catalogctl"
)

// Version is set at build time (-ldflags "-X main.Version=…").
var Version = "dev"

// failed is a command that reported its own problems: exit 1, no more said.
var failed = errors.New("failed")

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	err := newRoot().ExecuteContext(ctx)
	if err != nil && !errors.Is(err, failed) {
		fmt.Fprintln(os.Stderr, "Error:", err)
	}
	if err != nil {
		os.Exit(1)
	}
}

func catalog() (*catalogctl.Catalog, error) {
	root, err := catalogctl.Root()
	if err != nil {
		return nil, err
	}
	return catalogctl.New(root), nil
}

// result turns a command's verdict into its exit.
func result(ok bool, err error) error {
	if err != nil {
		return err
	}
	if !ok {
		return failed
	}
	return nil
}

func printJSON(list []string) error {
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

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "catalogctl",
		Short:         "Validate, build, test, scan and publish a catalog's products; manage its teams",
		Version:       Version,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	for _, name := range []string{"validate", "check", "publish"} {
		root.AddCommand(productsCmd(name))
	}
	root.AddCommand(changedCmd(), secretStoresCmd(), releaseCmd(), basesCmd(), migrateCmd())
	return root
}

func productsCmd(name string) *cobra.Command {
	short := map[string]string{
		"validate": "check product.yaml and team.yaml, and that tests are present",
		"check":    "validate, build, test and scan: what a pull request runs",
		"publish":  "check, then push, sign and register",
	}[name]
	var changed string
	cmd := &cobra.Command{
		Use:   name + " [PRODUCT ...]",
		Short: short,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			var since *string
			if cmd.Flags().Changed("changed") {
				since = &changed
			}
			return result(c.Products(cmd.Context(), name, args, since))
		},
	}
	cmd.Flags().StringVar(&changed, "changed", "", "the products changed since `REF`")
	return cmd
}

func changedCmd() *cobra.Command {
	var base string
	cmd := &cobra.Command{
		Use:   "changed --base REF",
		Short: "the products changed since REF, as JSON",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			return printJSON(c.ChangedProducts(base, c.AllProducts()))
		},
	}
	cmd.Flags().StringVar(&base, "base", "", "the `REF` to compare with")
	_ = cmd.MarkFlagRequired("base")
	return cmd
}

func secretStoresCmd() *cobra.Command {
	stores := &cobra.Command{Use: "secret-stores", Short: "check teams' SecretStore files (a release carries them to each install)"}
	stores.AddCommand(&cobra.Command{
		Use:   "check [TEAM ...]",
		Short: "check teams' SecretStore files",
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			teams := args
			if len(teams) == 0 {
				teams = c.SecretStoreTeams()
			}
			return result(c.SecretStoresCheck(teams), nil)
		},
	})
	return stores
}

func releaseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "release",
		Short: "push and sign the catalog's release (every team and product, as of this commit) for each install to pull",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			return result(c.Release(cmd.Context()))
		},
	}
}

func basesCmd() *cobra.Command {
	var update bool
	cmd := &cobra.Command{
		Use:   "bases",
		Short: "pin every Dockerfile's FROM to its digest",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			return c.Bases(update)
		},
	}
	cmd.Flags().BoolVar(&update, "update", false, "re-pin already pinned bases to what their tag names now")
	return cmd
}

func migrateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "migrate",
		Short: "rewrite an older catalog: from before format v2 (adds apiVersion and kind; requiredSecrets becomes secretRefs), or from before the rename to Vertra",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := catalog()
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
			fmt.Printf("%d file(s) rewritten in format %s. Review the diff, then run ./catalogctl validate.\n", changed, catalogctl.APIVersion)
			return result(len(problems) == 0, nil)
		},
	}
}
