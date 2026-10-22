// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"regexp"

	"github.com/spf13/cobra"

	"github.com/rburns629/vertra/cli/internal/cluster"
	"github.com/rburns629/vertra/cli/internal/install"
)

// newPassword is the line the console's reset script prints.
var newPassword = regexp.MustCompile(`New password for (\S+): (\S+)`)

func (a *app) adminCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "admin", Short: "Recover access to the console"}
	var email string
	reset := &cobra.Command{
		Use:   "reset-password [env]",
		Short: "Give an admin a new password, shown once (the first admin's, unless --email)",
		Long: "Gives a console admin a new random password, inside the cluster (the console's own Pod), so only\n" +
			"someone with access to the cluster can. Every session the account had is signed out, and the\n" +
			"reset is in the audit log. For the first admin's password, which the install shows only once.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			_, c, err := a.load(args)
			if err != nil {
				return err
			}
			target := email
			if target == "" {
				target = c.Admin.Email
			}
			out, err := a.runner.Output(cmd.Context(), "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
				"exec", "deploy/"+install.ConsoleRelease+"-execution-console", "--", "node", "dist/db/resetAdmin.js", target)
			if err != nil {
				return fmt.Errorf("couldn't reset it (is the platform awake? `vertra wake`): %w", err)
			}
			m := newPassword.FindStringSubmatch(out)
			if m == nil {
				return fmt.Errorf("the console didn't say the new password")
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Sign in as %s with %s\nThat password is shown only this once: change it after signing in.\n", m[1], m[2])
			return nil
		},
	}
	reset.Flags().StringVar(&email, "email", "", "the admin whose password to reset (default: the first admin)")
	cmd.AddCommand(reset)
	return cmd
}
