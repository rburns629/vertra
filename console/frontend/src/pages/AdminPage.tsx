// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TeamCard } from "../components/TeamCard";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Autocomplete from "@mui/material/Autocomplete";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import {
  ApiError,
  AUTOMATION_SCOPES,
  createAccount,
  createAutomationToken,
  deleteAccount,
  getImagePolicy,
  grantAdmin,
  listAllTeams,
  listAutomationTokens,
  listUsers,
  PASSWORD_MIN_LENGTH,
  resetUserPassword,
  revokeAdmin,
  revokeToken,
  updateImagePolicy,
  type AutomationToken,
  type ImagePolicy,
  type Team,
  type UserAccount,
} from "../api";

export function AdminPage() {
  return (
    <Box>
      <PageHeader title="Admin" subtitle="Platform-wide administration." />
      <Stack spacing={3}>
        <ImageSourcesCard />
        <AccountsCard />
        <AllTeamsCard />
        <AdminGrantCard />
        <ResetPasswordCard />
        <AutomationTokensCard />
      </Stack>
    </Box>
  );
}

/** A whole registry host (every project or user on it), not one path in
 * it. Same rule as ../../src/imagePolicy.ts's isBroadSource. */
function isBroadSource(entry: string): boolean {
  return entry.trim().replace(/^https?:\/\//, "").split("/").filter(Boolean).length <= 1;
}

/**
 * The image sources tasks may run from. The cluster enforces this exact
 * list when a task is dispatched (the execution-kernel chart's
 * image-policy.yaml), so a save here takes effect for every team at once.
 */
function ImageSourcesCard() {
  const [policy, setPolicy] = useState<ImagePolicy | null>(null);
  const [source, setSource] = useState("");
  const [additional, setAdditional] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingBroad, setConfirmingBroad] = useState(false);

  function load(): void {
    getImagePolicy()
      .then((loaded) => {
        setPolicy(loaded);
        setSource(loaded.source);
        setAdditional(loaded.additional);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load image sources.");
      });
  }

  useEffect(load, []);

  const entries = additional.map((entry) => entry.trim()).filter((entry) => entry !== "");
  const broad = [source, ...entries].filter((entry) => entry.trim() !== "" && isBroadSource(entry));

  async function save(): Promise<void> {
    if (!policy) return;
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const saved = await updateImagePolicy(source, entries, policy.version);
      setPolicy(saved);
      setSource(saved.source);
      setAdditional(saved.additional);
      setSuccess("Saved. The cluster enforces the new list for every task from now on.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
      setConfirmingBroad(false);
    }
  }

  const notConfigured = policy !== null && policy.exists && policy.allowed.length === 0;

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Image sources
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Tasks can only run images from these registry paths; the cluster refuses anything else,
          however it was submitted. The source registry is where catalog CI publishes product
          images. Base images a Dockerfile builds from (node, python, …) don't need to be listed:
          they're baked into the published image.
        </Typography>

        {policy && !policy.exists && (
          <Alert severity="error" sx={{ mb: 2 }}>
            The cluster's image policy doesn't exist, so no task can run. Installing or
            upgrading the execution-kernel release creates it.
          </Alert>
        )}
        {notConfigured && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            No image source is configured yet, so no task can run. Set the source registry below.
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 640 }}>
          <TextField
            label="Source registry"
            size="small"
            placeholder="us-central1-docker.pkg.dev/my-project/catalog-products"
            helperText="The registry path images are published to. Images under it are allowed."
            value={source}
            disabled={!policy?.exists}
            onChange={(event) => {
              setSource(event.target.value);
            }}
          />
          <Typography variant="caption" color="text.secondary">
            Additional allowed sources (optional), e.g. docker.io/library for official Docker Hub
            images.
          </Typography>
          {additional.map((entry, index) => (
            <Box key={index} sx={{ display: "flex", gap: 1 }}>
              <TextField
                size="small"
                fullWidth
                placeholder="docker.io/library"
                slotProps={{ htmlInput: { "aria-label": `Allowed source ${String(index + 1)}` } }}
                value={entry}
                disabled={!policy?.exists}
                onChange={(event) => {
                  const value = event.target.value;
                  setAdditional((current) => current.map((e, i) => (i === index ? value : e)));
                }}
              />
              <Button
                size="small"
                color="error"
                onClick={() => {
                  setAdditional((current) => current.filter((_, i) => i !== index));
                }}
              >
                Remove
              </Button>
            </Box>
          ))}
          <Button
            size="small"
            sx={{ alignSelf: "flex-start" }}
            disabled={!policy?.exists}
            onClick={() => {
              setAdditional((current) => [...current, ""]);
            }}
          >
            Add a source
          </Button>

          {broad.length > 0 && (
            <Alert severity="warning">
              {broad.join(", ")} {broad.length === 1 ? "allows" : "allow"} a whole registry: any
              image anyone has published there could run. Prefer a specific path.
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {success && <Alert severity="success">{success}</Alert>}
          <Box>
            <Button
              variant="contained"
              disabled={saving || !policy?.exists || source.trim() === ""}
              onClick={() => {
                if (broad.length > 0) setConfirmingBroad(true);
                else void save();
              }}
            >
              {saving ? "Saving…" : "Save image sources"}
            </Button>
          </Box>
        </Stack>
      </CardContent>
      <ConfirmDialog
        open={confirmingBroad}
        title="Allow a whole registry?"
        description={`${broad.join(", ")} would let tasks run any image published there by anyone, not just your own. Save anyway?`}
        confirmLabel="Save anyway"
        destructive
        busy={saving}
        onConfirm={() => void save()}
        onCancel={() => {
          setConfirmingBroad(false);
        }}
      />
    </Card>
  );
}

