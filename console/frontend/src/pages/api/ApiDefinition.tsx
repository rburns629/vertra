// SPDX-License-Identifier: MIT
import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { ApiProduct } from "../../api";
import { Mono } from "../../components/Mono";
import { Fact } from "./ApiOverview";

const AUTH: Record<string, string> = {
  service_account_token: "a token for the API's own ServiceAccount, minted per request",
  google_id_token: "a Google ID token, minted per request",
  aws_sig_v4: "AWS SigV4, as a role it assumes per request",
  "": "nothing: it checks Vertra-Caller, or nothing",
};

/** What the gateway does with each request, in order. */
const STEPS: [string, string][] = [
  ["Who is calling", "A person's session or a bot's token; Google sign-in when the caller's team requires it."],
  ["Shared with them?", "Its shareWith covers the caller's team; else 403."],
  ["In the spec?", "The method and path are an operation in its OpenAPI file; else 404, blocked."],
  ["Does it fit?", "Parameters, headers and body against that operation's schemas; else 400."],
  ["Within limits", "The calling team's requests a minute and the size limit; else 429 or 413."],
  ["Forward", "Same method, path, query, headers and body; the caller's Authorization swapped for the backend's, Vertra-Caller added."],
  ["Answer", "The backend's response, passed back unchanged."],
];

/**
 * What the catalog says an API is (its api.yaml: backend, how the gateway
 * signs in there, who it's shared with, where it's reachable), what the
 * gateway does with each request, and pausing it. For its own team.
 */
export function ApiDefinition({
  api,
  canPause,
  busy,
  onPause,
  onResume,
}: {
  api: ApiProduct;
  canPause: boolean;
  busy: boolean;
  onPause: (message: string) => Promise<void>;
  onResume: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const paused = api.state === "PAUSED";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
        <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="h6" component="h2">
            As the catalog says
          </Typography>
          <Fact label="Its file">
            <Mono>{api.sourcePath}</Mono>
          </Fact>
          <Fact label="Backend">
            <Mono>{api.backendUrl}</Mono>
          </Fact>
          <Fact label="The gateway signs in there with">{AUTH[api.backendAuth] ?? api.backendAuth}</Fact>
          <Fact label="Reachable">{api.internet ? "From the internet, and in the cluster" : "In the cluster only"}</Fact>
          <Fact label="Shared with">{api.shareWith.length > 0 ? api.shareWith.join(", ") : "its own team only"}</Fact>
          <Typography variant="body2" color="text.secondary">
            It changes in the catalog, reviewed like any product: propose a change to its file there. Pausing it is the only thing
            changed here.
          </Typography>
        </Card>

        {canPause && (
          <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5, borderColor: paused ? undefined : "warning.light" }}>
            <Typography variant="h6" component="h2">
              {paused ? "Resume it" : "Pause it"}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              For an incident: every request gets 503 with your message until you resume it, and nothing reaches the backend.
              Recorded in the audit log.
            </Typography>
            {!paused && (
              <TextField
                size="small"
                fullWidth
                label="Message to callers"
                placeholder="Database failover; back by 15:00 UTC"
                value={message}
                onChange={(e) => { setMessage(e.target.value); }}
                slotProps={{ htmlInput: { maxLength: 500 } }}
              />
            )}
            <Box>
              <Button
                variant="contained"
                color={paused ? "primary" : "warning"}
                disabled={busy || (!paused && !message.trim())}
                onClick={() => void (paused ? onResume() : onPause(message).then(() => { setMessage(""); }))}
              >
                {paused ? "Resume" : "Pause this API"}
              </Button>
            </Box>
          </Card>
        )}
      </Box>

      <Card sx={{ p: 3 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>
          What happens to a request
        </Typography>
        <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 1.25, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          {STEPS.map(([title, text], i) => (
            <Box
              component="li"
              key={title}
              sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: i === 2 ? "warning.light" : "divider", bgcolor: i === 2 ? "warning.light" : "background.default", display: "flex", flexDirection: "column", gap: 0.5 }}
            >
              <Typography variant="caption" sx={{ fontFamily: "fontFamilyMono", color: "text.secondary" }}>
                {i + 1}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {title}
              </Typography>
              <Typography variant="caption" sx={{ color: "text.secondary", lineHeight: 1.45 }}>
                {text}
              </Typography>
            </Box>
          ))}
        </Box>
      </Card>
    </Box>
  );
}
