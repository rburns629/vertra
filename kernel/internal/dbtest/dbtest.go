// SPDX-License-Identifier: MIT

// Package dbtest gives tests the real, migrated test database
// (TEST_DATABASE_URL, as `make test-db` makes it) and throwaway databases.
// An unreachable test database fails the run: it's never skipped.
package dbtest

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// URL is the test database's.
func URL() string {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgresql://localhost/execution_kernel_test"
	}
	return strings.Replace(url, "postgresql+asyncpg://", "postgresql://", 1)
}

// Main opens the test database for a package's TestMain, or exits.
func Main(m *testing.M, pool **pgxpool.Pool) {
	p, err := pgxpool.New(context.Background(), URL())
	if err == nil {
		err = p.Ping(context.Background())
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "the test database (%s) isn't reachable: %v (make test-db)\n", URL(), err)
		os.Exit(1)
	}
	*pool = p
	code := m.Run()
	p.Close()
	os.Exit(code)
}

// Tx is a transaction on pool, rolled back when the test ends.
func Tx(t *testing.T, pool *pgxpool.Pool) pgx.Tx {
	t.Helper()
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}

// Empty is a new database with nothing in it, dropped when the test ends:
// a fresh install before its migration has run.
func Empty(t *testing.T, pool *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()
	name := fmt.Sprintf("kernel_test_%d", time.Now().UnixNano())
	if _, err := pool.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	config := pool.Config().Copy()
	config.ConnConfig.Database = name
	empty, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		empty.Close()
		_, _ = pool.Exec(ctx, `DROP DATABASE `+pgx.Identifier{name}.Sanitize()+` WITH (FORCE)`)
	})
	return empty
}

// MainFresh is Main on a database of the package's own, made for the run
// and dropped after it, migrated by migrateFn: for tests that commit.
func MainFresh(m *testing.M, pool **pgxpool.Pool, migrateFn func(*pgxpool.Pool) error) {
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, URL())
	if err == nil {
		err = admin.Ping(ctx)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "the test database (%s) isn't reachable: %v (make test-db)\n", URL(), err)
		os.Exit(1)
	}
	name := fmt.Sprintf("kernel_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	config := admin.Config().Copy()
	config.ConnConfig.Database = name
	p, err := pgxpool.NewWithConfig(ctx, config)
	if err == nil {
		err = migrateFn(p)
	}
	code := 1
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	} else {
		*pool = p
		code = m.Run()
	}
	if p != nil {
		p.Close()
	}
	_, _ = admin.Exec(ctx, `DROP DATABASE `+pgx.Identifier{name}.Sanitize()+` WITH (FORCE)`)
	admin.Close()
	os.Exit(code)
}
