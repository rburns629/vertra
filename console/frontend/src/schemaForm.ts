// SPDX-License-Identifier: MIT
/**
 * A run form from a template's parameter schema (or an action's input
 * schema): JSON Schema for an object, as the catalog's teams write it. Each
 * property becomes a field: text, a number, a yes/no, a choice from its
 * enum, or JSON for anything richer. A schema with no properties to show
 * gets one JSON box for the whole object. The server checks the result
 * against the full schema (../../src/core/templates.ts); this only builds
 * the form, converts what's typed, and puts the server's problems back on
 * their fields.
 */

export type FieldKind = "text" | "number" | "integer" | "boolean" | "choice" | "json";

export interface Field {
  name: string;
  kind: FieldKind;
  label: string;
  description: string | undefined;
  required: boolean;
  /** For a choice: its allowed values. */
  choices: unknown[];
  /** Long text gets a bigger box. */
  multiline: boolean;
}

/** What's typed, per field: text for every kind but a yes/no. */
export type Values = Record<string, string | boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(property: Record<string, unknown>): FieldKind {
  if (Array.isArray(property["enum"]) && property["enum"].length > 0) return "choice";
  switch (property["type"]) {
    case "string":
      return "text";
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

/** The form's fields, or null when the schema has no properties to show (edit it as JSON). */
export function fieldsOf(schema: Record<string, unknown>): Field[] | null {
  const properties = schema["properties"];
  if (!isRecord(properties) || Object.keys(properties).length === 0) return null;
  const required = new Set(Array.isArray(schema["required"]) ? schema["required"].map(String) : []);
  return Object.entries(properties).map(([name, raw]) => {
    const property = isRecord(raw) ? raw : {};
    const kind = kindOf(property);
    const maxLength = typeof property["maxLength"] === "number" ? property["maxLength"] : undefined;
    return {
      name,
      kind,
      label: typeof property["title"] === "string" ? property["title"] : name,
      description: typeof property["description"] === "string" ? property["description"] : undefined,
      required: required.has(name),
      choices: kind === "choice" ? (property["enum"] as unknown[]) : [],
      multiline: kind === "json" || (kind === "text" && (maxLength === undefined || maxLength > 200)),
    };
  });
}

/** The form's starting values: each property's default, else empty. */
export function initialValues(schema: Record<string, unknown>, fields: Field[]): Values {
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const values: Values = {};
  for (const field of fields) {
    const property = properties[field.name];
    const fallback = isRecord(property) ? property["default"] : undefined;
    if (field.kind === "boolean") values[field.name] = fallback === true;
    else if (fallback === undefined) values[field.name] = "";
    else values[field.name] = field.kind === "text" && typeof fallback === "string" ? fallback : JSON.stringify(fallback);
  }
  return values;
}

/**
 * What's typed as the parameters, each value its field's type, or what's
 * wrong with each field that can't be read. An empty field is left out (the
 * schema decides whether that's allowed); a yes/no is always sent.
 */
export function toParameters(fields: Field[], values: Values): { parameters: Record<string, unknown>; errors: Record<string, string> } {
  const parameters: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "boolean") {
      parameters[field.name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value : "";
    if (text.trim() === "") {
      if (field.required) errors[field.name] = "Required.";
      continue;
    }
    switch (field.kind) {
      case "text":
        parameters[field.name] = text;
        break;
      case "number":
      case "integer": {
        const n = Number(text);
        if (!Number.isFinite(n) || (field.kind === "integer" && !Number.isInteger(n))) {
          errors[field.name] = field.kind === "integer" ? "A whole number." : "A number.";
        } else parameters[field.name] = n;
        break;
      }
      case "choice":
        // Choices are kept as their JSON, so a number or true stays one.
        parameters[field.name] = JSON.parse(text) as unknown;
        break;
      case "json":
        try {
          parameters[field.name] = JSON.parse(text) as unknown;
        } catch {
          errors[field.name] = "Not valid JSON.";
        }
        break;
    }
  }
  return { parameters, errors };
}

/**
 * The server's problems with the parameters (its Problem details:
 * `{field: "parameters.text", message}`) on their fields, and those about
 * the whole object (a missing or unexpected property) apart.
 */
export function serverProblems(problems: { field: string; message: string }[]): { fields: Record<string, string>; general: string[] } {
  const fields: Record<string, string> = {};
  const general: string[] = [];
  for (const { field, message } of problems) {
    const name = field.replace(/^parameters\.?/, "").split(".")[0];
    if (name) fields[name] = fields[name] ? `${fields[name]}; ${message}` : message;
    else general.push(message);
  }
  return { fields, general };
}
