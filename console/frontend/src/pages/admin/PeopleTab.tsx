// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import MoreIcon from "@mui/icons-material/MoreHoriz";
import {
  ApiError,
  createAccount,
  deleteAccount,
  grantAdmin,
  listAllTeams,
  listUsers,
  PASSWORD_MIN_LENGTH,
  resetUserPassword,
  revokeAdmin,
  type Team,
  type UserAccount,
} from "../../api";
import { useAuth } from "../../auth/AuthContext";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Pill } from "../../components/Pill";
import { useEnvironment } from "../../environment";
import { when } from "../../time";

const mono = { fontFamily: "fontFamilyMono", fontSize: 13 } as const;

function signsInWith(u: UserAccount, sso: string): string {
  if (u.usesSso && u.hasPassword) return `${sso || "Single sign-on"} and a password`;
  if (u.usesSso) return sso || "Single sign-on";
  if (u.hasPassword) return "Password";
  return "—";
}

/** How people sign in here: set by the installer, so this only says how. */
function SigningIn({ teams }: { teams: Team[] }) {
  const sso = useEnvironment()?.ssoLabel ?? "";
  const requiring = teams.filter((t) => t.requireSso && !t.retiredAt).map((t) => t.name);
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Typography variant="h6" component="h2">
          Signing in
        </Typography>
        {sso ? <Pill tone="success">{sso} on</Pill> : <Pill tone="neutral">Passwords only</Pill>}
      </Box>
      {sso ? (
        <Typography variant="body2">
          People sign in with {sso}; someone signing in for the first time gets an account with no team. Passwords are allowed
          except for members of a team that requires {sso}
          {requiring.length > 0 ? ` (${requiring.join(", ")})` : ""}; admins can always use theirs, in case {sso} can&apos;t be reached.
          Each team&apos;s Settings tab sets that.
        </Typography>
      ) : (
        <Typography variant="body2">Everyone signs in with a password: an admin adds them below.</Typography>
      )}
      <Typography variant="body2" sx={{ p: 1.5, bgcolor: "background.default", borderRadius: 2, color: "text.secondary" }}>
        Set by the installer, not here: <Box component="span" sx={mono}>vertra sso google</Box> to set it up or change its domains,{" "}
        <Box component="span" sx={mono}>vertra sso off</Box> to stop.
      </Typography>
    </Card>
  );
}

