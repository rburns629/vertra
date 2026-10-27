// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, getAdminChannel, listAllTeams, setAdminChannel, type Team } from "../../api";

/**
 * Where admins' alerts are posted in chat: one team's webhook (set on its
 * Settings tab) also gets them, when it asks for their kinds. Every
 * admin gets them in the console, and by email, either way.
 */
export function AdminChannelCard() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [chosen, setChosen] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listAllTeams(), getAdminChannel()])
      .then(([all, team]) => {
        setTeams(all.filter((t) => !t.retiredAt && !t.deletedAt));
        setChosen(team);
        setSaved(team);
      })
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the admins' channel."); });
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setSaved(await setAdminChannel(chosen));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="h6" component="h2">
        Admins&apos; alerts in chat
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Admins see alerts (a team purged, the image sources changed, a policy not syncing, a step the cluster refused) in the
        console and by email. Choose a team to post them to its chat webhook too: its maintainers set the webhook, and which
        alerts it gets, on its Settings tab.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
        <TextField select size="small" label="Team" value={chosen} onChange={(e) => { setChosen(e.target.value); }} sx={{ minWidth: 240 }}>
          <MenuItem value="">None</MenuItem>
          {teams.map((t) => (
            <MenuItem key={t.id} value={t.name}>
              {t.name}
            </MenuItem>
          ))}
        </TextField>
        <Button variant="contained" disabled={busy || chosen === saved} onClick={() => void save()}>
          Save
        </Button>
      </Box>
    </Card>
  );
}
