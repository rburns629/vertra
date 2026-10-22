// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, getGateway, setGatewayClosed, type GatewayInfo } from "../../api";
import { Pill } from "../../components/Pill";
import { when } from "../../time";

const mono = { fontFamily: "fontFamilyMono", fontSize: 13, overflowWrap: "anywhere" } as const;

/**
 * The API gateway: this install's settings (its Helm values, changed by an
 * upgrade, not here), how busy it is, and closing it: every API answers 503
 * with the message, and nothing is forwarded, until it's reopened. What it
 * refused is in Observe, beside what the cluster refused.
 */
export function GatewayTab() {
  const [gateway, setGateway] = useState<GatewayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getGateway()
      .then(setGateway)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the gateway."); });
  }, []);
  useEffect(load, [load]);

  async function toggle(): Promise<void> {
    if (!gateway) return;
    setBusy(true);
    setError(null);
    try {
      await setGatewayClosed(gateway.closedMessage ? "" : message);
      setMessage("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const refused = gateway?.refused.reduce((n, r) => n + r.count, 0) ?? 0;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 860 }}>
        One front door for every team&apos;s API products: it signs callers in, lets through only what each API&apos;s reviewed OpenAPI
        file describes, and forwards it to that API&apos;s backend, minting the backend&apos;s credential per request.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {gateway && !gateway.enabled && (
        <Alert severity="info">
          The gateway isn&apos;t running on this install: <Box component="span" sx={mono}>gateway.enabled</Box> in vertra.yaml.
        </Alert>
      )}
      {gateway?.enabled && (
        <>
          {gateway.closedMessage && (
            <Alert severity="warning">
              Closed by {gateway.closedBy || "an admin"}
              {gateway.closedAt ? ` ${when(gateway.closedAt)}` : ""}: every API answers 503 with “{gateway.closedMessage}”.
            </Alert>
          )}
          <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
            <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <Typography variant="h6" component="h2">
                  This install&apos;s settings
                </Typography>
                {gateway.closedMessage ? <Pill tone="warning">Closed</Pill> : <Pill tone="success">Open</Pill>}
              </Box>
              <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: { xs: "1fr", sm: "220px 1fr" }, columnGap: 2, rowGap: 1 }}>
                <Typography component="dt" variant="body2" color="text.secondary">
                  Backends may be under
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, ...mono }}>
                  {gateway.backendHosts.join(", ") || "nothing yet: every API is held"}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  May publish to the internet
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                  {gateway.internetTeams.join(", ") || "no team"}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  Inside the cluster
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, ...mono }}>
                  {gateway.url}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  From the internet
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, ...mono }}>
                  {gateway.publicUrl || "not published"}
                </Typography>
                <Typography component="dt" variant="body2" color="text.secondary">
                  Last 24 hours
                </Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                  {gateway.requests24h.toLocaleString()} requests to {String(gateway.apis)} {gateway.apis === 1 ? "API" : "APIs"}; {refused.toLocaleString()}{" "}
                  refused at the door.{" "}
                  <Link component={RouterLink} to="/observe">
                    See them in Observe
                  </Link>
                </Typography>
              </Box>
              <Typography variant="body2" color="text.secondary">
                These are the console chart&apos;s gateway values: an upgrade (<Box component="span" sx={mono}>vertra apply</Box>) changes them,
                not this page.
              </Typography>
            </Card>

            <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5, borderColor: gateway.closedMessage ? undefined : "error.light" }}>
              <Typography variant="h6" component="h2">
                {gateway.closedMessage ? "Reopen the gateway" : "Close the gateway"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Every API answers 503 until it&apos;s reopened, and nothing is forwarded. The console and runs carry on. Recorded in the
                audit log.
              </Typography>
              {!gateway.closedMessage && (
                <TextField
                  size="small"
                  fullWidth
                  label="Message to every caller"
                  value={message}
                  onChange={(e) => { setMessage(e.target.value); }}
                  slotProps={{ htmlInput: { maxLength: 500 } }}
                />
              )}
              <Box>
                <Button
                  variant="contained"
                  color={gateway.closedMessage ? "primary" : "error"}
                  disabled={busy || (!gateway.closedMessage && !message.trim())}
                  onClick={() => void toggle()}
                >
                  {gateway.closedMessage ? "Reopen" : "Close the gateway"}
                </Button>
              </Box>
            </Card>
          </Box>
        </>
      )}
    </Box>
  );
}