/**
 * Accounts are created here, not by self-registration (off unless the
 * console is configured otherwise): an admin makes one already in its
 * teams and gets a temporary password, shown once, to hand over.
 */
function AccountsCard() {
  const [accounts, setAccounts] = useState<UserAccount[] | null>(null);
  const [teamNames, setTeamNames] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [teams, setTeams] = useState<string[]>([]);
  const [admin, setAdmin] = useState(false);
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  function load(): void {
    listUsers()
      .then(setAccounts)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load accounts.");
      });
  }

  useEffect(() => {
    load();
    // Only teams someone can still join.
    listAllTeams()
      .then((all) => {
        setTeamNames(all.filter((t) => !t.retiredAt && !t.deletedAt).map((t) => t.name));
      })
      .catch(() => undefined);
  }, []);

  async function create(): Promise<void> {
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      setCreated(await createAccount(email.trim(), teams, admin));
      setEmail("");
      setTeams([]);
      setAdmin(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!deleting) return;
    setError(null);
    setBusy(true);
    try {
      await deleteAccount(deleting);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  }

  const columns: DataTableColumn<UserAccount>[] = [
    { key: "email", header: "Email", render: (u) => <Box sx={{ fontWeight: 600 }}>{u.email}</Box> },
    {
      key: "teams",
      header: "Teams",
      render: (u) =>
        u.teamNames.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            none
          </Typography>
        ) : (
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {u.teamNames.map((t) => (
              <Chip key={t} label={t} size="small" variant="outlined" />
            ))}
          </Box>
        ),
    },
    { key: "role", header: "Role", render: (u) => (u.isAdmin ? <Chip label="Admin" size="small" /> : "Member") },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (u) => (
        <Button
          size="small"
          color="error"
          onClick={() => {
            setDeleting(u.email);
          }}
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Accounts
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          People can't sign themselves up; create their account here, in the teams they work on.
          They get a temporary password to change after signing in. More teams can be added later
          on each team's page.
        </Typography>

        <Box sx={{ mb: 2 }}>
          <DataTable columns={columns} rows={accounts} getRowKey={(u) => u.email} emptyMessage="No accounts yet." />
        </Box>

        <Stack spacing={1.5} sx={{ maxWidth: 560 }}>
          <Typography variant="subtitle2">Create an account</Typography>
          <TextField
            size="small"
            type="email"
            label="Email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <Autocomplete
            multiple
            size="small"
            options={teamNames}
            value={teams}
            onChange={(_event, value) => {
              setTeams(value);
            }}
            renderInput={(params) => <TextField {...params} label="Teams" placeholder="Platforms they work on" />}
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={admin}
                onChange={(event) => {
                  setAdmin(event.target.checked);
                }}
              />
            }
            label="Acyclix admin (manages every team, accounts and image sources)"
          />
          <Box>
            <Button variant="contained" disabled={busy || !email.trim()} onClick={() => void create()}>
              {busy ? "Creating…" : "Create account"}
            </Button>
          </Box>
        </Stack>

        {created && (
          <Alert severity="success" sx={{ mt: 2 }}>
            Account created for <strong>{created.email}</strong>. Temporary password:{" "}
            <code>{created.temporaryPassword}</code>
            <br />
            Copy it now; it won't be shown again. Send it to them privately, and ask them to change it
            (account menu → Change password) after signing in.
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting ?? ""}?`}
        description="They lose access immediately: their team memberships and tokens are removed. Executions they submitted stay in the history, shown as from a deleted account. This can't be undone."
        confirmLabel="Delete account"
        confirmText={deleting ?? undefined}
        destructive
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => {
          setDeleting(null);
        }}
      />
    </Card>
  );
}

function AllTeamsCard() {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listAllTeams()
      .then(setTeams)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load teams.");
      });
  }, []);

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          All teams
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Visible because you're an admin -- a regular member only sees their own teams.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {teams && teams.length === 0 && <EmptyState message="No teams exist yet." />}
        {teams && teams.length > 0 && (
          <Grid container spacing={2}>
            {teams.map((team) => (
              <Grid key={team.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <TeamCard name={team.name} />
              </Grid>
            ))}
          </Grid>
        )}
      </CardContent>
    </Card>
  );
}

function AdminGrantCard() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"grant" | "revoke" | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  async function handle(action: "grant" | "revoke"): Promise<void> {
    setError(null);
    setSuccess(null);
    setSubmitting(action);
    try {
      if (action === "grant") {
        await grantAdmin(email);
        setSuccess(`${email} is now an admin.`);
      } else {
        await revokeAdmin(email);
        setSuccess(`${email} is no longer an admin.`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(null);
      setConfirmingRevoke(false);
    }
  }

  return (
    <Card variant="outlined" sx={{ maxWidth: 480 }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Manage admins
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Platform-wide, not scoped to a team. The last remaining admin can't be revoked.
        </Typography>
        <TextField
          size="small"
          type="email"
          label="Email"
          placeholder="teammate@example.com"
          fullWidth
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <Box sx={{ display: "flex", gap: 1, mt: 1.5 }}>
          <Button
            variant="contained"
            disabled={submitting !== null || !email}
            onClick={() => void handle("grant")}
          >
            {submitting === "grant" ? "Granting…" : "Grant admin"}
          </Button>
          <Button
            variant="outlined"
            color="error"
            disabled={submitting !== null || !email}
            onClick={() => { setConfirmingRevoke(true); }}
          >
            Revoke admin
          </Button>
        </Box>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mt: 2 }}>
            {success}
          </Alert>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmingRevoke}
        title="Revoke admin access?"
        description={`${email} will lose platform-admin access immediately. This can't be undone from here -- another admin would need to grant it back.`}
        confirmLabel="Revoke admin"
        destructive
        busy={submitting === "revoke"}
        onConfirm={() => void handle("revoke")}
        onCancel={() => { setConfirmingRevoke(false); }}
      />
    </Card>
  );
}

