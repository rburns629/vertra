// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { ApiError, deleteResources, type MadeResource } from "../api";
import { when } from "../time";
import { ConfirmDialog } from "./ConfirmDialog";
import { DataTable, type DataTableColumn } from "./DataTable";
import { Pill } from "./Pill";

/** A resource's state, linking to its delete's run while there is one. */
function State({ resource }: { resource: MadeResource }) {
  const run = (children: ReactNode) =>
    resource.deletingExecutionId ? (
      <Link component={RouterLink} to={`/runs/${resource.deletingExecutionId}`} underline="none">
        {children}
      </Link>
    ) : (
      children
    );
  switch (resource.state) {
    case "deleting":
      return run(<Pill tone="info">Deleting</Pill>);
    case "delete_failed":
      return run(<Pill tone="error">Delete failed</Pill>);
    case "deleted":
      return <Pill tone="neutral">Deleted</Pill>;
    default:
      return <Pill tone="success">Made</Pill>;
  }
}

/**
 * What runs made (ResourceService), with Delete where you may: it runs the
 * product's cleanup action and opens that run. `showRun` adds the run that
 * made each.
 */
export function ResourceTable({ resources, showRun = false, emptyMessage }: { resources: MadeResource[] | null; showRun?: boolean; emptyMessage?: ReactNode }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState<MadeResource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(resource: MadeResource): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      navigate(`/runs/${await deleteResources([resource.id])}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete it.");
      setBusy(false);
      setConfirming(null);
    }
  }

  const columns: DataTableColumn<MadeResource>[] = [
    {
      key: "what",
      header: "What",
      render: (r) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
            {r.link ? (
              <Link href={r.link} target="_blank" rel="noopener noreferrer">
                {r.name ?? r.externalId} ↗
              </Link>
            ) : (
              (r.name ?? r.externalId)
            )}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono", overflowWrap: "anywhere" }}>
            {r.type}
            {r.name ? ` · ${r.externalId}` : ""}
          </Typography>
        </Box>
      ),
    },
    { key: "for", header: "Made for", hideBelow: "md", render: (r) => r.ownerTeam ?? r.ownerEmail ?? "—" },
    ...(showRun
      ? [
          {
            key: "run",
            header: "By",
            hideBelow: "sm",
            render: (r: MadeResource) => (
              <Link component={RouterLink} to={`/runs/${r.executionId}`}>
                {r.product.startsWith(`${r.productTeam}-`) ? r.product.slice(r.productTeam.length + 1) : r.product}
              </Link>
            ),
          } satisfies DataTableColumn<MadeResource>,
        ]
      : []),
    { key: "when", header: "Made", hideBelow: "md", render: (r) => when(r.firstReportedAt) },
    { key: "state", header: "State", render: (r) => <State resource={r} /> },
    {
      key: "delete",
      header: "",
      align: "right",
      render: (r) =>
        r.canDelete && (
          <Button size="small" color="error" onClick={() => { setConfirming(r); }}>
            Delete
          </Button>
        ),
    },
  ];

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          {error}
        </Alert>
      )}
      <DataTable columns={columns} rows={resources} getRowKey={(r) => r.id} emptyMessage={emptyMessage} />
      <ConfirmDialog
        open={confirming !== null}
        title={`Delete ${confirming?.name ?? confirming?.externalId ?? ""}?`}
        description={`This runs ${confirming?.productTeam ?? "its team"}'s cleanup for this ${confirming?.type ?? "resource"}, which deletes it where it lives. You'll see the run.`}
        confirmLabel="Delete"
        destructive
        busy={busy}
        onConfirm={() => { if (confirming) void remove(confirming); }}
        onCancel={() => { setConfirming(null); }}
      />
    </Box>
  );
}
