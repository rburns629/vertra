// SPDX-License-Identifier: MIT
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, runRunnable, type Runnable } from "../api";
import { fieldsOf, initialValues, serverProblems, toParameters, type Field, type Values } from "../schemaForm";

/**
 * Runs a template, or an action on its own: a form from its parameter
 * schema, and which of your teams it runs for when its sharing needs one.
 * Nothing else is chosen here: each step's image, identity, secrets and
 * namespace are its product's (../../src/core/templates.ts). On success it
 * opens the run.
 */
export function RunDialog({ runnable, onClose }: { runnable: Runnable; onClose: () => void }) {
  const navigate = useNavigate();
  const fields = useMemo(() => fieldsOf(runnable.parameters), [runnable]);
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
        setErrors(["The parameters must be a JSON object."]);
        return;
      }
    }
    if (runnable.onBehalfOfRequired && !team) {
      setErrors(["Choose which of your teams it runs for."]);
      return;
    }
    setRunning(true);
    try {
      const executionId = await runRunnable(runnable, parameters, team || undefined);
      navigate(`/executions/${encodeURIComponent(executionId)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "INVALID_PARAMETERS") {
        const problems = serverProblems(err.problems);
        setFieldErrors(problems.fields);
        setErrors(problems.general.length > 0 || !fields ? [err.message] : []);
      } else {
        setErrors([err instanceof ApiError ? err.message : "Something went wrong. Try again."]);
      }
    } finally {
      setRunning(false);
    }
  }

  const set = (name: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldErrors((current) => {
      const { [name]: _cleared, ...rest } = current;
      return rest;
    });
  };

  return (
    <Dialog open onClose={running ? undefined : onClose} fullWidth maxWidth="sm">
      <form onSubmit={(event) => void run(event)} noValidate>
        <DialogTitle>Run {runnable.displayName}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {runnable.description && (
              <Typography variant="body2" color="text.secondary">
                {runnable.description}
              </Typography>
            )}
            {runnable.deprecated && <Alert severity="warning">Deprecated: {runnable.deprecated}</Alert>}
            {fields ? (
              fields.map((field) => (
                <FieldInput key={field.name} field={field} value={values[field.name]} error={fieldErrors[field.name]} onChange={set} />
              ))
            ) : (
              <TextField
                label="Parameters (JSON)"
                value={json}
                onChange={(event) => {
                  setJson(event.target.value);
                }}
                multiline
                minRows={4}
                slotProps={{ htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } }}
                helperText="A JSON object."
              />
            )}
            {(runnable.onBehalfOfRequired || runnable.onBehalfOf.length > 0) && (
              <TextField
                select
                label="Run for"
                value={team}
                onChange={(event) => {
                  setTeam(event.target.value);
                }}
                required={runnable.onBehalfOfRequired}
                helperText={
                  runnable.onBehalfOfRequired
                    ? "It's shared with specific teams: which of yours is this run for?"
                    : "Optional: which of your teams this run is for."
                }
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
            <Typography variant="caption" color="text.secondary">
              Its steps run as their products, with their own identities and secrets: you choose only what's above.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={running}>
            {running ? "Starting…" : "Run"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: Field;
  value: string | boolean | undefined;
  error: string | undefined;
  onChange: (name: string, value: string | boolean) => void;
}) {
  if (field.kind === "boolean") {
    return (
      <div>
        <FormControlLabel
          control={
            <Switch
              checked={value === true}
              onChange={(event) => {
                onChange(field.name, event.target.checked);
              }}
            />
          }
          label={field.label}
        />
        {(error ?? field.description) && (
          <Typography variant="caption" color={error ? "error" : "text.secondary"} sx={{ display: "block", ml: 6 }}>
            {error ?? field.description}
          </Typography>
        )}
      </div>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <TextField
      select={field.kind === "choice"}
      label={field.label}
      value={text}
      required={field.required}
      error={error !== undefined}
      helperText={error ?? field.description ?? (field.kind === "json" ? "JSON." : undefined)}
      multiline={field.kind !== "choice" && field.multiline}
      minRows={field.kind === "json" ? 3 : undefined}
      type={field.kind === "number" || field.kind === "integer" ? "number" : undefined}
      slotProps={field.kind === "json" ? { htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } } : undefined}
      onChange={(event) => {
        onChange(field.name, event.target.value);
      }}
    >
      {field.kind === "choice" &&
        [...(field.required ? [] : [undefined]), ...field.choices].map((choice) => (
          <MenuItem key={choice === undefined ? "" : JSON.stringify(choice)} value={choice === undefined ? "" : JSON.stringify(choice)}>
            {choice === undefined ? "None" : String(choice)}
          </MenuItem>
        ))}
    </TextField>
  );
}
