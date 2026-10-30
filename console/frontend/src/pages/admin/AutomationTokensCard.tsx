// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { DEFAULT_TOKEN_DAYS, expiryText, TokenLifetime } from "../../components/TokenLifetime";
import { AUTOMATION_SCOPES, ApiError, createAutomationToken, listAutomationTokens, revokeToken, type AutomationToken } from "../../api";

/** Platform-wide tokens for automation: each holds
 * specific permissions instead of team membership, so it can't read
 * secrets, submit tasks, or mint other tokens. Team-scoped bots still live
 * on each team's page. */
export function AutomationTokensCard() {
  const [tokens, setTokens] = useState<AutomationToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(
    AUTOMATION_SCOPES.filter((s) => s.defaultOn).map((s) => s.scope),
  );
  const [days, setDays] = useState(DEFAULT_TOKEN_DAYS);
  const [submitting, setSubmitting] = useState(false);
  const [justIssued, setJustIssued] = useState<{ label: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<AutomationToken | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  function reload(): void {
    listAutomationTokens()
      .then(setTokens)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load automation tokens.");
      });
  }

  useEffect(reload, []);

  async function handleCreate(): Promise<void> {
    setError(null);
    setJustIssued(null);
    setSubmitting(true);
    try {
      const result = await createAutomationToken(label, scopes, days);
      setJustIssued({ label: result.label, token: result.token });
      setLabel("");
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(): Promise<void> {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await revokeToken(revoking.id);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Revoke failed.");
    } finally {
      setRevokeBusy(false);
      setRevoking(null);
    }
  }

  const columns: DataTableColumn<AutomationToken>[] = [
    { key: "label", header: "Label", render: (t) => <Box sx={{ fontWeight: 600 }}>{t.label}</Box> },
    {
      key: "scopes",
      header: "Can",
      render: (t) => (
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
          {t.scopes.map((scope) => (
            <Chip key={scope} label={scope} size="small" variant="outlined" />
          ))}
        </Box>
      ),
    },
    { key: "created", header: "Created", render: (t) => new Date(t.createdAt).toLocaleString() },
    { key: "expires", header: "Expiry", render: (t) => expiryText(t.expiresAt) },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (t) => (
        <Button size="small" color="error" onClick={() => { setRevoking(t); }}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Automation tokens
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          For platform automation of your own. A token can do only what's ticked below. It
          belongs to no team, so it can't read secrets, submit tasks, or create other tokens.
          The catalog needs none: this console reads the catalog's release itself (Admin,
          Catalog).
        </Typography>

        {justIssued && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Token for "{justIssued.label}": <code style={{ wordBreak: "break-all" }}>{justIssued.token}</code>
            <br />
            Copy it now; it won't be shown again. Store it as a secret wherever the automation
            runs.
          </Alert>
        )}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Box sx={{ mb: 2 }}>
          <DataTable columns={columns} rows={tokens} getRowKey={(t) => t.id} emptyMessage="No automation tokens yet." />
        </Box>

        <Stack spacing={1} sx={{ maxWidth: 480 }}>
          <TextField
            size="small"
            label="Label"
            placeholder="e.g. nightly report job"
            value={label}
            onChange={(event) => { setLabel(event.target.value); }}
          />
          {AUTOMATION_SCOPES.map(({ scope, description }) => (
            <FormControlLabel
              key={scope}
              control={
                <Checkbox
                  size="small"
                  checked={scopes.includes(scope)}
                  onChange={(event) => {
                    setScopes((current) =>
                      event.target.checked ? [...current, scope] : current.filter((s) => s !== scope),
                    );
                  }}
                />
              }
              label={
                <Typography variant="body2">
                  <code>{scope}</code> — {description}
                </Typography>
              }
            />
          ))}
          <TokenLifetime days={days} onChange={setDays} />
          <Box>
            <Button
              variant="contained"
              disabled={submitting || !label.trim() || scopes.length === 0}
              onClick={() => void handleCreate()}
            >
              {submitting ? "Creating…" : "Create token"}
            </Button>
          </Box>
        </Stack>
      </CardContent>
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke this token?"
        description={`"${revoking?.label ?? ""}" will stop working immediately. Any pipeline still using it will start failing to authenticate.`}
        confirmLabel="Revoke token"
        destructive
        busy={revokeBusy}
        onConfirm={() => void handleRevoke()}
        onCancel={() => { setRevoking(null); }}
      />
    </Card>
  );
}
