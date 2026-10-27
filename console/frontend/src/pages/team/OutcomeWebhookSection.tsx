// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import { ApiError, getTeamCallback, setTeamCallback, type TeamCallback } from "../../api";
import { SignedCallback } from "../../components/SignedCallback";

/**
 * The team's outcome webhook: each of its runs' outcomes (its steps'
 * states and outputs) posted as signed JSON, for its own systems rather than
 * chat. Its maintainers set it; members see where it posts and how it went.
 */
export function OutcomeWebhookSection({ team, canManage, retired }: { team: string; canManage: boolean; retired: boolean }) {
  const [callback, setCallback] = useState<TeamCallback | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getTeamCallback(team)
      .then((found) => {
        setCallback(found.callback);
        setAllowed(found.allowedHosts);
      })
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the outcome webhook."); });
  }, [team]);
  useEffect(load, [load]);

  // An install that allows no hosts can't have one: say nothing unless one is set.
  if (callback && !callback.configured && allowed.length === 0) return null;
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="h6" component="h2">
        Outcome webhook
      </Typography>
      <Typography variant="body2" color="text.secondary">
        For the team&apos;s own systems: when one of its runs finishes, its outcome (each step&apos;s state and outputs) is posted
        here as signed JSON. Allowed hosts: {allowed.join(", ") || "none"}.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {callback && (
        <SignedCallback
          current={callback.configured ? callback : null}
          editable={canManage && !retired}
          none="None: nothing is posted."
          save={(url, rotate) => setTeamCallback(team, url, rotate)}
          onSaved={load}
        />
      )}
    </Card>
  );
}
