// SPDX-License-Identifier: MIT

// catalogctl validates, builds, tests, scans and publishes a catalog's
// products, and manages its teams and SecretStores through the console. A
// catalog runs it through its ./catalogctl wrapper, which downloads this
// binary (pinned, checksum-verified); see cli/DESIGN.md.
//
//	catalogctl validate [PRODUCT ...]   product.yaml and team.yaml, tests present
//	catalogctl check    [PRODUCT ...]   validate, build, test and scan: what a PR runs
//	catalogctl publish  [PRODUCT ...]   check, then push, sign and register
//	catalogctl changed  --base REF      the products changed since REF, as JSON
//
//	catalogctl teams apply [TEAM ...] [--changed REF]   make each team exist and be active
//	catalogctl teams retire [TEAM ...] [--removed-since REF]
//	catalogctl teams purge TEAM                         irreversible; the folder must be gone
//	catalogctl teams changed --base REF                 teams changed since REF, as JSON
//	catalogctl secret-stores check [TEAM ...]
//	catalogctl secret-stores apply [TEAM ...]           BOOTSTRAP_CREDENTIAL: a stored credential
//	catalogctl bases [--update]                         pin every Dockerfile's FROM to its digest
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

	"github.com/rburns629/acyclix/cli/internal/catalogctl"
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
	root.AddCommand(changedCmd(), teamsCmd(), secretStoresCmd(), basesCmd())
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

func teamsCmd() *cobra.Command {
	teams := &cobra.Command{Use: "teams", Short: "make teams exist, retire and purge them, through the console"}

	var changed string
	apply := &cobra.Command{
		Use:   "apply [TEAM ...]",
		Short: "make each team exist and be active, with its namespace",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			names := args
			if len(names) == 0 {
				names = c.TeamsChanged(changed)
			}
			if len(names) == 0 {
				fmt.Println("No teams to apply.")
				return nil
			}
			console, err := c.TeamsConsole(cmd.Context())
			if err != nil {
				return err
			}
			return result(c.TeamsApply(cmd.Context(), names, console), nil)
		},
	}
	apply.Flags().StringVar(&changed, "changed", "", "the teams changed since `REF` (default: all)")

	var removedSince string
	retire := &cobra.Command{
		Use:   "retire [TEAM ...]",
		Short: "retire teams whose folders are gone (reversible)",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			names := args
			if len(names) == 0 {
				names = c.TeamsRemoved(removedSince)
			}
			if len(names) == 0 {
				fmt.Println("No teams to retire.")
				return nil
			}
			console, err := c.TeamsConsole(cmd.Context())
			if err != nil {
				return err
			}
			return result(c.TeamsRetire(cmd.Context(), names, console), nil)
		},
	}
	retire.Flags().StringVar(&removedSince, "removed-since", "", "the teams whose folder was removed since `REF`")

	purge := &cobra.Command{
		Use:   "purge TEAM",
		Short: "purge a retired team for good (irreversible; its folder must be gone)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			console, err := c.TeamsConsole(cmd.Context())
			if err != nil {
				return err
			}
			return result(c.TeamsPurge(cmd.Context(), args[0], console), nil)
		},
	}

	var base string
	changedTeams := &cobra.Command{
		Use:   "changed --base REF",
		Short: "the teams changed since REF, as JSON",
		Args:  cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			return printJSON(c.TeamsChanged(base))
		},
	}
	changedTeams.Flags().StringVar(&base, "base", "", "the `REF` to compare with")
	_ = changedTeams.MarkFlagRequired("base")

	teams.AddCommand(apply, retire, purge, changedTeams)
	return teams
}

func secretStoresCmd() *cobra.Command {
	stores := &cobra.Command{Use: "secret-stores", Short: "check and apply teams' SecretStore files"}
	selected := func(c *catalogctl.Catalog, args []string) []string {
		if len(args) > 0 {
			return args
		}
		return c.SecretStoreTeams()
	}
	stores.AddCommand(&cobra.Command{
		Use:   "check [TEAM ...]",
		Short: "check teams' SecretStore files",
		RunE: func(_ *cobra.Command, args []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			return result(c.SecretStoresCheck(selected(c, args)), nil)
		},
	}, &cobra.Command{
		Use:   "apply [TEAM ...]",
		Short: "check, then have the console apply, teams' SecretStores (BOOTSTRAP_CREDENTIAL: a stored credential)",
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := catalog()
			if err != nil {
				return err
			}
			console, err := c.TeamsConsole(cmd.Context())
			if err != nil {
				return err
			}
			return result(c.SecretStoresApply(cmd.Context(), selected(c, args), os.Getenv("BOOTSTRAP_CREDENTIAL"), console))
		},
	})
	return stores
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
