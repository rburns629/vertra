// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { ApiError, decideDeleteRequest, listDeleteRequests, type DeleteRequest, type ResourceRef } from "../api";
import { useAuth } from "../auth/AuthContext";
import { when } from "../time";
import { DataTable, type DataTableColumn } from "../components/DataTable";
import { Pill } from "../components/Pill";

const names = (refs: ResourceRef[]) => refs.map((r) => r.name ?? r.externalId).join(", ") || "—";

/**
 * Deletes waiting for an admin because other resources used what they'd
 * delete (decision 25): an admin approves (the cleanup runs, as theirs) or
 * denies each; anyone else sees their own. Shown only when there are any.
 */
export function DeleteRequests() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [requests, setRequests] = useState<DeleteRequest[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    listDeleteRequests()
      .then(setRequests)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the deletes waiting for an admin."); });
  }, []);
  useEffect(load, [load]);

  async function decide(request: DeleteRequest, approve: boolean): Promise<void> {
    setBusy(request.id);
    setError(null);
    try {
      const run = await decideDeleteRequest(request.id, approve);
      if (run) navigate(`/runs/${run}`);
      else load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't decide it.");
      load();
    } finally {
      setBusy(null);
    }
  }

  if (!requests || requests.length === 0) return error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null;

  const columns: DataTableColumn<DeleteRequest>[] = [
    {
      key: "what",
      header: "Delete",
      render: (r) => (
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: "anywhere" }}>
            {names(r.resources)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", overflowWrap: "anywhere" }}>
            Used by {names(r.dependents)}
          </Typography>
        </Box>
      ),
    },
    { key: "who", header: "Asked by", hideBelow: "md", render: (r) => `${r.requestedBy ?? "—"}, ${when(r.createdAt)}` },
    {
      key: "state",
      header: "",
      align: "right",
      render: (r) => {
        if (r.decision === "approved") {
          return r.executionId ? (
            <Link component={RouterLink} to={`/runs/${r.executionId}`} underline="none">
              <Pill tone="info">Approved by {r.decidedBy ?? "an admin"}</Pill>
            </Link>
          ) : (
            <Pill tone="info">Approved</Pill>
          );
        }
        if (r.decision === "denied") return <Pill tone="neutral">Denied by {r.decidedBy ?? "an admin"}</Pill>;
        if (r.decision === "deleted") return <Pill tone="neutral">Deleted with what used it</Pill>;
        if (!user?.isAdmin) return <Pill tone="warning">Waiting for an admin</Pill>;
        return (
          <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end" }}>
            <Button size="small" disabled={busy !== null} onClick={() => { void decide(r, false); }}>
              Deny
            </Button>
            <Button size="small" color="error" variant="contained" disabled={busy !== null} onClick={() => { void decide(r, true); }}>
              Approve and delete
            </Button>
          </Box>
        );
      },
    },
  ];

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="h6" component="h2" sx={{ mb: 0.5 }}>
        Waiting for an admin
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, maxWidth: 840 }}>
        Deletes refused because other resources still use what they&apos;d delete. Approving runs the delete anyway; what used it
        may stop working.
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }}>
          {error}
        </Alert>
      )}
      <Card>
        <DataTable columns={columns} rows={requests} getRowKey={(r) => r.id} />
      </Card>
    </Box>
  );
}
