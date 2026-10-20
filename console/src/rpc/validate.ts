// SPDX-License-Identifier: MIT
/**
 * Checking a request message's fields against the same TypeBox schemas the
 * REST routes declare (NewPassword, SecretName, ...), so both paths accept
 * exactly the same input. Fastify validated REST bodies itself; Connect
 * hands a handler its decoded message, which the handler checks here.
 */
import { FormatRegistry, OptionalKind, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { invalidArgument, type ProblemInit } from "./errors.js";

/**
 * Every `format` the routes' schemas use, checked as Fastify's routes check
 * them: ajv-formats, in its default ("fast") mode. TypeBox knows no format
 * it isn't told about, and fails every value of one it doesn't know.
 */
export const FORMATS: Record<string, RegExp> = {
  email:
    /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
  uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  "date-time":
    /^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i,
};
for (const [name, pattern] of Object.entries(FORMATS)) {
  if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, (value) => pattern.test(value));
}

/** The problems with `value` against `schema`, each named `field` (plus its path within). */
export function problemsWith(schema: TSchema, value: unknown, field: string): ProblemInit[] {
  return [...Value.Errors(schema, value)].map((error) => ({
    field: field + (error.path && error.path !== "/" ? error.path.replaceAll("/", ".") : ""),
    code: "INVALID",
    message: error.message,
  }));
}

/**
 * Checks each field against its schema and throws invalid_argument with
 * every problem found, or returns the fields typed as their schemas say.
 * A field whose schema is Type.Optional may be unset (a proto3 `optional`
 * the caller left out): TypeBox's Optional only means that as an object's
 * property, so it's applied here.
 */
export function check<S extends Record<string, TSchema>>(
  schemas: S,
  values: { [K in keyof S]: unknown },
): { [K in keyof S]: Static<S[K]> } {
  const problems = Object.entries(schemas).flatMap(([field, schema]) =>
    values[field] === undefined && OptionalKind in schema ? [] : problemsWith(schema, values[field], field),
  );
  if (problems.length > 0) throw invalidArgument(problems);
  return values;
}
