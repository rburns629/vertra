// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import { ApiError, listAllTeams, listProducts, listRunnables, submitExecution, type Product } from "../api";
import { useAuth } from "../auth/AuthContext";
import { CodeBlock } from "../components/CodeBlock";
import { Pill } from "../components/Pill";
import { candidates, dagOf, inputsOf, newStep, problems, proposeUrl, templateYaml, type ComposeStep, type Draft, type InputSource } from "../compose";

const DRAFTS_KEY = "vertra.compose.drafts";

/** Drafts are kept in this browser, by name. */
function readDrafts(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Draft>) : {};
  } catch {
    return {};
  }
}

function writeDrafts(drafts: Record<string, Draft>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // A browser that won't keep them: the page still works, without drafts.
  }
}

/** "value", "parameter", "unset", or "<step>/<output>", for the source select. */
const sourceKey = (s: InputSource) => (s.kind === "step" ? `${s.step}/${s.output}` : s.kind);

function StepCard({
  step,
  index,
  draft,
  products,
  onChange,
  onRemove,
}: {
  step: ComposeStep;
  index: number;
  draft: Draft;
  products: Map<string, Product>;
  onChange: (step: ComposeStep) => void;
  onRemove: () => void;
}) {
  const product = products.get(step.product);
  const set = (name: string, source: InputSource) => { onChange({ ...step, inputs: { ...step.inputs, [name]: source } }); };
  return (
    <Card sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
        <Box sx={{ flex: "0 0 26px", height: 26, borderRadius: "50%", bgcolor: "info.light", color: "info.main", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {index + 1}
        </Box>
        <TextField size="small" label="Step" value={step.id} onChange={(e) => { onChange({ ...step, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }); }} sx={{ width: 180 }} />
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1, minWidth: 0, overflowWrap: "anywhere" }}>
          {product ? `${product.displayName ?? product.name} · ${product.action} · ${product.teamName ?? ""}` : step.product}
        </Typography>
        <IconButton aria-label={`Remove ${step.id}`} onClick={onRemove}>
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Box>
      {product &&
        inputsOf(product).map((input) => {
          const source = step.inputs[input.name] ?? { kind: "unset" };
          const options = candidates(draft, products, index, input);
          return (
            <Box key={input.name} sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "180px 1fr 1fr" }, gap: 1, alignItems: "center" }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  {input.name}
                  {input.required && " *"}
                </Typography>
                {input.wiring && (
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono" }}>
                    {input.wiring}
                  </Typography>
                )}
              </Box>
              <TextField
                select
                size="small"
                label="From"
                value={sourceKey(source)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "value") set(input.name, { kind: "value", value: "" });
                  else if (v === "parameter" || v === "unset") set(input.name, { kind: v });
                  else {
                    const [from = "", output = ""] = v.split("/");
                    set(input.name, { kind: "step", step: from, output });
                  }
                }}
              >
                <MenuItem value="unset">Not given</MenuItem>
                <MenuItem value="value">A value</MenuItem>
                <MenuItem value="parameter">Asked when it runs</MenuItem>
                {options.map((c) => (
                  <MenuItem key={`${c.step}/${c.output}`} value={`${c.step}/${c.output}`}>
                    {c.step}&apos;s {c.output}
                    {c.match === "type" && " ✓ same type"}
                  </MenuItem>
                ))}
              </TextField>
              {source.kind === "value" ? (
                <TextField size="small" label="Value" value={source.value} onChange={(e) => { set(input.name, { kind: "value", value: e.target.value }); }} helperText={input.description || undefined} />
              ) : (
                <Typography variant="caption" color="text.secondary">
                  {input.description}
                </Typography>
              )}
            </Box>
          );
        })}
    </Card>
  );
}

/**
 * Compose (/catalog/compose): a template built from the actions shared with
 * you, each input given a value, asked for when it runs, or wired from an
 * earlier step's output (matched by its wiring type). It's proposed to the
 * catalog as a file (GitHub's new-file page, in your browser, for review),
 * or run now when every step is your team's and nothing's asked. Drafts
 * are kept in this browser.
 */
