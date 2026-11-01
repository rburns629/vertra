// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

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
			dir, c, err := a.load(args)
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
			path, err := savePassword(dir, m[2])
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Sign in as %s with the password in %s (only you can read it).\n%s\n", m[1], path, passwordThen)
			return nil
		},
	}
	reset.Flags().StringVar(&email, "email", "", "the admin whose password to reset (default: the first admin)")
	cmd.AddCommand(reset)
	return cmd
}

// passwordThen follows where a generated password is.
const passwordThen = "You'll choose your own when you sign in; then delete the file."

// savePassword writes a generated admin password to admin-password in the
// environment's folder, readable only by you and kept out of git beside it,
// and returns its path. Printed, it would land in CI logs and anything
// tee'd.
func savePassword(dir, password string) (string, error) {
	path := filepath.Join(dir, "admin-password")
	if err := os.WriteFile(path, []byte(password+"\n"), 0o600); err != nil {
		return "", err
	}
	// WriteFile keeps an existing file's mode.
	if err := os.Chmod(path, 0o600); err != nil {
		return "", err
	}
	ignore := filepath.Join(dir, ".gitignore")
	b, err := os.ReadFile(ignore)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if !slices.Contains(strings.Split(string(b), "\n"), "admin-password") {
		if len(b) > 0 && !strings.HasSuffix(string(b), "\n") {
			b = append(b, '\n')
		}
		if err := os.WriteFile(ignore, append(b, "admin-password\n"...), 0o644); err != nil {
			return "", err
		}
	}
	return path, nil
}
