// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ApiError, adoptCatalogTeam, getCatalogStatus, syncCatalog, type CatalogStatus } from "../../api";

/**
 * The catalog this console registers from: its release in the registry,
 * which catalog CI pushes from main and this console reads every few
 * minutes, verifies and applies (teams, products, SecretStores). Sync now
 * reads and applies it at once.
 */
export function CatalogCard() {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [adopting, setAdopting] = useState<string | null>(null);

  useEffect(() => {
    getCatalogStatus()
      .then(setStatus)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load the catalog's status.");
      });
  }, []);

  async function sync(): Promise<void> {
    setError(null);
    setSyncing(true);
    try {
      setStatus(await syncCatalog());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSyncing(false);
    }
  }

  async function adopt(name: string): Promise<void> {
    setError(null);
    setSyncing(true);
    try {
      setStatus(await adoptCatalogTeam(name));
      setAdopting(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSyncing(false);
    }
  }

  const when = (at: string | null) => (at ? new Date(at).toLocaleString() : "never");

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Catalog
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Teams, products and SecretStores come from the catalog repository: its CI publishes a
          release from main, and this console reads it every few minutes, verifies it and applies
          it. Products, teams or stores a release no longer has are unregistered or retired here.
        </Typography>
        {status && !status.release && (
          <Alert severity="info">
            No catalog is configured (the console chart's <code>catalog.release</code>). Teams and
            products are only what admins make here.
          </Alert>
        )}
        {status?.release && (
          <Stack spacing={1}>
            <Typography variant="body2">
              <strong>Release:</strong> <code>{status.release}</code>
            </Typography>
            <Typography variant="body2">
              <strong>Applied:</strong>{" "}
              {status.commit ? (
                <>
                  commit <code>{/^[0-9a-f]{40}$/.test(status.commit) ? status.commit.slice(0, 12) : status.commit}</code>
                  {status.repository && <> of {status.repository}</>}, {when(status.appliedAt)}
                </>
              ) : (
                "nothing yet"
              )}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Last looked {when(status.checkedAt)}.
            </Typography>
            {status.error && <Alert severity="error">{status.error}</Alert>}
            {status.problems.length > 0 && (
              <Alert severity="warning">
                The last release was applied except:
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {status.problems.map((p) => (
                    <li key={p.item}>
                      <strong>{p.item}</strong>: {p.message}
                      {p.adoptableTeam && (
                        <Button size="small" sx={{ ml: 1 }} disabled={syncing} onClick={() => { setAdopting(p.adoptableTeam); }}>
                          Adopt
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            <Box>
              <Button variant="outlined" disabled={syncing} onClick={() => void sync()}>
                {syncing ? "Syncing…" : "Sync now"}
              </Button>
            </Box>
          </Stack>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </CardContent>
      <ConfirmDialog
        open={adopting !== null}
        title={`Let the catalog manage ${adopting ?? ""}?`}
        description="The catalog's folder of that name becomes this team: its releases will register products into it, apply its SecretStores, and retire it if the folder goes. Its members, secrets and history stay. Do this only if the folder is meant to be this team."
        confirmLabel="Adopt"
        busy={syncing}
        onConfirm={() => { if (adopting) void adopt(adopting); }}
        onCancel={() => { setAdopting(null); }}
      />
    </Card>
  );
}
