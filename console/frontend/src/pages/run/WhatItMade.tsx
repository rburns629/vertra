// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { ApiError, deleteRunResources, listResources, type MadeResource } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ResourceTable } from "../../components/ResourceTable";

const REFRESH_MS = 15_000;

/**
 * What a run made, once it's recorded (within a minute of the run
 * finishing): each resource, and Delete all, newest first. Hidden while
 * there's nothing. Looked at again every few seconds while `watching` (the
 * run is live or just finished) or something is being deleted.
 */
export function WhatItMade({ executionId, watching }: { executionId: string; watching: boolean }) {
  const navigate = useNavigate();
  const [made, setMade] = useState<MadeResource[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleting = made.some((r) => r.state === "deleting");

  useEffect(() => {
    let current = true;
    const load = () => {
      listResources({ executionId, includeDeleted: true })
        .then((rows) => { if (current) setMade(rows); })
        .catch(() => undefined); // Display only: the run page works without it.
    };
    load();
    const timer = watching || deleting ? setInterval(load, REFRESH_MS) : undefined;
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [executionId, watching, deleting]);

  async function deleteAll(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      navigate(`/runs/${await deleteRunResources(executionId)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete them.");
      setBusy(false);
      setConfirming(false);
    }
  }

  if (made.length === 0) return null;
  const left = made.filter((r) => r.canDelete);
  return (
    <Card sx={{ p: { xs: 2, sm: 3 }, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Box>
          <Typography variant="h6" component="h2">
            What it made
          </Typography>
          <Typography variant="body2" color="text.secondary">
            As its steps reported it. Kept after the run is gone, with everything else in{" "}
            <Link component={RouterLink} to="/runs/made">
              What runs made
            </Link>
            .
          </Typography>
        </Box>
        {left.length > 1 && (
          <Button variant="outlined" color="error" onClick={() => { setConfirming(true); }}>
            Delete all
          </Button>
        )}
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      <ResourceTable resources={made} />
      <ConfirmDialog
        open={confirming}
        title={`Delete all ${String(left.length)}?`}
        description="This runs each one's cleanup, newest first, one after another, which deletes them where they live. You'll see the run."
        confirmLabel="Delete all"
        destructive
        busy={busy}
        onConfirm={() => void deleteAll()}
        onCancel={() => { setConfirming(false); }}
      />
    </Card>
  );
}
