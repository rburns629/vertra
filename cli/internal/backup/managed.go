// SPDX-License-Identifier: MIT

package backup

import (
	"context"
	"fmt"
	"time"

	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/install"
	"github.com/rburns629/vertra/cli/internal/run"
)

// ManagedNow takes an on-demand backup of a managed database, with your
// own sign-in, and waits for it: a Cloud SQL backup, or an RDS snapshot.
// It returns what to call it by.
func ManagedNow(ctx context.Context, r *run.Runner, c *config.Config, db *install.ManagedDatabase) (string, error) {
	switch db.Provider {
	case "gcp":
		return db.Instance, r.Run(ctx, "gcloud", "sql", "backups", "create", "--instance", db.Instance,
			"--project", c.GCP.Project, "--description", "vertra backup")
	case "aws":
		snapshot := "vertra-" + time.Now().UTC().Format("20060102-150405")
		if _, err := r.Output(ctx, "aws", awsArgs(c, "rds", "create-db-snapshot", "--db-instance-identifier", db.Instance,
			"--db-snapshot-identifier", snapshot, "--output", "text", "--query", "DBSnapshot.DBSnapshotIdentifier")...); err != nil {
			return "", err
		}
		return snapshot, r.Run(ctx, "aws", awsArgs(c, "rds", "wait", "db-snapshot-available", "--db-snapshot-identifier", snapshot)...)
	}
	return "", fmt.Errorf("no managed database on %s", db.Provider)
}

// ManagedList is a managed database's backups, as its cloud lists them.
func ManagedList(ctx context.Context, r *run.Runner, c *config.Config, db *install.ManagedDatabase) (string, error) {
	switch db.Provider {
	case "gcp":
		return r.Output(ctx, "gcloud", "sql", "backups", "list", "--instance", db.Instance, "--project", c.GCP.Project,
			"--format", "table(id, windowStartTime, type, status)", "--sort-by", "windowStartTime")
	case "aws":
		return r.Output(ctx, "aws", awsArgs(c, "rds", "describe-db-snapshots", "--db-instance-identifier", db.Instance,
			"--query", "sort_by(DBSnapshots, &SnapshotCreateTime)[].[DBSnapshotIdentifier, SnapshotCreateTime, SnapshotType, Status]",
			"--output", "table")...)
	}
	return "", fmt.Errorf("no managed database on %s", db.Provider)
}
