// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { PageHeader } from "../components/PageHeader";
import { ApiError, listApis, type ApiProduct } from "../api";
import { ApiStatePill } from "./api/ApiStatePill";

const COLUMNS: DataTableColumn<ApiProduct>[] = [
  {
    key: "api",
    header: "API",
    render: (a) => (
      <Box>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {a.displayName}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono" }}>
          {a.team}/{a.name}
        </Typography>
      </Box>
    ),
  },
  { key: "state", header: "State", render: (a) => <ApiStatePill state={a.state} /> },
  { key: "endpoints", header: "Endpoints", render: (a) => a.endpoints.length, align: "right", hideBelow: "sm" },
  {
    key: "you",
    header: "You",
    render: (a) => (a.mayCall ? `may call, ${String(a.perMinute)} a minute` : "not shared with your teams"),
    hideBelow: "sm",
  },
  { key: "reach", header: "Reachable", render: (a) => (a.internet ? "Internet" : "In the cluster"), hideBelow: "md" },
];

/**
 * Every API product the signed-in user may see (ApiService.ListApis):
 * backends teams already run, published through the gateway, which
 * forwards only what each one's OpenAPI document describes.
 */
export function ApisPage() {
  const navigate = useNavigate();
  const [apis, setApis] = useState<ApiProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    listApis()
      .then((list) => {
        if (!cancelled) setApis(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Failed to load APIs.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!apis || !q) return apis;
    return apis.filter((a) => [a.team, a.name, a.displayName, a.description].some((s) => s.toLowerCase().includes(q)));
  }, [apis, search]);

  return (
    <Box>
      <PageHeader
        title="APIs"
        help={{ guide: "11-apis", label: "APIs and the gateway" }}
        subtitle="Backends teams already run, published through this install's gateway. Each one's OpenAPI file is the whole of what reaches it: anything else is blocked at the gateway."
      />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <TextField
        size="small"
        placeholder="Search APIs"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
        sx={{ mb: 2, width: { xs: "100%", sm: 320 } }}
        slotProps={{ htmlInput: { "aria-label": "Search APIs" } }}
      />
      <DataTable
        columns={COLUMNS}
        rows={shown}
        getRowKey={(a) => `${a.team}/${a.name}`}
        onRowClick={(a) => {
          navigate(`/apis/${a.team}/${a.name}`);
        }}
        emptyMessage="No APIs yet. A team publishes one with an api.yaml and its OpenAPI file in its catalog folder."
      />
    </Box>
  );
}
