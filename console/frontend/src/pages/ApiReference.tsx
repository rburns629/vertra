// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Markdown from "react-markdown";
import { Mono } from "../components/Mono";
import { ApiError, getOpenApi, type OpenApiOperation, type OpenApiSchema, type OpenApiSpec } from "../api";

/** The Docs page's id for this page; no guide may use it. */
export const API_REFERENCE_ID = "api-reference";

const METHOD_COLOR: Record<string, "success" | "primary" | "warning" | "error" | "default"> = {
  get: "success",
  post: "primary",
  put: "warning",
  patch: "warning",
  delete: "error",
};


/** "string", "string or null", "array of object", ... */
function typeName(schema: OpenApiSchema | undefined): string {
  if (!schema) return "any";
  if (schema.anyOf) return schema.anyOf.map(typeName).join(" or ");
  const type = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
  if (type === "array") return `list of ${typeName(schema.items)}`;
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (!type) return "any";
  return schema.format ? `${type} (${schema.format})` : type;
}

interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** An object schema's fields, one level of nesting shown as parent.child
 * (or parent[].child for a list of objects). */
function fieldRows(schema: OpenApiSchema | undefined, prefix = "", depth = 0): FieldRow[] {
  const target = schema?.type === "array" ? schema.items : schema;
  if (!target?.properties) return [];
  const rows: FieldRow[] = [];
  for (const [name, field] of Object.entries(target.properties)) {
    const path = `${prefix}${name}`;
    rows.push({
      name: path,
      type: typeName(field),
      required: Boolean(target.required?.includes(name)),
      description: field.description ?? "",
    });
    const nested = field.type === "array" ? field.items : field;
    if (depth < 1 && nested?.properties) {
      rows.push(...fieldRows(field, field.type === "array" ? `${path}[].` : `${path}.`, depth + 1));
    }
  }
  return rows;
}

function FieldTable({ rows }: { rows: FieldRow[] }) {
  if (rows.length === 0) return null;
  return (
    <Box
      component="table"
      sx={{
        width: "100%",
        borderCollapse: "collapse",
        "& th, & td": { border: 1, borderColor: "divider", p: 1, textAlign: "left", verticalAlign: "top", fontSize: 14 },
        "& th": { bgcolor: "action.hover", fontWeight: 600 },
      }}
    >
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td>
              <Mono>
                {row.name}
              </Mono>
              {row.required && (
                <Typography component="span" variant="caption" color="error" sx={{ ml: 0.5 }}>
                  required
                </Typography>
              )}
            </td>
            <td>
              <Mono>
                {row.type}
              </Mono>
            </td>
            <td>{row.description}</td>
          </tr>
        ))}
      </tbody>
    </Box>
  );
}

function jsonSchema(content: Record<string, { schema?: OpenApiSchema }> | undefined): OpenApiSchema | undefined {
  return content?.["application/json"]?.schema ?? Object.values(content ?? {})[0]?.schema;
}

function OperationView({ method, path, operation }: { method: string; path: string; operation: OpenApiOperation }) {
  const parameters = operation.parameters ?? [];
  const body = jsonSchema(operation.requestBody?.content);
  const responses = Object.entries(operation.responses ?? {});
  const ok = responses.filter(([status]) => status.startsWith("2"));
  const errors = responses.filter(([status]) => !status.startsWith("2")).map(([status]) => status);

  return (
    <Accordion disableGutters variant="outlined" sx={{ "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", minWidth: 0 }}>
          <Chip
            label={method.toUpperCase()}
            size="small"
            color={METHOD_COLOR[method] ?? "default"}
            sx={{ fontWeight: 700, minWidth: 64 }}
          />
          <Mono sx={{ overflowWrap: "anywhere" }}>
            {path}
          </Mono>
          <Typography variant="body2" color="text.secondary">
            {operation.summary}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          {operation.description && (
            <Box sx={{ "& p": { m: 0, mb: 1 } }}>
              <Markdown>{operation.description}</Markdown>
            </Box>
          )}
          {parameters.length > 0 && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Parameters
              </Typography>
              <FieldTable
                rows={parameters.map((p) => ({
                  name: `${p.name} (${p.in})`,
                  type: typeName(p.schema),
                  required: Boolean(p.required),
                  description: p.description ?? p.schema?.description ?? "",
                }))}
              />
            </Box>
          )}
          {body && (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Request body {body.description ? `· ${body.description}` : ""}
              </Typography>
              <FieldTable rows={fieldRows(body)} />
            </Box>
          )}
          {ok.map(([status, response]) => {
            const schema = jsonSchema(response.content);
            const rows = fieldRows(schema);
            return (
              <Box key={status}>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  {status} response
                  {schema?.type === "array" ? " · a list of:" : ""}
                  {status === "204" ? " · no content" : ""}
                </Typography>
                {rows.length > 0 ? (
                  <FieldTable rows={rows} />
                ) : (
                  schema?.description && <Typography variant="body2">{schema.description}</Typography>
                )}
              </Box>
            );
          })}
          {errors.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              Errors: {errors.join(", ")}, each as <Mono>{'{"error": "<CODE>", "message": "…"}'}</Mono>.
            </Typography>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

/** The console API, from its own OpenAPI description (GET /api/openapi.json). */
export function ApiReference() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getOpenApi()
      .then(setSpec)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load the API description.");
      });
  }, []);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!spec) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={24} aria-label="Loading" />
      </Box>
    );
  }

  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
  );

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 700, mb: 1 }}>
          API reference
        </Typography>
        {spec.info.description && (
          <Box sx={{ "& code": { fontFamily: "fontFamilyMono", fontSize: "0.92em" } }}>
            <Markdown>{spec.info.description}</Markdown>
          </Box>
        )}
        <Typography variant="body2" color="text.secondary">
          Generated from the console's own routes. The raw description is at{" "}
          <Mono>
            /api/openapi.json
          </Mono>{" "}
          (OpenAPI 3), for tools that read it.
        </Typography>
      </Box>
      {(spec.tags ?? []).map((tag) => {
        const inTag = operations.filter((o) => o.operation.tags?.includes(tag.name));
        if (inTag.length === 0) return null;
        return (
          <Box key={tag.name}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {tag.name}
            </Typography>
            {tag.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {tag.description}
              </Typography>
            )}
            <Stack spacing={1}>
              {inTag.map(({ path, method, operation }) => (
                <OperationView key={`${method} ${path}`} method={method} path={path} operation={operation} />
              ))}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}
