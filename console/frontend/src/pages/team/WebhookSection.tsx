// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, deleteTeamWebhook, getTeamWebhook, setTeamWebhook, testTeamWebhook, type TeamWebhook } from "../../api";
import { when } from "../../time";

const KINDS = [
  { kind: "run_failed", label: "A run for the team failed" },
  { kind: "approval_waiting", label: "A step waits for the team's approval" },
  { kind: "product_not_ready", label: "A product of the team isn't ready on this install" },
] as const;

/**
 * The team's chat webhook (Slack, Google Chat, Teams): where its
 * notifications are posted. Its maintainers set, test and remove it; the URL
 * is never shown again once saved, only its host. Members see whether it's
 * set and working.
 */
export function WebhookSection({ team, canManage, retired }: { team: string; canManage: boolean; retired: boolean }) {
  const [webhook, setWebhook] = useState<TeamWebhook | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [kinds, setKinds] = useState<string[]>(KINDS.map((k) => k.kind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    getTeamWebhook(team)
      .then(({ webhook: found, allowedHosts }) => {
        setWebhook(found);
        setAllowed(allowedHosts);
        if (found.configured) setKinds(found.kinds);
      })
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the webhook."); });
  }, [team]);

  async function act(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    act(async () => {
      setWebhook(await setTeamWebhook(team, url.trim(), kinds));
      setUrl("");
      setNotice("Saved.");
    });
  const test = () =>
    act(async () => {
      const result = await testTeamWebhook(team);
      if (result.sent) setNotice("Sent a test message.");
      else setError(`It didn't go: ${result.error}`);
      setWebhook((await getTeamWebhook(team)).webhook);
    });
  const remove = () =>
    act(async () => {
      await deleteTeamWebhook(team);
      setWebhook({ configured: false, host: "", kinds: [], lastSentAt: null, lastError: null });
    });

  const editable = canManage && !retired;
  const toggle = (kind: string, on: boolean) => { setKinds((current) => (on ? [...current, kind] : current.filter((k) => k !== kind))); };

  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="h6" component="h2">
        Chat notifications
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Posts the team&apos;s notifications to a Slack, Google Chat or Teams channel through its incoming webhook. Everyone also
        sees their own in the console (the bell).
      </Typography>
      {webhook?.configured ? (
        <Typography variant="body2">
          Posting to <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 13 }}>{webhook.host}</Box>
          {webhook.lastSentAt ? `, last ${when(webhook.lastSentAt)}` : ", nothing sent yet"}.
        </Typography>
      ) : (
        webhook && <Typography variant="body2">No webhook: nothing is posted.</Typography>
      )}
      {webhook?.lastError && <Alert severity="warning">The last post didn&apos;t go: {webhook.lastError}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      {editable && webhook && (
        <>
          <TextField
            label={webhook.configured ? "A new webhook URL (optional)" : "Webhook URL"}
            type="password"
            autoComplete="off"
            value={url}
            onChange={(e) => { setUrl(e.target.value); }}
            helperText={`It's kept encrypted and never shown again. Allowed hosts: ${allowed.join(", ")}.`}
            size="small"
          />
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            {KINDS.map(({ kind, label }) => (
              <FormControlLabel key={kind} control={<Checkbox checked={kinds.includes(kind)} onChange={(e) => { toggle(kind, e.target.checked); }} />} label={label} />
            ))}
          </Box>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button variant="contained" disabled={busy || (!webhook.configured && !url.trim())} onClick={() => void save()}>
              Save
            </Button>
            {webhook.configured && (
              <>
                <Button disabled={busy} onClick={() => void test()}>
                  Send a test
                </Button>
                <Button color="error" disabled={busy} onClick={() => void remove()}>
                  Remove
                </Button>
              </>
            )}
          </Box>
        </>
      )}
    </Card>
  );
}
