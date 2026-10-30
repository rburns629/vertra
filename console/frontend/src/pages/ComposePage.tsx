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
import { ApiError, listAllTeams, listProducts, listRunnables, previewOrder, submitExecution, type OrderOption, type OrderProblem, type Product } from "../api";
import { useAuth } from "../auth/AuthContext";
import { HelpLink } from "../components/HelpLink";
import { CodeBlock } from "../components/CodeBlock";
import { OrderChoice, sameInput } from "../components/OrderChoice";
import { Pill } from "../components/Pill";
import { candidates, dagOf, inputsOf, newStep, problems, proposeUrl, stepsFromOrder, templateYaml, type ComposeStep, type Draft, type InputSource } from "../compose";
import { draftOf, useComposeDrafts } from "./useComposeDrafts";

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
                  {source.kind === "parameter" && source.name ? `Asked once, as ${source.name}, for every input of that type. ` : ""}
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
 * are kept by the console for their team (useComposeDrafts).
 */
/**
 * The order builder (decision 23): several actions at once, made into steps
 * by OrderService/PreviewOrder, each input wired to the one output of its
 * wiring type, a type's default provider added when nothing provides it,
 * and what it couldn't settle said, to fix in the steps.
 */
function BuildFromCart({ team, choices, onBuilt }: { team: string; choices: Product[]; onBuilt: (steps: ComposeStep[], problems: OrderProblem[]) => void }) {
  const [cart, setCart] = useState<Product[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What was last wired, the inputs it asked to choose for (kept, so a
  // choice can be changed), and what was chosen: each choice wires again.
  const [wired, setWired] = useState<{ actions: string[]; asked: OrderProblem[] } | null>(null);
  const [picked, setPicked] = useState<OrderOption[]>([]);
  async function wire(actions: string[], chosen: OrderOption[], asked: OrderProblem[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const built = await previewOrder(team, actions, chosen);
      onBuilt(stepsFromOrder(built.steps), built.problems);
      const fresh = built.problems.filter((p) => p.options.length > 0 && !asked.some((a) => sameInput(a, p)));
      setWired({ actions, asked: [...asked, ...fresh] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't wire them.");
    } finally {
      setBusy(false);
    }
  }
  async function build(): Promise<void> {
    setPicked([]);
    await wire(cart.map((p) => p.name), [], []);
    setCart([]);
  }
  function choose(o: OrderOption): void {
    if (!wired) return;
    const next = [...picked.filter((c) => !sameInput(c, o)), o];
    setPicked(next);
    void wire(wired.actions, next, wired.asked);
  }
  return (
    <Card sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Typography variant="h6" component="h2">
        Build from a cart
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Choose the actions you want; they&apos;re put in the order they can run, each input wired to what provides its type, and
        anything else they need added. This replaces the steps above.
      </Typography>
      <Autocomplete
        multiple
        options={choices}
        value={cart}
        groupBy={(p) => p.teamName ?? ""}
        getOptionLabel={(p) => `${p.displayName ?? p.name} · ${p.action}`}
        isOptionEqualToValue={(a, b) => a.name === b.name}
        onChange={(_e, next) => { setCart(next); }}
        renderInput={(params) => <TextField {...params} label="Actions" />}
        sx={{ bgcolor: "background.paper" }}
      />
      {error && <Alert severity="error">{error}</Alert>}
      <Button variant="outlined" disabled={busy || cart.length === 0 || !team} onClick={() => void build()} sx={{ alignSelf: "flex-start" }}>
        {busy ? "Wiring…" : "Wire them"}
      </Button>
      {wired && wired.asked.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="body2" color="text.secondary">
            More than one thing could fill these: choose, and the steps are wired again.
          </Typography>
          {wired.asked.map((problem) => (
            <OrderChoice
              key={`${problem.step}.${problem.input}`}
              problem={{ ...problem, input: `${problem.step}'s ${problem.input}` }}
              chosen={picked.find((c) => sameInput(c, problem))}
              onChoose={choose}
            />
          ))}
        </Box>
      )}
    </Card>
  );
}

export function ComposePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [usable, setUsable] = useState<Set<string>>(new Set());
  const [repository, setRepository] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blank = (name: string): Draft => ({ name, displayName: "", description: "", team: user?.teamNames[0] ?? "", steps: [] });
  const [draft, setDraft] = useState<Draft>(() => blank("my-template"));
  const stored = useComposeDrafts(draft);
  const [moved, setMoved] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [built, setBuilt] = useState<OrderProblem[] | null>(null);
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
    stored.edited();
    setDraft(next);
  };
  const open = (next: Draft | null) => {
    stored.opened(next);
    setDraft(next ?? blank(`draft-${String((stored.drafts?.length ?? 0) + 1)}`));
  };
  async function loadTheirs(): Promise<void> {
    const theirs = (await stored.reload()).find((d) => d.team === draft.team && d.name === draft.name);
    open(theirs ? draftOf(theirs) : null);
  }

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
        output. Propose it to the catalog for review, or run it now when every step is your team&apos;s.{" "}
        <HelpLink guide="10-ordering-and-the-cart" section="how-do-i-compose-a-template-by-hand" label="Composing by hand" />
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
          {built && (
            <Alert severity={built.length > 0 ? "info" : "success"} onClose={() => { setBuilt(null); }}>
              {built.length > 0 ? (
                <>
                  Wired, but these need you:
                  <Box component="ul" sx={{ m: 0, pl: 2 }}>
                    {built.map((p) => (
                      <li key={`${p.code}:${p.step}:${p.input}`}>{p.message}</li>
                    ))}
                  </Box>
                </>
              ) : (
                "Wired. Fill in what's left and review it."
              )}
            </Alert>
          )}
          <BuildFromCart
            team={draft.team}
            choices={choices}
            onBuilt={(steps, found) => {
              update({ ...draft, steps });
              setBuilt(found);
            }}
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
              Kept for their team as you go: its members see and change them, from any device.{" "}
              {stored.status === "saving" ? "Saving…" : stored.status === "saved" ? "Saved." : ""}
            </Typography>
            {stored.status === "conflict" && (
              <Alert
                severity="warning"
                action={
                  <Box sx={{ display: "flex", flexDirection: "column" }}>
                    <Button size="small" color="inherit" onClick={() => void loadTheirs()}>
                      Load theirs
                    </Button>
                    <Button size="small" color="inherit" onClick={stored.keepMine}>
                      Keep mine
                    </Button>
                  </Box>
                }
              >
                {stored.problem}
              </Alert>
            )}
            {stored.status !== "conflict" && stored.problem && <Alert severity="error">{stored.problem}</Alert>}
            {stored.drafts?.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                None yet: give this one a name and it&apos;s kept.
              </Typography>
            )}
            {stored.drafts?.map((d) => {
              const isOpen = d.team === draft.team && d.name === draft.name;
              const steps = draftOf(d).steps.length;
              return (
                <Box key={`${d.team}/${d.name}`} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <Button size="small" onClick={() => { open(draftOf(d)); }} sx={{ flexGrow: 1, justifyContent: "flex-start", textAlign: "left", fontWeight: isOpen ? 600 : 400 }}>
                    {d.team} / {d.name} · {steps} {steps === 1 ? "step" : "steps"}
                    {d.updatedBy && ` · ${d.updatedBy}`}
                  </Button>
                  <IconButton
                    size="small"
                    aria-label={`Delete draft ${d.team}/${d.name}`}
                    onClick={() => {
                      stored.remove(d).catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't delete it."); });
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              );
            })}
            <Button size="small" onClick={() => { open(null); }}>
              New
            </Button>
            {stored.inBrowser.length > 0 && (
              <Alert
                severity="info"
                action={
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => {
                      stored
                        .moveFromBrowser(teams)
                        .then((n) => { setMoved(`${String(n)} moved.`); })
                        .catch(() => { setMoved("Couldn't move them."); });
                    }}
                  >
                    Move them
                  </Button>
                }
              >
                {stored.inBrowser.length} {stored.inBrowser.length === 1 ? "draft is" : "drafts are"} kept only in this browser. {moved}
              </Alert>
            )}
          </Card>
        </Box>
      </Box>
    </Box>
  );
}
