// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, listRunnables, runRunnable, type Runnable } from "../api";
import { Pill } from "../components/Pill";
import { fieldsOf, groupsOf, initialValues, serverProblems, toParameters, withTargets, type FieldValue, type Values } from "../schemaForm";
import { FieldInput } from "./catalog/FieldInput";

/** How a runnable is named in this page's address: ?template=<team>/<name> or ?action=<product>. */
export function runLink(r: Pick<Runnable, "kind" | "team" | "name">): string {
  return r.kind === "template" ? `/catalog/run?template=${encodeURIComponent(`${r.team}/${r.name}`)}` : `/catalog/run?action=${encodeURIComponent(r.name)}`;
}

/** "gcp-platform/project.create" → its parts, for "What will run". */
function stepOf(action: string): { team: string; product: string; action: string } {
  const [team = "", rest = action] = action.includes("/") ? action.split("/", 2) : ["", action];
  const dot = rest.lastIndexOf(".");
  return { team, product: dot > 0 ? rest.slice(0, dot) : rest, action: dot > 0 ? rest.slice(dot + 1) : "" };
}

/** The form for one runnable, once it's found. */
function RunForm({ runnable }: { runnable: Runnable }) {
  const navigate = useNavigate();
  const fields = useMemo(() => withTargets(fieldsOf(runnable.parameters), runnable.targets), [runnable]);
  const [values, setValues] = useState<Values>(() => (fields ? initialValues(runnable.parameters, fields) : {}));
  const [json, setJson] = useState("{}");
  const [team, setTeam] = useState(runnable.onBehalfOfRequired && runnable.onBehalfOf.length === 1 ? (runnable.onBehalfOf[0] ?? "") : "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  async function run(event: FormEvent): Promise<void> {
    event.preventDefault();
    setErrors([]);
    let parameters: Record<string, unknown>;
    if (fields) {
      const typed = toParameters(fields, values);
      setFieldErrors(typed.errors);
      if (Object.keys(typed.errors).length > 0) return;
      parameters = typed.parameters;
    } else {
      try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
        parameters = parsed as Record<string, unknown>;
      } catch {
        setErrors(["The inputs must be a JSON object."]);
        return;
      }
    }
    if (runnable.onBehalfOfRequired && !team) {
      setErrors(["Choose which of your teams it runs for."]);
      return;
    }
    setRunning(true);
    try {
      navigate(`/runs/${encodeURIComponent(await runRunnable(runnable, parameters, team || undefined))}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_PARAMETERS") {
        const problems = serverProblems(err.problems);
        setFieldErrors(problems.fields);
        setErrors(problems.general.length > 0 || !fields ? [err.message] : []);
      } else {
        setErrors([err instanceof ApiError ? err.message : "Something went wrong. Try again."]);
      }
      setRunning(false);
    }
  }

  const set = (name: string, value: FieldValue) => {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors(({ [name]: _cleared, ...rest }) => rest);
  };

  const steps = runnable.actions.map(stepOf);
  return (
    <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "minmax(0, 3fr) minmax(0, 2fr)" }, alignItems: "start" }}>
      <Card component="form" noValidate onSubmit={(event: FormEvent) => void run(event)} sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2.5 }}>
        <Typography variant="h6" component="h2">
          Inputs
        </Typography>
        {fields ? (
          groupsOf(fields).map(({ group, fields: shown }) => (
            <Box key={group ?? "-"} component={group ? "fieldset" : "div"} sx={{ border: 0, m: 0, p: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 2.5 }}>
              {group && (
                <Typography component="legend" variant="subtitle2" color="text.secondary" sx={{ mb: 1.5, textTransform: "uppercase", letterSpacing: 0.6, fontSize: 12 }}>
                  {group}
                </Typography>
              )}
              {shown.map((field) => (
                <FieldInput key={field.name} field={field} value={values[field.name]} error={fieldErrors[field.name]} onChange={set} />
              ))}
            </Box>
          ))
        ) : (
          <TextField
            label="Inputs (JSON)"
            value={json}
            onChange={(e) => { setJson(e.target.value); }}
            multiline
            minRows={4}
            slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }}
            helperText="A JSON object: its schema names no fields."
          />
        )}
        {(runnable.onBehalfOfRequired || runnable.onBehalfOf.length > 0) && (
          <TextField
            select
            label="Run for"
            value={team}
            onChange={(e) => { setTeam(e.target.value); }}
            required={runnable.onBehalfOfRequired}
            helperText={runnable.onBehalfOfRequired ? "It's shared with specific teams: which of yours is this run for?" : "Optional: which of your teams this run is for."}
          >
            {!runnable.onBehalfOfRequired && <MenuItem value="">Just me</MenuItem>}
            {runnable.onBehalfOf.map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </TextField>
        )}
        {errors.map((message) => (
          <Alert key={message} severity="error">
            {message}
          </Alert>
        ))}
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}>
          <Button type="submit" variant="contained" size="large" disabled={running}>
            {running ? "Starting…" : "Run"}
          </Button>
          <Typography variant="body2" color="text.secondary">
            Checked against its schema before anything runs.
          </Typography>
        </Box>
      </Card>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography variant="h6" component="h2">
            What will run
          </Typography>
          <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1.25 }}>
            {steps.map((step, i) => (
              <Box component="li" key={`${String(i)}-${step.product}`} sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
                <Box sx={{ flex: "0 0 26px", height: 26, borderRadius: "50%", bgcolor: "info.light", color: "info.main", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {i + 1}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {step.product}
                    {step.action && ` · ${step.action}`}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {step.team || runnable.team}&apos;s product, as its own identity
                  </Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Card>
        <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography variant="h6" component="h2">
            Good to know
          </Typography>
          <Typography variant="body2">
            {runnable.team} sets which identity and secrets each step uses. You can&apos;t change them, and you never see their values.
          </Typography>
          {runnable.sourceUrl && (
            <Link href={runnable.sourceUrl} target="_blank" rel="noopener noreferrer" variant="body2">
              Its definition in the catalog ↗
            </Link>
          )}
        </Card>
      </Box>
    </Box>
  );
}

/**
 * Running a template, or an action on its own (?template=<team>/<name> or
 * ?action=<product>): a form from its schema, which of your teams it runs
 * for when its sharing needs one, and what will run. Nothing else is chosen
 * here: each step's image, identity, secrets and namespace are its
 * product's (../../src/core/templates.ts). On success it opens the run.
 */
export function RunFormPage() {
  const [params] = useSearchParams();
  const [runnables, setRunnables] = useState<Runnable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const template = params.get("template");
  const action = params.get("action");

  useEffect(() => {
    listRunnables()
      .then(setRunnables)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the catalog."); });
  }, []);

  const runnable = runnables?.find((r) => (template ? r.kind === "template" && `${r.team}/${r.name}` === template : r.kind === "action" && r.name === action));
  const problem =
    error ??
    (runnables && !runnable ? `Nothing called "${template ?? action ?? ""}" is in the catalog for you.` : null) ??
    (runnable && !runnable.shared ? `"${runnable.displayName}" isn't shared with you: ask ${runnable.team} for access.` : null);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/catalog">
          Catalog
        </Link>{" "}
        / {runnable?.displayName ?? template ?? action}
      </Typography>
      {runnable && (
        <>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, mt: 0.75 }}>
            <Typography variant="h4" component="h1">
              {runnable.displayName}
            </Typography>
            {runnable.deprecated && (
              <Pill tone="warning" title={runnable.deprecated}>
                Deprecated
              </Pill>
            )}
          </Box>
          <Typography color="text.secondary" sx={{ mt: 0.5, mb: 3, maxWidth: 840 }}>
            {runnable.team} · {runnable.kind}
            {runnable.description && ` · ${runnable.description}`}
          </Typography>
          {runnable.deprecated && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Deprecated: {runnable.deprecated}
            </Alert>
          )}
        </>
      )}
      {problem && (
        <Alert severity="error" sx={{ my: 2 }}>
          {problem}
        </Alert>
      )}
      {!runnables && !error && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={28} aria-label="Loading" />
        </Box>
      )}
      {runnable?.shared && <RunForm key={`${runnable.kind}:${runnable.team}/${runnable.name}`} runnable={runnable} />}
    </Box>
  );
}
