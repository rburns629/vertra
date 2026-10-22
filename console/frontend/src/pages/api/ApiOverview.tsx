// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import type { ApiEndpoint, ApiProduct } from "../../api";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { Mono } from "../../components/Mono";

export function size(bytes: number): string {
  return bytes >= 1 << 20 ? `${String(bytes / (1 << 20))} MiB` : `${String(Math.round(bytes / 1024))} KiB`;
}

/** A path with its parameters as placeholders, for the sample call. */
function sample(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_, name: string) => `<${name}>`);
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </Box>
  );
}

const COLUMNS: DataTableColumn<ApiEndpoint>[] = [
  { key: "method", header: "Method", render: (e) => <Mono>{e.method}</Mono> },
  { key: "path", header: "Path", render: (e) => <Mono>{e.path}</Mono> },
  { key: "summary", header: "What it does", render: (e) => e.summary || "—", hideBelow: "sm" },
];

/** What anyone who may see an API needs to call it: its endpoints, how, and their limits. */
export function ApiOverview({ api, openapi }: { api: ApiProduct; openapi: string }) {
  const [selected, setSelected] = useState<ApiEndpoint | null>(api.endpoints[0] ?? null);
  const base = api.publicUrl || api.url || `<the gateway>/${api.team}/${api.name}`;
  const curl =
    selected &&
    [
      `curl -X ${selected.method} '${base}${sample(selected.path)}' \\`,
      `  -H "Authorization: Bearer $VERTRA_TOKEN"`,
      ...(["POST", "PUT", "PATCH"].includes(selected.method) ? [`  -H 'Content-Type: application/json' -d '{...}'`] : []),
    ].join("\n");

  function download(): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(JSON.parse(openapi), null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${api.team}-${api.name}-openapi.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 2fr) minmax(0, 1fr)" }, alignItems: "start" }}>
      <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Box>
          <Typography variant="h6" component="h2">
            Endpoints, from its OpenAPI file
          </Typography>
          <Typography variant="body2" color="text.secondary">
            The whole of what reaches the backend; anything else gets 404 from the gateway. Pick one to see how to call it.
          </Typography>
        </Box>
        <DataTable columns={COLUMNS} rows={api.endpoints} getRowKey={(e) => `${e.method} ${e.path}`} onRowClick={setSelected} emptyMessage="Its OpenAPI file describes no endpoints." />
        {curl && (
          <>
            <Typography variant="subtitle2" component="h3">
              Calling {selected.method} {selected.path}
            </Typography>
            <Box component="pre" tabIndex={0} sx={{ m: 0, p: 2, bgcolor: "code.background", color: "code.text", borderRadius: 2, overflowX: "auto", fontSize: 12.5, fontFamily: "fontFamilyMono" }}>
              {curl}
            </Box>
            <Typography variant="body2" color="text.secondary">
              Your Authorization header signs you in to the gateway and stops there. The backend gets your other headers and who you
              are, in Vertra-Caller, signed by the gateway. Every answer says which answered: Vertra-Answered-By: gateway or backend.
            </Typography>
          </>
        )}
      </Card>

      <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Fact label="Call it at">
          <Mono>{base}</Mono>
        </Fact>
        <Fact label="Spec">{`${api.specTitle} ${api.specVersion} · ${String(api.endpoints.length)} endpoint${api.endpoints.length === 1 ? "" : "s"}`}</Fact>
        <Fact label="Your team's limit">
          {api.mayCall ? `${String(api.perMinute)} a minute · ${size(api.maxRequestBytes)} a request · ${String(api.timeoutSeconds)} s` : "None: it isn't shared with your teams"}
        </Fact>
        <Fact label="Shared with">{api.shareWith.length > 0 ? api.shareWith.join(", ") : "its own team only"}</Fact>
        <Box>
          <Button variant="outlined" onClick={download} disabled={!openapi}>
            Download its OpenAPI file
          </Button>
        </Box>
      </Card>
    </Box>
  );
}
