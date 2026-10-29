// SPDX-License-Identifier: MIT

// Package dbsetup prepares a managed database server's databases for
// their services, once per install, as an administrator: each database is
// opened to its own service alone (CONNECT and CREATE on it and its public
// schema), and to no one else (PUBLIC's default CONNECT is revoked). The
// services then make and own their own tables, as with the in-cluster
// Postgres; none can read another's. The console's is given with the grant
// option, so its migration can give the gateway what it reads
// (console/src/db/gatewayAccess.ts). Running it again changes nothing.
package dbsetup

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Grant is one database and the role it's opened to.
type Grant struct {
	Database string
	Role     string
	// Regrant: the role may pass what it's given on (the console, to the
	// gateway).
	Regrant bool
}

// Connect opens a connection to a database by name, as the administrator.
type Connect func(ctx context.Context, database string) (*pgx.Conn, error)

// Run applies each grant: the database's privileges from the server's
// maintenance database, its public schema's from the database itself.
func Run(ctx context.Context, connect Connect, maintenance string, grants []Grant) error {
	admin, err := connect(ctx, maintenance)
	if err != nil {
		return err
	}
	defer admin.Close(context.WithoutCancel(ctx))
	for _, g := range grants {
		database, role := pgx.Identifier{g.Database}.Sanitize(), pgx.Identifier{g.Role}.Sanitize()
		option := ""
		if g.Regrant {
			option = " WITH GRANT OPTION"
		}
		for _, statement := range []string{
			fmt.Sprintf("REVOKE ALL ON DATABASE %s FROM PUBLIC", database),
			fmt.Sprintf("GRANT CONNECT, CREATE, TEMPORARY ON DATABASE %s TO %s%s", database, role, option),
		} {
			if _, err := admin.Exec(ctx, statement); err != nil {
				return fmt.Errorf("%s: %w", g.Database, err)
			}
		}
		if err := grantSchema(ctx, connect, g, role, option); err != nil {
			return err
		}
	}
	return nil
}

func grantSchema(ctx context.Context, connect Connect, g Grant, role, option string) error {
	conn, err := connect(ctx, g.Database)
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	if _, err := conn.Exec(ctx, fmt.Sprintf("GRANT USAGE, CREATE ON SCHEMA public TO %s%s", role, option)); err != nil {
		return fmt.Errorf("%s's public schema: %w", g.Database, err)
	}
	return nil
}
