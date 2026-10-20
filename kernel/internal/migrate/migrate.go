// SPDX-License-Identifier: MIT

// Package migrate owns the kernel's database schema: the SQL files in
// sql/, applied in order, each once, recorded in schema_migrations.
// kernel-api and kernel-scheduler wait until the database is at Latest
// (`kernel migrate` runs as the chart's hook Job). A file, once released,
// never changes: a change is a new file.
//
// The schema was Alembic's until the kernel moved to Go. An install it
// migrated (alembic_version at a revision these files share, 0001) is
// taken over as already at that version.
package migrate

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"regexp"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

//go:embed sql/*.sql
var files embed.FS

// Migration is one SQL file: 0001_initial_schema.sql is version "0001".
type Migration struct {
	Version string
	Name    string
	SQL     string
}

var fileName = regexp.MustCompile(`^(\d{4})_([a-z0-9_]+)\.sql$`)

// All is every migration, in order.
func All() []Migration {
	entries, err := fs.ReadDir(files, "sql")
	if err != nil {
		panic(err)
	}
	var all []Migration
	for _, e := range entries {
		m := fileName.FindStringSubmatch(e.Name())
		if m == nil {
			panic(fmt.Sprintf("migrate: %s isn't NNNN_name.sql", e.Name()))
		}
		data, err := files.ReadFile("sql/" + e.Name())
		if err != nil {
			panic(err)
		}
		all = append(all, Migration{Version: m[1], Name: m[2], SQL: string(data)})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Version < all[j].Version })
	return all
}

// Latest is the version this code is written against.
func Latest() string {
	all := All()
	return all[len(all)-1].Version
}

// DB is what reading the version needs: a pool, a connection or a transaction.
type DB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Current is the database's version, or "" before its first migration
// (or when it can't be read).
func Current(ctx context.Context, db DB) string {
	var version *string
	if err := db.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&version); err != nil || version == nil {
		return ""
	}
	return *version
}

// Conn is a single connection: the advisory lock is held by a session.
type Conn interface {
	DB
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// lockKey serializes migrators (two hook Jobs, a retried one); any
// constant no one else uses.
const lockKey = 7_315_002_841_660_512_771

// Run applies every migration the database doesn't have yet, each in its
// own transaction, and returns the versions it applied.
func Run(ctx context.Context, conn Conn, log *slog.Logger) ([]string, error) {
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, int64(lockKey)); err != nil {
		return nil, err
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, int64(lockKey)) }()

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version text NOT NULL PRIMARY KEY,
		applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return nil, err
	}
	if err := adoptAlembic(ctx, conn, log); err != nil {
		return nil, fmt.Errorf("taking over from Alembic: %w", err)
	}
	current := Current(ctx, conn)
	var applied []string
	for _, m := range All() {
		if m.Version <= current {
			continue
		}
		err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, m.SQL); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, m.Version)
			return err
		})
		if err != nil {
			return applied, fmt.Errorf("%s_%s: %w", m.Version, m.Name, err)
		}
		log.Info("applied database migration", "version", m.Version, "name", m.Name)
		applied = append(applied, m.Version)
	}
	return applied, nil
}

// adoptAlembic records an Alembic-migrated database's revision as this
// package's version of the same number, then drops alembic_version.
// Alembic's revisions here were numbered 0001, 0002, ... as these files are.
func adoptAlembic(ctx context.Context, conn Conn, log *slog.Logger) error {
	if Current(ctx, conn) != "" {
		return nil
	}
	var revision string
	err := conn.QueryRow(ctx, `SELECT version_num FROM alembic_version`).Scan(&revision)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" { // undefined_table: never Alembic's
		return nil
	}
	if err != nil {
		return err
	}
	known := false
	for _, m := range All() {
		known = known || m.Version == revision
	}
	if !known {
		return fmt.Errorf("alembic_version is %q, which this kernel doesn't know: upgrade through a release that does", revision)
	}
	return pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
		for _, m := range All() {
			if m.Version > revision {
				break
			}
			if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, m.Version); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DROP TABLE alembic_version`); err != nil {
			return err
		}
		log.Info("took the schema over from Alembic", "revision", revision)
		return nil
	})
}

// How often Wait checks; shorter in tests.
var waitPoll = time.Second

// Wait returns once the database is at Latest (or ctx ends): on a fresh
// install the migration Job runs after the kernel's Pods start (a Helm
// post-install hook). onPoll runs each time it checks (a liveness
// heartbeat: still waiting, not hung).
func Wait(ctx context.Context, db DB, onPoll func(), log *slog.Logger) {
	want := Latest()
	var lastLogged time.Time
	for {
		found := Current(ctx, db)
		if found == want {
			log.Info("database schema is current", "version", want)
			return
		}
		if time.Since(lastLogged) >= 15*time.Second {
			log.Info("waiting for database migrations", "expectedVersion", want, "foundVersion", found)
			lastLogged = time.Now()
		}
		onPoll()
		select {
		case <-ctx.Done():
			return
		case <-time.After(waitPoll):
		}
	}
}