/** Platform-wide tokens for automation (catalog CI, mainly): each holds
 * specific permissions instead of team membership, so it can't read
 * secrets, submit tasks, or mint other tokens. Team-scoped bots still live
 * on each team's page. */
function AutomationTokensCard() {
  const [tokens, setTokens] = useState<AutomationToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(
    AUTOMATION_SCOPES.filter((s) => s.defaultOn).map((s) => s.scope),
  );
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
      const result = await createAutomationToken(label, scopes);
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
          For catalog CI and other platform automation. A token can do only what's ticked below.
          It belongs to no team, so it can't read secrets, submit tasks, or create other tokens.
          The catalog repo needs one token with the three pre-ticked permissions, stored as
          its <code>ACYCLIX_BOT_TOKEN</code> secret, and a separate token with only{" "}
          <code>teams:delete</code> for its purge workflow (<code>ACYCLIX_PURGE_TOKEN</code>, in
          the protected <code>purge</code> Environment).
        </Typography>

        {justIssued && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Token for "{justIssued.label}": <code style={{ wordBreak: "break-all" }}>{justIssued.token}</code>
            <br />
            Copy it now; it won't be shown again. Store it with <code>gh secret set</code> in
            the catalog repo (see the note above for which secret).
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
            placeholder="e.g. acyclix-catalog CI"
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

/** For a user who's forgotten their password -- there's no email-based
 * reset flow. The admin passes the temporary password on out of band and
 * the user changes it from their Account page. */
function ResetPasswordCard() {
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleReset(): Promise<void> {
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      await resetUserPassword(email, newPassword);
      setSuccess(`Password reset for ${email}. Their existing sessions have been signed out.`);
      setNewPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  return (
    <Card variant="outlined" sx={{ maxWidth: 480 }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Reset a user's password
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Sets a temporary password and signs the user out everywhere. Share it with them
          privately and ask them to change it from their Account page.
        </Typography>
        <Stack spacing={1.5}>
          <TextField
            size="small"
            type="email"
            label="Email"
            placeholder="teammate@example.com"
            fullWidth
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <TextField
            size="small"
            type="password"
            autoComplete="new-password"
            label="Temporary password"
            helperText={`At least ${String(PASSWORD_MIN_LENGTH)} characters`}
            fullWidth
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
            }}
          />
        </Stack>
        <Button
          variant="outlined"
          color="warning"
          sx={{ mt: 1.5 }}
          disabled={submitting || !email || newPassword.length < PASSWORD_MIN_LENGTH}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Reset password
        </Button>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mt: 2 }}>
            {success}
          </Alert>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirming}
        title="Reset this user's password?"
        description={`${email} will be signed out of every session immediately and will need the new password to sign back in.`}
        confirmLabel="Reset password"
        destructive
        busy={submitting}
        onConfirm={() => void handleReset()}
        onCancel={() => {
          setConfirming(false);
        }}
      />
    </Card>
  );
}
