// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  ApiError,
  listRunnables,
  placeOrder,
  previewOrder,
  type OrderOption,
  type OrderProblem,
  type OrderSuggestion,
  type Runnable,
} from "../api";
import { useAuth } from "../auth/AuthContext";
import { cart, useCart } from "../cart";
import type { BuiltStep } from "../compose";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Pill } from "../components/Pill";
import { fieldsOf, initialValues, toParameters, type Field, type FieldValue, type Values } from "../schemaForm";
import { FieldInput } from "./catalog/FieldInput";

type Plan = { steps: BuiltStep[]; problems: OrderProblem[]; suggestions: OrderSuggestion[] };

const sameInput = (a: { step: string; input: string }, b: { step: string; input: string }) => a.step === b.step && a.input === b.input;
const optionKey = (o: OrderOption) => (o.resourceId ? `r:${o.resourceId}` : o.addNew ? "new" : `s:${o.fromStep ?? ""}.${o.fromOutput ?? ""}`);

/** How a wired input is filled, in a line. */
function Wired({ input, choice }: { input: BuiltStep["inputs"][string]; choice: OrderOption | undefined }) {
  const text =
    input.kind === "step"
      ? `From ${input.step ?? ""}'s ${input.output ?? ""}`
      : input.kind === "resource"
        ? `Uses ${choice?.label ?? input.value ?? ""}`
        : input.kind === "parameter"
          ? `Asked once for the order: ${input.parameter ?? ""}`
          : "";
  return (
    <Typography variant="body2" color="text.secondary">
      {text}
    </Typography>
  );
}