function AddPerson({ teams, onAdded }: { teams: Team[]; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [admin, setAdmin] = useState(false);
  const [created, setCreated] = useState<{ email: string; temporaryPassword: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only teams someone can still join.
  const joinable = teams.filter((t) => !t.retiredAt && !t.deletedAt).map((t) => t.name);

  async function add(): Promise<void> {
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      setCreated(await createAccount(email.trim(), chosen, admin));
      setEmail("");
      setChosen([]);
      setAdmin(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add them.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="h6" component="h2">
        Add a person
      </Typography>
      <TextField size="small" type="email" label="Email" value={email} onChange={(e) => { setEmail(e.target.value); }} />
      <Autocomplete
        multiple
        size="small"
        options={joinable}
        value={chosen}
        onChange={(_e, value) => { setChosen(value); }}
        renderInput={(params) => <TextField {...params} label="Teams" placeholder="The teams they work on" />}
      />
      <FormControlLabel control={<Checkbox checked={admin} onChange={(e) => { setAdmin(e.target.checked); }} />} label="Admin of this install" />
      <Typography variant="body2" color="text.secondary">
        With single sign-on on, they sign in with it as this email. Otherwise (and always for an admin) they get a temporary
        password, shown once, which they replace when they first sign in.
      </Typography>
      <Box>
        <Button variant="contained" disabled={busy || !email.trim()} onClick={() => void add()}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </Box>
      {created?.temporaryPassword === "" && (
        <Alert severity="success">
          Added <strong>{created.email}</strong>. They sign in with single sign-on as that email.
        </Alert>
      )}
      {created && created.temporaryPassword !== "" && (
        <Alert severity="success">
          Added <strong>{created.email}</strong>. Temporary password: <Box component="code" sx={mono}>{created.temporaryPassword}</Box>
          <br />
          Copy it now; it isn&apos;t shown again. Send it to them privately: they choose their own when they first sign in.
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Card>
  );
}

/** A new password an admin sets for someone, who must replace it when they next sign in. */
function ResetPasswordDialog({ email, onClose }: { email: string; onClose: (done: string | null) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reset(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await resetUserPassword(email, password);
      onClose(`${email}'s password is reset and their sessions signed out. They choose their own when they next sign in.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reset it.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={() => { onClose(null); }} maxWidth="xs" fullWidth>
      <DialogTitle>Reset {email}&apos;s password</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Signs them out everywhere. Send them the temporary password privately; they replace it when they next sign in.
        </Typography>
        <TextField
          type="password"
          autoComplete="new-password"
          label="Temporary password"
          helperText={`At least ${String(PASSWORD_MIN_LENGTH)} characters.`}
          value={password}
          onChange={(e) => { setPassword(e.target.value); }}
        />
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { onClose(null); }}>Cancel</Button>
        <Button variant="contained" color="warning" disabled={busy || password.length < PASSWORD_MIN_LENGTH} onClick={() => void reset()}>
          Reset password
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type Pending = { kind: "delete" | "revoke"; email: string } | { kind: "reset"; email: string };

/**
 * Who can sign in, and how: how sign-in works here, adding a person, and
 * everyone with their teams, how they sign in and when they last did. What
 * each may do comes from their teams; each team's maintainers set roles.
 */
export function PeopleTab() {
  const { user } = useAuth();
  const sso = useEnvironment()?.ssoLabel ?? "";
  const [people, setPeople] = useState<UserAccount[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; person: UserAccount } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listUsers()
      .then(setPeople)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the people."); });
  }, []);

  useEffect(() => {
    load();
    listAllTeams().then(setTeams).catch(() => undefined);
  }, [load]);

  async function act(action: () => Promise<void>, done: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      setNotice(done);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const query = search.trim().toLowerCase();
  const shown = useMemo(
    () => (people && query ? people.filter((p) => [p.email, ...p.teamNames].some((s) => s.toLowerCase().includes(query))) : people),
    [people, query],
  );

  const columns: DataTableColumn<UserAccount>[] = [
    {
      key: "person",
      header: "Person",
      render: (p) => (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, alignItems: "flex-start" }}>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {p.email}
            {p.email === user?.email && " (you)"}
          </Typography>
          {p.mustChangePassword && <Pill tone="warning">Hasn&apos;t chosen a password yet</Pill>}
          {p.teamNames.length === 0 && !p.isAdmin && <Pill tone="info">No team yet</Pill>}
        </Box>
      ),
    },
    { key: "signin", header: "Signs in with", render: (p) => signsInWith(p, sso), hideBelow: "sm" },
    { key: "teams", header: "Teams", render: (p) => p.teamNames.join(", ") || "—", hideBelow: "sm" },
    { key: "admin", header: "Admin", render: (p) => (p.isAdmin ? <Pill tone="info">Admin</Pill> : null) },
    { key: "last", header: "Last signed in", render: (p) => (p.lastSignedInAt ? when(p.lastSignedInAt) : "Never"), hideBelow: "md" },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (p) => (
        <IconButton aria-label={`Actions for ${p.email}`} onClick={(e) => { e.stopPropagation(); setMenu({ anchor: e.currentTarget, person: p }); }}>
          <MoreIcon />
        </IconButton>
      ),
    },
  ];

  const person = menu?.person;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, alignItems: "start" }}>
        <SigningIn teams={teams} />
        <AddPerson teams={teams} onAdded={load} />
      </Box>

      <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1.5 }}>
          <Typography variant="h6" component="h2">
            People
          </Typography>
          <TextField
            size="small"
            placeholder="Find a person or team"
            value={search}
            onChange={(e) => { setSearch(e.target.value); }}
            slotProps={{ htmlInput: { "aria-label": "Find a person or team" } }}
            sx={{ width: { xs: "100%", sm: 280 } }}
          />
        </Box>
        {notice && (
          <Alert severity="success" onClose={() => { setNotice(null); }}>
            {notice}
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        <DataTable columns={columns} rows={shown} getRowKey={(p) => p.email} emptyMessage={query ? "Nobody matches." : "No accounts yet."} />
      </Card>

      <Menu anchorEl={menu?.anchor} open={menu !== null} onClose={() => { setMenu(null); }}>
        {person && (
          <MenuItem
            onClick={() => {
              setMenu(null);
              if (person.isAdmin) setPending({ kind: "revoke", email: person.email });
              else void act(() => grantAdmin(person.email), `${person.email} is now an admin.`);
            }}
          >
            {person.isAdmin ? "Remove admin…" : "Make admin"}
          </MenuItem>
        )}
        {person?.hasPassword && (
          <MenuItem onClick={() => { setMenu(null); setPending({ kind: "reset", email: person.email }); }}>Reset password…</MenuItem>
        )}
        {person && person.email !== user?.email && (
          <MenuItem sx={{ color: "error.main" }} onClick={() => { setMenu(null); setPending({ kind: "delete", email: person.email }); }}>
            Delete…
          </MenuItem>
        )}
      </Menu>

      <ConfirmDialog
        open={pending?.kind === "revoke"}
        title={`Remove ${pending?.email ?? ""} as an admin?`}
        description="They lose admin access at once; their teams stay. The last admin can't be removed."
        confirmLabel="Remove admin"
        destructive
        busy={busy}
        onConfirm={() => { if (pending) void act(() => revokeAdmin(pending.email), `${pending.email} is no longer an admin.`); }}
        onCancel={() => { setPending(null); }}
      />
      <ConfirmDialog
        open={pending?.kind === "delete"}
        title={`Delete ${pending?.email ?? ""}?`}
        description="They lose access at once: their team memberships and tokens are removed. Runs they started stay in the history, shown as from a deleted account. This can't be undone."
        confirmLabel="Delete account"
        confirmText={pending?.kind === "delete" ? pending.email : undefined}
        destructive
        busy={busy}
        onConfirm={() => { if (pending) void act(() => deleteAccount(pending.email), `${pending.email} is deleted.`); }}
        onCancel={() => { setPending(null); }}
      />
      {pending?.kind === "reset" && (
        <ResetPasswordDialog
          email={pending.email}
          onClose={(done) => {
            setPending(null);
            if (done) {
              setNotice(done);
              load();
            }
          }}
        />
      )}
    </Box>
  );
}
