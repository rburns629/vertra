// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ApiError, getImagePolicy, updateImagePolicy, type ImagePolicy } from "../../api";

/** A whole registry host (every project or user on it), not one path in
 * it. Same rule as ../../src/imagePolicy.ts's isBroadSource. */
function isBroadSource(entry: string): boolean {
  return entry.trim().replace(/^https?:\/\//, "").split("/").filter(Boolean).length <= 1;
}

/**
 * The image sources tasks may run from. The cluster enforces this exact
 * list when a task is dispatched (the execution-kernel chart's
 * image-policy.yaml), so a save here takes effect for every team at once.
 */
export function ImageSourcesCard() {
  const [policy, setPolicy] = useState<ImagePolicy | null>(null);
  const [source, setSource] = useState("");
  const [additional, setAdditional] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingBroad, setConfirmingBroad] = useState(false);

  function load(): void {
    getImagePolicy()
      .then((loaded) => {
        setPolicy(loaded);
        setSource(loaded.source);
        setAdditional(loaded.additional);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load image sources.");
      });
  }

  useEffect(load, []);

  const entries = additional.map((entry) => entry.trim()).filter((entry) => entry !== "");
  const broad = [source, ...entries].filter((entry) => entry.trim() !== "" && isBroadSource(entry));

  async function save(): Promise<void> {
    if (!policy) return;
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const saved = await updateImagePolicy(source, entries, policy.version);
      setPolicy(saved);
      setSource(saved.source);
      setAdditional(saved.additional);
      setSuccess("Saved. The cluster enforces the new list for every task from now on.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
      setConfirmingBroad(false);
    }
  }

  const notConfigured = policy !== null && policy.exists && policy.allowed.length === 0;

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Image sources
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Tasks can only run images from these registry paths; the cluster refuses anything else,
          however it was submitted. The source registry is where catalog CI publishes product
          images. Base images a Dockerfile builds from (node, python, …) don't need to be listed:
          they're baked into the published image.
        </Typography>

        {policy && !policy.exists && (
          <Alert severity="error" sx={{ mb: 2 }}>
            The cluster's image policy doesn't exist, so no task can run. Installing or
            upgrading the execution-kernel release creates it.
          </Alert>
        )}
        {notConfigured && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            No image source is configured yet, so no task can run. Set the source registry below.
          </Alert>
        )}

        <Stack spacing={2} sx={{ maxWidth: 640 }}>
          <TextField
            label="Source registry"
            size="small"
            placeholder="us-central1-docker.pkg.dev/my-project/catalog-products"
            helperText="The registry path images are published to. Images under it are allowed."
            value={source}
            disabled={!policy?.exists}
            onChange={(event) => {
              setSource(event.target.value);
            }}
          />
          <Typography variant="caption" color="text.secondary">
            Additional allowed sources (optional), e.g. docker.io/library for official Docker Hub
            images.
          </Typography>
          {additional.map((entry, index) => (
            <Box key={index} sx={{ display: "flex", gap: 1 }}>
              <TextField
                size="small"
                fullWidth
                placeholder="docker.io/library"
                slotProps={{ htmlInput: { "aria-label": `Allowed source ${String(index + 1)}` } }}
                value={entry}
                disabled={!policy?.exists}
                onChange={(event) => {
                  const value = event.target.value;
                  setAdditional((current) => current.map((e, i) => (i === index ? value : e)));
                }}
              />
              <Button
                size="small"
                color="error"
                onClick={() => {
                  setAdditional((current) => current.filter((_, i) => i !== index));
                }}
              >
                Remove
              </Button>
            </Box>
          ))}
          <Button
            size="small"
            sx={{ alignSelf: "flex-start" }}
            disabled={!policy?.exists}
            onClick={() => {
              setAdditional((current) => [...current, ""]);
            }}
          >
            Add a source
          </Button>

          {broad.length > 0 && (
            <Alert severity="warning">
              {broad.join(", ")} {broad.length === 1 ? "allows" : "allow"} a whole registry: any
              image anyone has published there could run. Prefer a specific path.
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {success && <Alert severity="success">{success}</Alert>}
          <Box>
            <Button
              variant="contained"
              disabled={saving || !policy?.exists || source.trim() === ""}
              onClick={() => {
                if (broad.length > 0) setConfirmingBroad(true);
                else void save();
              }}
            >
              {saving ? "Saving…" : "Save image sources"}
            </Button>
          </Box>
        </Stack>
      </CardContent>
      <ConfirmDialog
        open={confirmingBroad}
        title="Allow a whole registry?"
        description={`${broad.join(", ")} would let tasks run any image published there by anyone, not just your own. Save anyway?`}
        confirmLabel="Save anyway"
        destructive
        busy={saving}
        onConfirm={() => void save()}
        onCancel={() => {
          setConfirmingBroad(false);
        }}
      />
    </Card>
  );
}