/** A choice the order needs made: what fills this input. */
function Choose({ problem, chosen, onChoose }: { problem: OrderProblem; chosen: OrderOption | undefined; onChoose: (o: OrderOption) => void }) {
  return (
    <TextField
      select
      size="small"
      label={problem.input}
      helperText={problem.message}
      value={chosen ? optionKey(chosen) : ""}
      onChange={(e) => {
        const picked = problem.options.find((o) => optionKey(o) === e.target.value);
        if (picked) onChoose(picked);
      }}
      sx={{ minWidth: 280 }}
    >
      {problem.options.map((o) => (
        <MenuItem key={optionKey(o)} value={optionKey(o)}>
          {o.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/**
 * The cart (/catalog/cart, decision 25): the actions collected in the
 * Catalog, planned together for one of your teams (PreviewOrder): what each
 * needs added, what you already have that it could use, what's suggested,
 * and what you fill in. Place order runs it as one run for the team
 * (PlaceOrder). Choices aren't kept: they're made here, for this order,
 * starting from what a chat answer filled in, if one did.
 */
export function CartPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { team: chosenTeam, actions, choices: proposedChoices, values: proposedValues } = useCart();
  const teams = user?.teamNames ?? [];
  const team = chosenTeam && teams.includes(chosenTeam) ? chosenTeam : (teams[0] ?? null);
  const [runnables, setRunnables] = useState<Runnable[]>([]);
  const [choices, setChoices] = useState<OrderOption[]>(proposedChoices);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [values, setValues] = useState<Record<string, Values>>({});
  const [shared, setShared] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  // One per visit: placing it again after a timeout is the same order.
  const [requestId] = useState(() => crypto.randomUUID());

  // A chat answer's cart opened here: start again from what it filled in.
  useEffect(() => {
    setChoices(proposedChoices);
    setValues({});
  }, [proposedChoices, proposedValues]);

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      .catch(() => { setRunnables([]); });
  }, []);

  useEffect(() => {
    if (!team || actions.length === 0) {
      setPlan(null);
      return;
    }
    let current = true;
    previewOrder(team, actions, choices)
      .then((p) => { if (current) { setPlan(p); setError(null); } })
      .catch((err: unknown) => { if (current) setError(err instanceof ApiError ? err.message : "Couldn't plan the order."); });
    return () => {
      current = false;
    };
  }, [team, actions, choices]);

  const actionsByName = useMemo(() => new Map(runnables.filter((r) => r.kind === "action").map((r) => [r.name, r])), [runnables]);
  const action = (name: string) => actionsByName.get(name);
  // Each step's inputs left for you, as form fields.
  const fields = useMemo(() => {
    const out: Record<string, Field[]> = {};
    for (const step of plan?.steps ?? []) {
      const all = fieldsOf(actionsByName.get(step.product)?.parameters ?? {}) ?? [];
      out[step.id] = all.filter((f) => step.inputs[f.name]?.kind === "unset");
    }
    return out;
  }, [plan, actionsByName]);
  const parameters = useMemo(() => [...new Set((plan?.steps ?? []).flatMap((s) => Object.values(s.inputs).filter((i) => i.kind === "parameter").map((i) => i.parameter ?? "")))], [plan]);

  const choose = (o: OrderOption) => { setChoices((list) => [...list.filter((c) => !sameInput(c, o)), o]); };
  const valuesOf = (step: string): Values =>
    values[step] ?? initialValues(action(plan?.steps.find((s) => s.id === step)?.product ?? "")?.parameters ?? {}, fields[step] ?? [], proposedValues[step]);
  const set = (step: string) => (name: string, value: FieldValue) => {
    setValues((all) => ({ ...all, [step]: { ...valuesOf(step), [name]: value } }));
  };
  // Choices still to make: the options problems, not a value you'll type.
  const unchosen = (plan?.problems ?? []).filter((p) => p.options.length > 0 && !choices.some((c) => sameInput(c, p)));
  const cycle = (plan?.problems ?? []).find((p) => p.code === "CYCLE");

  async function place(): Promise<void> {
    if (!team || !plan) return;
    const typed: Record<string, Record<string, unknown>> = {};
    const errors: Record<string, string> = {};
    for (const step of plan.steps) {
      const result = toParameters(fields[step.id] ?? [], valuesOf(step.id));
      typed[step.id] = result.parameters;
      for (const [name, message] of Object.entries(result.errors)) errors[`${step.id}.${name}`] = message;
    }
    for (const name of parameters) if (!shared[name]?.trim()) errors[`parameter.${name}`] = "Required.";
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setPlacing(true);
    setError(null);
    try {
      const id = await placeOrder({ team, actions, choices, values: typed, parameters: shared, requestId });
      cart.clear();
      navigate(`/runs/${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't place the order.");
      setPlacing(false);
    }
  }

  return (
    <Box>
      <PageHeader
        title="Cart"
        subtitle="What you've added from the Catalog, ordered together as one run for one of your teams. What each needs is added or offered, and you fill in the rest."
        action={
          <Button component={RouterLink} to="/catalog" variant="outlined">
            Back to the catalog
          </Button>
        }
      />
      {teams.length === 0 ? (
        <Alert severity="info">You're in no team yet: an order is placed for one of yours.</Alert>
      ) : actions.length === 0 ? (
        <Card>
          <EmptyState
            message="Your cart is empty: add actions from the Catalog."
            action={
              <Button component={RouterLink} to="/catalog" variant="contained">
                Open the catalog
              </Button>
            }
          />
        </Card>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 920 }}>
          <TextField select size="small" label="For team" value={team ?? ""} onChange={(e) => { cart.setTeam(e.target.value); setChoices([]); }} sx={{ maxWidth: 320 }}>
            {teams.map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>

          <Card sx={{ p: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              In your cart
            </Typography>
            {actions.map((name, i) => (
              <Box key={`${name}-${String(i)}`} sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, py: 0.5 }}>
                <Typography variant="body2">{action(name)?.displayName ?? name}</Typography>
                <Button size="small" onClick={() => { cart.removeAt(i); }}>
                  Remove
                </Button>
              </Box>
            ))}
          </Card>

          {error && <Alert severity="error">{error}</Alert>}
          {cycle && <Alert severity="warning">{cycle.message}</Alert>}

          {plan?.steps.map((step) => {
            const suggestions = plan.suggestions.filter((s) => s.step === step.id);
            return (
              <Card key={step.id} sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                  <Typography variant="h6" component="h2" sx={{ fontSize: 17 }}>
                    {action(step.product)?.displayName ?? step.product}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "fontFamilyMono" }}>
                    {step.id}
                  </Typography>
                  {step.added && <Pill tone="info">Added: something in your cart needs it</Pill>}
                </Box>
                {Object.entries(step.inputs).map(([name, input]) => {
                  const problem = plan.problems.find((p) => p.options.length > 0 && sameInput(p, { step: step.id, input: name }));
                  const chosen = choices.find((c) => sameInput(c, { step: step.id, input: name }));
                  if (problem) return <Choose key={name} problem={problem} chosen={chosen} onChoose={choose} />;
                  if (input.kind === "unset") return null;
                  return (
                    <Box key={name} sx={{ display: "flex", gap: 1 }}>
                      <Typography variant="body2" sx={{ fontFamily: "fontFamilyMono", minWidth: 160 }}>
                        {name}
                      </Typography>
                      <Wired input={input} choice={chosen} />
                    </Box>
                  );
                })}
                {(fields[step.id] ?? []).map((field) => (
                  <FieldInput
                    key={field.name}
                    field={field}
                    value={valuesOf(step.id)[field.name]}
                    error={fieldErrors[`${step.id}.${field.name}`]}
                    onChange={set(step.id)}
                  />
                ))}
                {suggestions.map((s) => (
                  <Alert key={s.input} severity="info" sx={{ alignItems: "center" }}>
                    <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                      <span>Optional: {s.input} ({s.wiringType}).</span>
                      {s.provider && (
                        <Button size="small" variant="outlined" onClick={() => { if (s.provider) cart.add(s.provider); }}>
                          Add {action(s.provider)?.displayName ?? s.provider}
                        </Button>
                      )}
                      {s.existing.map((o) => (
                        <Button key={optionKey(o)} size="small" onClick={() => { choose(o); }}>
                          Use {o.label}
                        </Button>
                      ))}
                    </Box>
                  </Alert>
                ))}
              </Card>
            );
          })}

          {parameters.length > 0 && (
            <Card sx={{ p: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
              <Typography variant="subtitle2">Asked once for the whole order</Typography>
              {parameters.map((name) => (
                <TextField
                  key={name}
                  size="small"
                  label={name}
                  required
                  value={shared[name] ?? ""}
                  error={Boolean(fieldErrors[`parameter.${name}`])}
                  helperText={fieldErrors[`parameter.${name}`]}
                  onChange={(e) => { setShared((all) => ({ ...all, [name]: e.target.value })); }}
                  sx={{ maxWidth: 420 }}
                />
              ))}
            </Card>
          )}

          <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
            <Button variant="contained" disabled={!plan || placing || unchosen.length > 0 || Boolean(cycle)} onClick={() => { void place(); }}>
              Place order
            </Button>
            {unchosen.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                Choose what fills {unchosen.map((p) => `${p.step}'s ${p.input}`).join(", ")} first.
              </Typography>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
