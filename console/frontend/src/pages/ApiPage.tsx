// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Mono } from "../components/Mono";
import { PageHeader } from "../components/PageHeader";
import { ApiError, getApi, pauseApi, resumeApi, type ApiEndpoint, type ApiProduct } from "../api";
import { useAuth } from "../auth/AuthContext";
import { API_STATE } from "./ApisPage";
import { ApiTraffic } from "./ApiTraffic";

const AUTH: Record<string, string> = {
  service_account_token: "a token for the API's own ServiceAccount, minted per request",
  google_id_token: "a Google ID token, minted per request",
  aws_sig_v4: "AWS SigV4, as a role it assumes per request",
  "": "none: it checks Vertra-Caller, or nothing",
};

function size(bytes: number): string {
  return bytes >= 1 << 20 ? `${String(bytes / (1 << 20))} MiB` : `${String(Math.round(bytes / 1024))} KiB`;
}

/** A path with its parameters filled with examples, for the sample call. */
function sample(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => `<${name}>`);
}

/**
 * One API product (ApiService.GetApi): what reaches its backend (its
 * spec's endpoints), how to call it through the gateway, the caller's
 * limits, and for its team's maintainers, pausing it.
 */
export function ApiPage() {
  const { team = "", name = "" } = useParams();
  const { user } = useAuth();
  const [api, setApi] = useState<ApiProduct | null>(null);
  const [openapi, setOpenapi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ApiEndpoint | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getApi(team, name)
      .then((result) => {
        setApi(result.api);
        setOpenapi(result.openapi);
        setSelected((s) => s ?? result.api.endpoints[0] ?? null);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load the API.");
      });
  }, [team, name]);

  useEffect(load, [load]);

  const maintains = !!user && (user.isAdmin || user.maintainerOf.includes(team));

  async function togglePause(): Promise<void> {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      if (api.state === "PAUSED") await resumeApi(team, name);
      else await pauseApi(team, name, message);
      setMessage("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  function download(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(JSON.parse(openapi), null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${team}-${name}-openapi.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const columns: DataTableColumn<ApiEndpoint>[] = [
    { key: "method", header: "Method", render: (e) => <Mono>{e.method}</Mono> },
    { key: "path", header: "Path", render: (e) => <Mono>{e.path}</Mono> },
    { key: "summary", header: "What it does", render: (e) => e.summary || "—", hideBelow: "sm" },
  ];

  const base = api?.publicUrl || api?.url || `<the gateway>/${team}/${name}`;
  const curl =
    selected &&
    [
      `curl -X ${selected.method} '${base}${sample(selected.path)}' \\`,
      `  -H "Authorization: Bearer $VERTRA_TOKEN"`,
      ...(["POST", "PUT", "PATCH"].includes(selected.method) ? [`  -H 'Content-Type: application/json' -d '{...}'`] : []),
    ].join("\n");

  return (
    <Box>
      <Link component={RouterLink} to="/apis" variant="body2">
        ← APIs
      </Link>
      {error && (
        <Alert severity="error" sx={{ my: 2 }}>
          {error}
        </Alert>
      )}
      {api && (
        <>
          <PageHeader
            title={
              <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
                <span>{api.displayName}</span>
                <Chip size="small" label={API_STATE[api.state].label} color={API_STATE[api.state].color} />
                <Chip size="small" variant="outlined" label={api.internet ? "Internet" : "In the cluster"} />
              </Stack>
            }
            subtitle={api.description}
          />
          {api.state === "PAUSED" && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Paused by its team: every request gets 503 with “{api.pausedMessage}”, and nothing reaches the backend.
            </Alert>
          )}
          {api.state === "HELD" && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Held: {api.heldReason}
            </Alert>
          )}
          {api.deprecated && (
            <Alert severity="info" sx={{ mb: 2 }}>
              Deprecated: {api.deprecated}
            </Alert>
          )}
          {!api.mayCall && (
            <Alert severity="info" sx={{ mb: 2 }}>
              It isn&apos;t shared with your teams: the gateway refuses your calls (403). Its team decides who may call it, in its api.yaml.
            </Alert>
          )}

          <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 2fr) minmax(0, 1fr)" }, alignItems: "start" }}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" component="h2">
                  Endpoints, from its OpenAPI file
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  The whole of what reaches the backend; anything else gets 404 from the gateway. Paths are relative to the address beside.
                </Typography>
                <DataTable columns={columns} rows={api.endpoints} getRowKey={(e) => `${e.method} ${e.path}`} onRowClick={setSelected} />
                {curl && (
                  <>
                    <Typography variant="subtitle2" sx={{ mt: 2 }}>
                      Calling {selected.method} {selected.path}
                    </Typography>
                    <Box component="pre" sx={{ p: 1.5, bgcolor: "action.hover", borderRadius: 1, overflowX: "auto", fontSize: 12, fontFamily: "fontFamilyMono" }}>
                      {curl}
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      Your Authorization header signs you in to the gateway and stops there. The backend gets your other headers and
                      who you are, in Vertra-Caller, signed by the gateway. Every answer says Vertra-Answered-By: gateway or backend.
                    </Typography>
                  </>
                )}
              </CardContent>
            </Card>

            <Stack spacing={2}>
              <Card variant="outlined">
                <CardContent>
                  <Stack spacing={1.25}>
                    <Fact label="Call it at" value={<Mono>{base}</Mono>} />
                    <Fact label="Spec" value={`${api.specTitle} ${api.specVersion} · ${String(api.endpoints.length)} endpoints`} />
                    <Fact label="Your team's limit" value={api.mayCall ? `${String(api.perMinute)} a minute · ${size(api.maxRequestBytes)} a request · ${String(api.timeoutSeconds)} s` : "—"} />
                    <Fact label="Shared with" value={api.shareWith.length > 0 ? api.shareWith.join(", ") : "its own team only"} />
                    <Fact label="Its file" value={<Mono>{api.sourcePath}</Mono>} />
                    {api.backendUrl && <Fact label="Backend (your team's)" value={<Mono>{api.backendUrl}</Mono>} />}
                    {api.backendUrl && <Fact label="It signs in there with" value={AUTH[api.backendAuth] ?? api.backendAuth} />}
                  </Stack>
                  <Button size="small" sx={{ mt: 1.5 }} onClick={download} disabled={!openapi}>
                    Download its OpenAPI file
                  </Button>
                </CardContent>
              </Card>

              {maintains && (
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="h6" component="h2">
                      {api.state === "PAUSED" ? "Resume it" : "Pause it"}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                      For an incident: every request gets 503 with your message until you resume it, and nothing reaches the backend.
                      Recorded in the audit log.
                    </Typography>
                    {api.state !== "PAUSED" && (
                      <TextField
                        size="small"
                        fullWidth
                        label="Message to callers"
                        value={message}
                        onChange={(e) => {
                          setMessage(e.target.value);
                        }}
                        slotProps={{ htmlInput: { maxLength: 500 } }}
                        sx={{ mb: 1.5 }}
                      />
                    )}
                    <Button
                      variant="contained"
                      color={api.state === "PAUSED" ? "primary" : "warning"}
                      disabled={busy || (api.state !== "PAUSED" && !message.trim())}
                      onClick={() => void togglePause()}
                    >
                      {api.state === "PAUSED" ? "Resume" : "Pause this API"}
                    </Button>
                  </CardContent>
                </Card>
              )}
            </Stack>
          </Box>
          {/* Its own team (and admins), who see its backend, see its traffic. */}
          {api.backendUrl && <ApiTraffic team={team} name={name} />}
        </>
      )}
    </Box>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ overflowWrap: "anywhere" }}>
        {value}
      </Typography>
    </Box>
  );
}
