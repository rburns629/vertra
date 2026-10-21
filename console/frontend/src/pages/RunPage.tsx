// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { EmptyState } from "../components/EmptyState";
import { Mono } from "../components/Mono";
import { PageHeader } from "../components/PageHeader";
import { RunDialog } from "../components/RunDialog";
import { ApiError, listRunnables, type Runnable } from "../api";

/** How a runnable is named in links: ?template=<team>/<name> or ?action=<product>. */
function linkKey(r: Runnable): string {
  return r.kind === "template" ? `template:${r.team}/${r.name}` : `action:${r.name}`;
}

function matches(r: Runnable, query: string): boolean {
  return [r.displayName, r.name, r.team, r.description, ...r.actions].some((text) => text.toLowerCase().includes(query));
}

/**
 * What you can run: every team's templates shared with you, and every
 * action shared with you on its own. Running one asks only for its
 * parameters (a form from its schema); its steps' images, identities and
 * secrets are its products' (../../../src/core/templates.ts). The Submit
 * page stays for a team's members writing DAGs of their own.
 *
 * ?template=<team>/<name> or ?action=<product> opens one straight away (the
 * Products page links here that way).
 */
export function RunPage() {
  const [runnables, setRunnables] = useState<Runnable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<Runnable | null>(null);

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load what you can run.");
      });
  }, []);

  // A link to one opens it once the list is in.
  useEffect(() => {
    if (!runnables) return;
    const template = params.get("template");
    const action = params.get("action");
    const wanted = template ? `template:${template}` : action ? `action:${action}` : null;
    if (!wanted) return;
    const found = runnables.find((r) => linkKey(r) === wanted);
    if (found) setOpen(found);
    else setError(`Nothing called "${template ?? action ?? ""}" is shared with you.`);
  }, [runnables, params]);

  const close = () => {
    setOpen(null);
    if (params.has("template") || params.has("action")) setParams({}, { replace: true });
  };

  const query = search.trim().toLowerCase();
  const shown = useMemo(() => (runnables && query ? runnables.filter((r) => matches(r, query)) : runnables), [runnables, query]);
  const templates = shown?.filter((r) => r.kind === "template") ?? [];
  const actions = shown?.filter((r) => r.kind === "action") ?? [];

  return (
    <Box>
      <PageHeader
        title="Run"
        subtitle="Templates and actions teams share with you. Fill in what each asks for; its steps run as the owning team's products, with their own identities and secrets. You can follow, cancel and rerun your runs from Executions."
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ mb: 3 }}>
        <TextField
          size="small"
          placeholder="Search templates and actions"
          slotProps={{ htmlInput: { "aria-label": "Search templates and actions" } }}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          sx={{ minWidth: 320 }}
        />
      </Box>

      {runnables === null && !error && (
        <Stack spacing={1}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rounded" height={88} />
          ))}
        </Stack>
      )}

      {shown?.length === 0 && (
        <EmptyState
          message={
            query
              ? "Nothing matches that search."
              : "Nothing is shared with you yet. Teams share templates and actions from their catalog; ask a team to share one with yours."
          }
        />
      )}

      {templates.length > 0 && <Section title="Templates" items={templates} onRun={setOpen} />}
      {actions.length > 0 && <Section title="Actions" items={actions} onRun={setOpen} />}

      {open && <RunDialog runnable={open} onClose={close} />}
    </Box>
  );
}

function Section({ title, items, onRun }: { title: string; items: Runnable[]; onRun: (r: Runnable) => void }) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h6" sx={{ fontWeight: 600, mb: 1.5 }}>
        {title}
      </Typography>
      <Stack spacing={1.5}>
        {items.map((r) => (
          <Card key={linkKey(r)} variant="outlined">
            <CardContent sx={{ display: "flex", gap: 2, alignItems: "flex-start", "&:last-child": { pb: 2 } }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                  <Typography sx={{ fontWeight: 600 }}>{r.displayName}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    from {r.team}
                  </Typography>
                  {r.deprecated && <Chip size="small" color="warning" label="Deprecated" title={r.deprecated} />}
                  {r.onBehalfOfRequired && (
                    <Chip size="small" variant="outlined" label={`For ${r.onBehalfOf.join(" or ")}`} title="Shared with these teams of yours: a run is for one of them." />
                  )}
                </Box>
                {r.description && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    {r.description}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.75, overflowWrap: "anywhere" }}>
                  {r.kind === "template" ? `${String(r.actions.length)} step${r.actions.length === 1 ? "" : "s"}: ` : ""}
                  <Mono>{r.actions.join(" → ")}</Mono>
                </Typography>
              </Box>
              <Button
                variant="contained"
                size="small"
                onClick={() => {
                  onRun(r);
                }}
                sx={{ flexShrink: 0 }}
              >
                Run
              </Button>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Box>
  );
}
