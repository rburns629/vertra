// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import FormControlLabel from "@mui/material/FormControlLabel";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { RunDialog } from "../components/RunDialog";
import { ApiError, listRunnables, type Runnable } from "../api";

/** How a runnable is named in links: ?template=<team>/<name> or ?action=<product>. */
function linkKey(r: Runnable): string {
  return r.kind === "template" ? `template:${r.team}/${r.name}` : `action:${r.name}`;
}

function matches(r: Runnable, query: string): boolean {
  return [r.displayName, r.name, r.team, r.description, ...r.actions].some((text) => text.toLowerCase().includes(query));
}

/** What it asks for: its parameters' names, from its JSON Schema. */
function inputsOf(r: Runnable): string[] {
  const properties = r.parameters["properties"];
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
}

/** The catalog repository's address, from any item's link into it (github.com/<owner>/<repo>). */
function repositoryOf(runnables: Runnable[]): string | null {
  for (const r of runnables) {
    const match = r.sourceUrl ? /^https:\/\/github\.com\/[^/]+\/[^/]+/.exec(r.sourceUrl) : null;
    if (match) return match[0];
  }
  return null;
}

/** Ready, Deprecated (why, on hover), or not shared with you. */
function State({ r }: { r: Runnable }) {
  if (!r.shared) return <Pill tone="neutral">Not shared with you</Pill>;
  if (r.deprecated) return <Pill tone="warning" title={r.deprecated}>Deprecated</Pill>;
  return <Pill tone="success">Ready</Pill>;
}

function CatalogCard({ r, onRun }: { r: Runnable; onRun: (r: Runnable) => void }) {
  const inputs = inputsOf(r);
  const steps = r.actions.length;
  return (
    <Card sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5, opacity: r.shared ? 1 : 0.8 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 1.5 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" component="h2" sx={{ lineHeight: 1.3 }}>
            {r.displayName}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {r.team} · {r.kind === "template" ? `template · ${String(steps)} step${steps === 1 ? "" : "s"}` : "action"}
          </Typography>
        </Box>
        <State r={r} />
      </Box>
      {r.description && (
        <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
          {r.description}
        </Typography>
      )}
      {inputs.length > 0 && (
        <Typography variant="body2" sx={{ fontFamily: "fontFamilyMono", fontSize: 12.5, overflowWrap: "anywhere" }}>
          <Box component="span" sx={{ color: "text.secondary" }}>
            in{" "}
          </Box>
          {inputs.join(", ")}
        </Typography>
      )}
      <Box sx={{ mt: "auto", pt: 1, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1.5, flexWrap: "wrap" }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: "1 1 160px" }}>
          {r.shared
            ? r.onBehalfOfRequired
              ? `For ${r.onBehalfOf.join(" or ")}`
              : r.sourceUrl && (
                  <Link href={r.sourceUrl} target="_blank" rel="noopener noreferrer">
                    Its definition ↗
                  </Link>
                )
            : r.shareWith.length > 0
              ? `Shared with ${r.shareWith.join(", ")}.`
              : `Only ${r.team} runs it.`}
        </Typography>
        {r.shared ? (
          <Button variant="contained" onClick={() => { onRun(r); }}>
            Run
          </Button>
        ) : r.askForAccessUrl ? (
          <Button
            variant="outlined"
            href={r.askForAccessUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`Opens an issue on the catalog repository asking ${r.team} to share it with your team.`}
          >
            Ask for access ↗
          </Button>
        ) : null}
      </Box>
    </Card>
  );
}

/**
 * What teams publish: every template and action shared with you, and what
 * isn't yet (with Ask for access: GitHub's new-issue page on the catalog,
 * filled in, opened in your own browser; the console only reads the
 * catalog). Hidden ones never reach this page. Running one asks only for its
 * parameters; its steps' images, identities and secrets are its products'
 * (../../../src/core/templates.ts).
 *
 * ?template=<team>/<name> or ?action=<product> opens one straight away (the
 * product list links here that way).
 */
export function CatalogPage() {
  const [runnables, setRunnables] = useState<Runnable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [team, setTeam] = useState<string | null>(null);
  const [runnableOnly, setRunnableOnly] = useState(false);
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<Runnable | null>(null);

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load the catalog.");
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
    if (found?.shared) setOpen(found);
    else if (found) setError(`"${found.displayName}" isn't shared with you: ask its team for access.`);
    else setError(`Nothing called "${template ?? action ?? ""}" is shared with you.`);
  }, [runnables, params]);

  const close = () => {
    setOpen(null);
    if (params.has("template") || params.has("action")) setParams({}, { replace: true });
  };

  const teams = useMemo(() => [...new Set((runnables ?? []).map((r) => r.team))].sort(), [runnables]);
  const query = search.trim().toLowerCase();
  // What you can run first, templates before actions; the rest after.
  const shown = useMemo(
    () =>
      (runnables ?? [])
        .filter((r) => (!team || r.team === team) && (!runnableOnly || r.shared) && (!query || matches(r, query)))
        .sort((a, b) => Number(b.shared) - Number(a.shared) || (a.kind === b.kind ? 0 : a.kind === "template" ? -1 : 1)),
    [runnables, team, runnableOnly, query],
  );
  const repository = runnables ? repositoryOf(runnables) : null;

  return (
    <Box>
      <PageHeader
        title="Catalog"
        subtitle="What platform teams publish. Each one runs as its team's own identity: you only fill in the inputs. What isn't shared with your team yet is shown too, so you can ask for it."
        action={
          <Box sx={{ display: "flex", gap: 1.5, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {repository && (
              <Link href={repository} target="_blank" rel="noopener noreferrer" variant="body2">
                Definitions live in the catalog repository ↗
              </Link>
            )}
            <Button component={RouterLink} to="/products" variant="outlined">
              Every product
            </Button>
          </Box>
        }
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center", mb: 3 }}>
        <TextField
          size="small"
          placeholder="Search templates, actions, teams"
          slotProps={{ htmlInput: { "aria-label": "Search the catalog" } }}
          value={search}
          onChange={(event) => { setSearch(event.target.value); }}
          sx={{ flex: "1 1 280px", maxWidth: 420, bgcolor: "background.paper" }}
        />
        <Box role="group" aria-label="Team" sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
          {[null, ...teams].map((t) => (
            <Chip
              key={t ?? "all"}
              label={t ?? "All teams"}
              clickable
              aria-pressed={team === t}
              color={team === t ? "primary" : "default"}
              variant={team === t ? "filled" : "outlined"}
              onClick={() => { setTeam(t); }}
              sx={{ bgcolor: team === t ? undefined : "background.paper" }}
            />
          ))}
        </Box>
        <FormControlLabel
          control={<Switch checked={runnableOnly} onChange={(event) => { setRunnableOnly(event.target.checked); }} />}
          label="Only what I can run"
          sx={{ ml: { md: "auto" } }}
        />
      </Box>

      {runnables === null && !error && (
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 2 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rounded" height={200} />
          ))}
        </Box>
      )}

      {runnables !== null && shown.length === 0 && (
        <EmptyState
          message={
            runnables.length === 0
              ? "Nothing is published here yet. Teams publish templates and actions from their catalog repository."
              : "Nothing matches these filters."
          }
        />
      )}

      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 2 }}>
        {shown.map((r) => (
          <CatalogCard key={linkKey(r)} r={r} onRun={setOpen} />
        ))}
      </Box>

      {open && <RunDialog runnable={open} onClose={close} />}
    </Box>
  );
}
