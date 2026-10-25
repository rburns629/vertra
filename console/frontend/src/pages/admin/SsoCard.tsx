// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import {
  ApiError,
  deleteSsoGroupMapping,
  getSsoSettings,
  listAllTeams,
  listSsoGroupMappings,
  setSsoGroupMapping,
  setSsoSettings,
  type SsoGroupMapping,
  type SsoSettings,
} from "../../api";
import { Mono } from "../../components/Mono";

const message = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Which group makes whom a member of which team: listed, added, removed. */
function GroupMappings({ teams }: { teams: string[] }) {
  const [mappings, setMappings] = useState<SsoGroupMapping[] | null>(null);
  const [group, setGroup] = useState("");
  const [team, setTeam] = useState<string | null>(null);
  const [role, setRole] = useState<"member" | "maintainer">("member");
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    listSsoGroupMappings()
      .then(setMappings)
      .catch((err: unknown) => { setError(message(err, "Couldn't load the mappings.")); });
  };
  useEffect(load, []);

  async function add(): Promise<void> {
    if (!team) return;
    setError(null);
    try {
      await setSsoGroupMapping(group.trim(), team, role);
      setGroup("");
      load();
    } catch (err) {
      setError(message(err, "Couldn't map it."));
    }
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Typography variant="subtitle2">Groups mapped to teams</Typography>
      <Typography variant="body2" color="text.secondary">
        At each sign-in, a mapped team&apos;s membership follows the person&apos;s groups: added with the best role their groups give,
        or removed. Teams nothing maps to are managed by hand, as are bots and people who sign in with a password.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {mappings?.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          None yet.
        </Typography>
      )}
      {mappings?.map((m) => (
        <Box key={m.id} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.5, borderTop: 1, borderColor: "divider", flexWrap: "wrap" }}>
          <Mono sx={{ flex: "1 1 200px", overflowWrap: "anywhere" }}>{m.group}</Mono>
          <Typography variant="body2" sx={{ flex: "1 1 160px" }}>
            {m.team} · {m.role}
          </Typography>
          <IconButton
            size="small"
            aria-label={`Unmap ${m.group} from ${m.team}`}
            onClick={() => {
              deleteSsoGroupMapping(m.id)
                .then(load)
                .catch((err: unknown) => { setError(message(err, "Couldn't unmap it.")); });
            }}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Box>
      ))}
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr", md: "2fr 2fr 1fr auto" }, alignItems: "center", mt: 1 }}>
        <TextField size="small" label="Group" value={group} onChange={(e) => { setGroup(e.target.value); }} helperText="As the provider sends it, or a Google group's email" />
        <Autocomplete options={teams} value={team} onChange={(_e, value) => { setTeam(value); }} renderInput={(params) => <TextField {...params} size="small" label="Team" helperText=" " />} />
        <TextField select size="small" label="Role" value={role} onChange={(e) => { setRole(e.target.value as "member" | "maintainer"); }} helperText=" ">
          <MenuItem value="member">member</MenuItem>
          <MenuItem value="maintainer">maintainer</MenuItem>
        </TextField>
        <Button variant="outlined" disabled={!group.trim() || !team} onClick={() => void add()} sx={{ mb: 2.75 }}>
          Map
        </Button>
      </Box>
    </Box>
  );
}

/**
 * Single sign-on, for admins: optional (passwords keep working), with the
 * provider set here unless the install set it, where people's groups come
 * from, and which groups make whom a member of which team.
 */
