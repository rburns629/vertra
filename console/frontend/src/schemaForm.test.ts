// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { fieldsOf, initialValues, serverProblems, toParameters, withTargets } from "./schemaForm";

const schema = {
  type: "object",
  required: ["text", "count"],
  properties: {
    text: { type: "string", title: "Text", description: "What to say.", maxLength: 1000 },
    count: { type: "integer", default: 2 },
    loud: { type: "boolean" },
    colour: { enum: ["red", "blue", 3] },
    labels: { type: "object" },
  },
};

describe("a run form from a schema", () => {
  it("has a field per property, of its kind, with the schema's title, description and required", () => {
    const fields = fieldsOf(schema);
    expect(fields?.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["text", "text", true],
      ["count", "integer", true],
      ["loud", "boolean", false],
      ["colour", "choice", false],
      ["labels", "json", false],
    ]);
    expect(fields?.[0]).toMatchObject({ label: "Text", description: "What to say.", multiline: true });
    expect(fields?.[3]?.choices).toEqual(["red", "blue", 3]);
  });

  it("is one JSON box when the schema has no properties", () => {
    expect(fieldsOf({ type: "object" })).toBeNull();
  });

  it("starts from each property's default", () => {
    const fields = fieldsOf(schema) ?? [];
    expect(initialValues(schema, fields)).toEqual({ text: "", count: "2", loud: false, colour: "", labels: "" });
  });

  it("sends each value as its type, leaves empty ones out, and says what can't be read", () => {
    const fields = fieldsOf(schema) ?? [];
    expect(toParameters(fields, { text: "hi", count: "3", loud: true, colour: "3", labels: '{"a":1}' })).toEqual({
      parameters: { text: "hi", count: 3, loud: true, colour: 3, labels: { a: 1 } },
      errors: {},
    });
    expect(toParameters(fields, { text: "", count: "2.5", loud: false, colour: "", labels: "{" }).errors).toEqual({
      text: "Required.",
      count: "A whole number.",
      labels: "Not valid JSON.",
    });
  });

  it("puts the server's problems on their fields, and the whole object's apart", () => {
    expect(
      serverProblems([
        { field: "parameters.text", message: "must NOT have more than 10 characters" },
        { field: "parameters", message: "must have required property 'count'" },
      ]),
    ).toEqual({ fields: { text: "must NOT have more than 10 characters" }, general: ["must have required property 'count'"] });
  });
});

describe("target parameters", () => {
  const fields = fieldsOf({ type: "object", properties: { projectId: { type: "string" }, name: { type: "string" } } });

  it("are a choice when their team allows exact values, and the rest is untouched", () => {
    const out = withTargets(fields, [{ parameter: "projectId", type: "gcp.project", allowed: ["apps-dev", "apps-prod"] }]);
    expect(out?.find((f) => f.name === "projectId")).toMatchObject({ kind: "choice", choices: ["apps-dev", "apps-prod"] });
    expect(out?.find((f) => f.name === "name")).toEqual(fields?.find((f) => f.name === "name"));
  });

  it("say what's allowed when it's a pattern, or that nothing is", () => {
    const patterned = withTargets(fields, [{ parameter: "projectId", type: "gcp.project", allowed: ["apps-*"] }]);
    expect(patterned?.find((f) => f.name === "projectId")).toMatchObject({ kind: "text", description: expect.stringContaining("apps-*") });
    const none = withTargets(fields, [{ parameter: "projectId", type: "gcp.project", allowed: [] }]);
    expect(none?.find((f) => f.name === "projectId")?.description).toContain("hasn't let yours");
  });
});

