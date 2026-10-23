// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import type { Field, FieldValue } from "../../schemaForm";

type Change = (name: string, value: FieldValue) => void;

const n = (value: number) => value.toLocaleString();

/**
 * The rules a field's value must meet, as a hint beneath it: its pattern's
 * meaning always, its lengths and limits only when the team's description
 * doesn't already say what it takes.
 */
function hintOf(field: Field): string | undefined {
  const r = field.rules;
  const parts: string[] = [];
  if (!field.description) {
    if (r.minLength !== undefined && r.maxLength !== undefined) parts.push(`${n(r.minLength)}–${n(r.maxLength)} characters`);
    else if (r.maxLength !== undefined) parts.push(`At most ${n(r.maxLength)} characters`);
    else if (r.minLength !== undefined) parts.push(`At least ${n(r.minLength)} characters`);
    if (r.minimum !== undefined && r.maximum !== undefined) parts.push(`${n(r.minimum)} to ${n(r.maximum)}`);
  }
  if (r.patternMessage) parts.push(r.patternMessage.replace(/\.$/, ""));
  return parts.length > 0 ? `${parts.join(". ")}.` : undefined;
}

function Help({ field, error }: { field: Field; error: string | undefined }) {
  const text = error ?? [field.description, hintOf(field)].filter(Boolean).join(" ");
  if (!text) return null;
  return (
    <Typography variant="caption" color={error ? "error" : "text.secondary"} sx={{ display: "block", mt: 0.5, mx: 1.75 }}>
      {text}
    </Typography>
  );
}

/** A list's items, a row each, with Add. */
function ListInput({ field, items, error, onChange }: { field: Field; items: string[]; error: string | undefined; onChange: Change }) {
  const rows = items.length > 0 ? items : [""];
  const set = (next: string[]) => { onChange(field.name, next); };
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
      <Typography component="legend" variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
        {field.label}
        {field.required && " *"}
      </Typography>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {rows.map((item, i) => (
          <Box key={i} sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <TextField
              size="small"
              fullWidth
              value={item}
              error={error !== undefined}
              type={field.itemKind === "text" ? undefined : "number"}
              slotProps={{ htmlInput: { "aria-label": `${field.label}, item ${String(i + 1)}` } }}
              onChange={(e) => { set(rows.map((v, j) => (j === i ? e.target.value : v))); }}
            />
            <IconButton aria-label={`Remove item ${String(i + 1)}`} onClick={() => { set(rows.filter((_, j) => j !== i)); }} disabled={rows.length === 1 && item === ""}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
        ))}
      </Box>
      <Button size="small" startIcon={<AddIcon />} sx={{ mt: 0.5 }} onClick={() => { set([...rows, ""]); }}>
        Add
      </Button>
      <Help field={field} error={error} />
    </Box>
  );
}

/** Name/value pairs, a row each, with Add. */
function MapInput({ field, pairs, error, onChange }: { field: Field; pairs: [string, string][]; error: string | undefined; onChange: Change }) {
  const rows: [string, string][] = pairs.length > 0 ? pairs : [["", ""]];
  const set = (next: [string, string][]) => { onChange(field.name, next); };
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, minWidth: 0 }}>
      <Typography component="legend" variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
        {field.label}
        {field.required && " *"}
      </Typography>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {rows.map(([name, value], i) => (
          <Box key={i} sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <TextField
              size="small"
              placeholder="Name"
              value={name}
              error={error !== undefined}
              slotProps={{ htmlInput: { "aria-label": `${field.label}, name ${String(i + 1)}` } }}
              onChange={(e) => { set(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r))); }}
              sx={{ flex: "1 1 40%" }}
            />
            <TextField
              size="small"
              placeholder="Value"
              value={value}
              slotProps={{ htmlInput: { "aria-label": `${field.label}, value ${String(i + 1)}` } }}
              onChange={(e) => { set(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r))); }}
              sx={{ flex: "1 1 60%" }}
            />
            <IconButton aria-label={`Remove pair ${String(i + 1)}`} onClick={() => { set(rows.filter((_, j) => j !== i)); }} disabled={rows.length === 1 && !name && !value}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
        ))}
      </Box>
      <Button size="small" startIcon={<AddIcon />} sx={{ mt: 0.5 }} onClick={() => { set([...rows, ["", ""]]); }}>
        Add
      </Button>
      <Help field={field} error={error} />
    </Box>
  );
}

/** One field of a run form, by its kind. */
export function FieldInput({ field, value, error, onChange }: { field: Field; value: FieldValue | undefined; error: string | undefined; onChange: Change }) {
  if (field.kind === "list") return <ListInput field={field} items={Array.isArray(value) ? (value as string[]) : []} error={error} onChange={onChange} />;
  if (field.kind === "map") return <MapInput field={field} pairs={Array.isArray(value) ? (value as [string, string][]) : []} error={error} onChange={onChange} />;
  if (field.kind === "boolean") {
    return (
      <Box>
        <FormControlLabel control={<Switch checked={value === true} onChange={(e) => { onChange(field.name, e.target.checked); }} />} label={field.label} />
        <Help field={field} error={error} />
      </Box>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <Box>
      <TextField
        select={field.kind === "choice"}
        fullWidth
        label={field.label}
        value={text}
        required={field.required}
        error={error !== undefined}
        multiline={field.kind !== "choice" && field.multiline}
        minRows={field.multiline ? 3 : undefined}
        type={field.kind === "number" || field.kind === "integer" ? "number" : undefined}
        slotProps={field.kind === "json" ? { htmlInput: { spellCheck: false, style: { fontFamily: "monospace" } } } : undefined}
        onChange={(e) => { onChange(field.name, e.target.value); }}
      >
        {field.kind === "choice" &&
          [...(field.required ? [] : [undefined]), ...field.choices].map((choice) => (
            <MenuItem key={choice === undefined ? "" : JSON.stringify(choice)} value={choice === undefined ? "" : JSON.stringify(choice)}>
              {choice === undefined ? "None" : String(choice)}
            </MenuItem>
          ))}
      </TextField>
      <Help field={field} error={error} />
      {field.kind === "json" && !error && !field.description && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5, mx: 1.75 }}>
          JSON.
        </Typography>
      )}
    </Box>
  );
}
