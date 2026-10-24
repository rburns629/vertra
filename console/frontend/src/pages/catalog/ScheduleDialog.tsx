// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, createSchedule, listBots, type Bot, type Runnable } from "../../api";

/** Common times, and the cron each is. */
export const PRESETS: { label: string; cron: string }[] = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 02:00", cron: "0 2 * * *" },
  { label: "Weekdays at 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
  { label: "The 1st of each month at 06:00", cron: "0 6 1 * *" },
];

/** A cron in words, when it's a preset; else the expression itself. */
export function describeCron(cron: string): string {
  return PRESETS.find((p) => p.cron === cron)?.label ?? cron;
}

/**
 * Scheduling a run: what the form has, on a cron, for one of the teams the
 * person maintains, as one of that team's bots. Opens the team's schedules
 * when it's made.
 */
export function ScheduleDialog({
  open,
  onClose,
  runnable,
  teams,
  parameters,
}: {
  open: boolean;
  onClose: () => void;
  runnable: Runnable;
  /** The teams it may be scheduled for: theirs to maintain, and it may run for. */
  teams: string[];
  /** The form's inputs, checked; null while they aren't. */
  parameters: () => Record<string, unknown> | null;
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(runnable.displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  const [team, setTeam] = useState(teams[0] ?? "");
  const [cron, setCron] = useState(PRESETS[1]?.cron ?? "0 2 * * *");
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [botId, setBotId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !team) return;
    setBots(null);
    listBots(team)
      .then((found) => {
        setBots(found);
        setBotId(found[0]?.id ?? "");
      })
      .catch(() => { setBots([]); });
  }, [open, team]);

  async function save(): Promise<void> {
    const values = parameters();
    if (!values) {
      setError("Fix the form's inputs first: the schedule runs with them.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createSchedule({ team, name, runnable, parameters: values, cron, timeZone, botId });
      navigate(`/teams/${encodeURIComponent(team)}?tab=schedules`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't make the schedule.");
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Schedule {runnable.displayName}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: "8px !important" }}>
        <Typography variant="body2" color="text.secondary">
          It runs with the inputs in the form, for the team, as one of its bots, which must be allowed to run it each time.
        </Typography>
        <TextField label="Name" value={name} onChange={(e) => { setName(e.target.value); }} size="small" />
        <TextField select label="For team" value={team} onChange={(e) => { setTeam(e.target.value); }} size="small">
          {teams.map((t) => (
            <MenuItem key={t} value={t}>
              {t}
            </MenuItem>
          ))}
        </TextField>
        <TextField select label="When" value={PRESETS.some((p) => p.cron === cron) ? cron : "custom"} onChange={(e) => { if (e.target.value !== "custom") setCron(e.target.value); }} size="small">
          {PRESETS.map((p) => (
            <MenuItem key={p.cron} value={p.cron}>
              {p.label}
            </MenuItem>
          ))}
          <MenuItem value="custom">Another time (cron)</MenuItem>
        </TextField>
        <TextField
          label="Cron"
          value={cron}
          onChange={(e) => { setCron(e.target.value); }}
          size="small"
          helperText="Minute, hour, day of the month, month, day of the week. At most every five minutes."
          slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }}
        />
        <TextField label="Time zone" value={timeZone} onChange={(e) => { setTimeZone(e.target.value); }} size="small" helperText="Such as Europe/Berlin, or UTC." />
        {bots && bots.length === 0 ? (
          <Alert severity="info">
            {team} has no bot to run it as.{" "}
            <Link component={RouterLink} to={`/teams/${encodeURIComponent(team)}?tab=automation`}>
              Add one on its Automation tab
            </Link>
            .
          </Alert>
        ) : (
          <TextField select label="Runs as" value={botId} onChange={(e) => { setBotId(e.target.value); }} size="small" disabled={!bots}>
            {(bots ?? []).map((b) => (
              <MenuItem key={b.id} value={b.id}>
                {b.email}
              </MenuItem>
            ))}
          </TextField>
        )}
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={saving || !botId || !name.trim()} onClick={() => void save()}>
          {saving ? "Saving…" : "Schedule it"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