export function ComposePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [usable, setUsable] = useState<Set<string>>(new Set());
  const [repository, setRepository] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(readDrafts);
  const [draft, setDraft] = useState<Draft>(() => ({ name: "my-template", displayName: "", description: "", team: user?.teamNames[0] ?? "", steps: [] }));
  const [running, setRunning] = useState(false);
  // The teams it can be for: yours, or any for an admin.
  const [teams, setTeams] = useState<string[]>(user?.teamNames ?? []);

  useEffect(() => {
    Promise.all([listProducts(), listRunnables()])
      .then(([all, runnables]) => {
        setProducts(all);
        setUsable(new Set(runnables.filter((r) => r.kind === "action" && r.shared).map((r) => r.name)));
        const source = runnables.find((r) => r.sourceUrl)?.sourceUrl ?? null;
        setRepository(source ? (source.split("/blob/")[0] ?? null) : null);
      })
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the catalog."); });
    if (user?.isAdmin) {
      listAllTeams()
        .then((all) => { setTeams(all.map((t) => t.name)); })
        .catch(() => undefined);
    }
  }, [user?.isAdmin]);

  const byName = useMemo(() => new Map((products ?? []).map((p) => [p.name, p])), [products]);
  const choices = (products ?? []).filter((p) => usable.has(p.name) && !p.deprecated);
  const found = problems(draft, byName);
  const yaml = templateYaml(draft, byName);
  const dag = dagOf(draft, byName);
  const runnable = dag !== null && found.length === 0 && draft.steps.every((s) => user?.maintainerOf.includes(byName.get(s.product)?.teamName ?? "") ?? false);
  const propose = proposeUrl(repository, draft, yaml);

  const update = (next: Draft) => {
    setDraft(next);
    const saved = { ...drafts, [next.name]: next };
    setDrafts(saved);
    writeDrafts(saved);
  };

  async function run(): Promise<void> {
    if (!dag) return;
    setRunning(true);
    setError(null);
    try {
      navigate(`/runs/${(await submitExecution(dag)).executionId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't run it.");
      setRunning(false);
    }
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/catalog">
          Catalog
        </Link>{" "}
        / Compose
      </Typography>
      <Typography variant="h4" component="h1" sx={{ mt: 0.75 }}>
        Compose
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5, mb: 3, maxWidth: 840 }}>
        Build a template from the actions shared with you: each step&apos;s inputs a value, asked when it runs, or an earlier step&apos;s
        output. Propose it to the catalog for review, or run it now when every step is your team&apos;s.
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Card sx={{ p: 2.5, display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
            <TextField size="small" label="Name" value={draft.name} onChange={(e) => { update({ ...draft, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }); }} helperText="Its file: dags/<name>.yaml" />
            <TextField select size="small" label="For team" value={draft.team} onChange={(e) => { update({ ...draft, team: e.target.value }); }} helperText="Its catalog folder, and who owns it">
              {teams.map((t) => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </TextField>
            <TextField size="small" label="Display name" value={draft.displayName} onChange={(e) => { update({ ...draft, displayName: e.target.value }); }} />
            <TextField size="small" label="Description" value={draft.description} onChange={(e) => { update({ ...draft, description: e.target.value }); }} />
          </Card>
          {draft.steps.map((step, i) => (
            <StepCard
              key={i}
              step={step}
              index={i}
              draft={draft}
              products={byName}
              onChange={(next) => { update({ ...draft, steps: draft.steps.map((s, j) => (j === i ? next : s)) }); }}
              onRemove={() => { update({ ...draft, steps: draft.steps.filter((_, j) => j !== i) }); }}
            />
          ))}
          <Autocomplete
            options={choices}
            value={null}
            blurOnSelect
            loading={products === null}
            groupBy={(p) => p.teamName ?? ""}
            getOptionLabel={(p) => `${p.displayName ?? p.name} · ${p.action}`}
            onChange={(_e, product) => { if (product) update({ ...draft, steps: [...draft.steps, newStep(draft, byName, product)] }); }}
            renderInput={(params) => <TextField {...params} label="Add a step" helperText="Actions shared with you. Inputs that need what an earlier step makes are wired to it." />}
            sx={{ bgcolor: "background.paper" }}
          />
        </Box>

        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Card sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
            <Typography variant="h6" component="h2">
              The template
            </Typography>
            {found.length > 0 ? (
              <Alert severity="warning">
                <Box component="ul" sx={{ m: 0, pl: 2 }}>
                  {found.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </Box>
              </Alert>
            ) : (
              <Pill tone="success">Ready to propose</Pill>
            )}
            <CodeBlock code={yaml} copyLabel="Copy the file" />
            <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
              <Button component="a" variant="contained" disabled={found.length > 0 || !propose} href={propose ?? undefined} target="_blank" rel="noopener noreferrer">
                Propose as a template ↗
              </Button>
              {runnable && (
                <Button variant="outlined" disabled={running} onClick={() => void run()}>
                  {running ? "Starting…" : "Run now"}
                </Button>
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">
              {propose
                ? "Opens the catalog repository's new-file page with it filled in: open a pull request for its team to review."
                : "The catalog repository isn't known here: copy the file into teams/<team>/dags/ yourself."}
              {!runnable && " It runs now only when nothing's asked and every step is a team you maintain."}
            </Typography>
          </Card>
          <Card sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography variant="h6" component="h2">
              Drafts
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Kept in this browser as you go, by name.
            </Typography>
            {Object.values(drafts).map((d) => (
              <Box key={d.name} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Button size="small" onClick={() => { setDraft(d); }} sx={{ flexGrow: 1, justifyContent: "flex-start", fontWeight: d.name === draft.name ? 600 : 400 }}>
                  {d.name} · {d.steps.length} {d.steps.length === 1 ? "step" : "steps"}
                </Button>
                <IconButton
                  size="small"
                  aria-label={`Delete draft ${d.name}`}
                  onClick={() => {
                    const { [d.name]: _gone, ...rest } = drafts;
                    setDrafts(rest);
                    writeDrafts(rest);
                  }}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}
            <Button size="small" onClick={() => { setDraft({ name: `draft-${String(Object.keys(drafts).length + 1)}`, displayName: "", description: "", team: user?.teamNames[0] ?? "", steps: [] }); }}>
              New
            </Button>
          </Card>
        </Box>
      </Box>
    </Box>
  );
}