export function SsoCard() {
  const [saved, setSaved] = useState<SsoSettings | null>(null);
  const [form, setForm] = useState<SsoSettings | null>(null);
  const [secret, setSecret] = useState("");
  const [domains, setDomains] = useState("");
  const [teams, setTeams] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const show = (s: SsoSettings) => {
    setSaved(s);
    setForm(s);
    setDomains(s.allowedDomains.join(", "));
    setSecret("");
  };
  useEffect(() => {
    getSsoSettings()
      .then(show)
      .catch((err: unknown) => { setError(message(err, "Couldn't load the single sign-on settings.")); });
    listAllTeams()
      .then((all) => { setTeams(all.map((t) => t.name)); })
      .catch(() => undefined);
  }, []);

  if (!form || !saved) {
    return (
      <Card sx={{ p: 3 }}>
        <Typography variant="h6" component="h2">
          Single sign-on
        </Typography>
        {error ? <Alert severity="error">{error}</Alert> : <Typography color="text.secondary">Loading…</Typography>}
      </Card>
    );
  }

  const set = (change: Partial<SsoSettings>) => { setForm({ ...form, ...change }); };
  const locked = form.setByInstall;
  const turningOff = saved.enabled && !form.enabled;

  async function save(): Promise<void> {
    if (!form) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const provider = locked
        ? { issuer: "", clientId: "", clientSecret: "", redirectUrl: "", allowedDomains: [], label: "" }
        : { issuer: form.issuer.trim(), clientId: form.clientId.trim(), clientSecret: secret, redirectUrl: form.redirectUrl.trim(), allowedDomains: domains.split(/[\s,]+/).filter(Boolean), label: form.label.trim() };
      show(await setSsoSettings({ ...provider, enabled: form.enabled, groupsClaim: form.groupsClaim.trim(), googleGroups: form.googleGroups }));
      setNote("Saved: every console uses it within seconds.");
    } catch (err) {
      setError(message(err, "Couldn't save it."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box>
        <Typography variant="h6" component="h2">
          Single sign-on
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Optional: people may sign in with your OpenID Connect provider (Google, Entra ID, Okta, Keycloak…), and passwords keep
          working, except for teams that require single sign-on.
        </Typography>
      </Box>
      {locked ? (
        <Alert severity="info">
          This install sets its provider ({form.label}, {form.issuer}, for {form.allowedDomains.join(", ")}): change it with{" "}
          <Mono>vertra sso</Mono> and <Mono>vertra apply</Mono>. Groups are set here.
        </Alert>
      ) : (
        <>
          <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => { set({ enabled: e.target.checked }); }} />} label="People may sign in with single sign-on" />
          <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
            <TextField size="small" label="Button's name" value={form.label} onChange={(e) => { set({ label: e.target.value }); }} helperText="Such as Google or Okta" />
            <TextField size="small" label="Issuer" value={form.issuer} onChange={(e) => { set({ issuer: e.target.value }); }} helperText="Such as https://accounts.google.com" />
            <TextField size="small" label="Client ID" value={form.clientId} onChange={(e) => { set({ clientId: e.target.value }); }} />
            <TextField
              size="small"
              type="password"
              label="Client secret"
              value={secret}
              onChange={(e) => { setSecret(e.target.value); }}
              helperText={saved.clientSecretSet ? "One is kept (encrypted, never shown): type to replace it" : "Kept encrypted, never shown again"}
              autoComplete="new-password"
            />
            <TextField size="small" label="Redirect URL" value={form.redirectUrl} onChange={(e) => { set({ redirectUrl: e.target.value }); }} helperText="Register exactly this with the provider" />
            <TextField size="small" label="Email domains allowed" value={domains} onChange={(e) => { setDomains(e.target.value); }} helperText="Comma-separated, such as example.com" />
          </Box>
          {turningOff && (
            <Alert severity="warning">
              Turned off, people who sign in only with single sign-on (no password) can&apos;t sign in until it&apos;s back on. Teams that
              require it accept passwords again meanwhile.
            </Alert>
          )}
        </>
      )}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        <Typography variant="subtitle2">Where groups come from</Typography>
        <TextField
          size="small"
          label="Groups claim"
          value={form.groupsClaim}
          onChange={(e) => { set({ groupsClaim: e.target.value }); }}
          placeholder="groups"
          helperText="The ID token claim listing a person's groups (Entra ID, Okta, Keycloak: usually groups); empty: none"
          sx={{ maxWidth: 480 }}
        />
        <FormControlLabel
          control={<Checkbox checked={form.googleGroups} onChange={(e) => { set({ googleGroups: e.target.checked }); }} />}
          label="Google Workspace groups too"
        />
        {form.googleGroups && (
          <Typography variant="caption" color="text.secondary">
            Read with Cloud Identity&apos;s Groups API as this console&apos;s own Google identity (GKE Workload Identity), which needs
            the Groups Reader admin role in your Workspace. A sign-in whose groups can&apos;t be read is refused, never counted as no groups.
          </Typography>
        )}
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {note && <Alert severity="success">{note}</Alert>}
      <Box>
        <Button variant="contained" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </Box>
      <GroupMappings teams={teams} />
    </Card>
  );
}
