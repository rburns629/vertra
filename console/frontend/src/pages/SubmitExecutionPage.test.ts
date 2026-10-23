// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import type { Product } from "../api";
import { withStep } from "./SubmitExecutionPage";

const product = {
  name: "local-upper-case-transform",
  teamName: "local",
  image: `localhost:5001/local/upper-case@sha256:${"9".repeat(64)}`,
  action: "transform",
  serviceAccount: null,
  inputSchema: { type: "object", required: ["text", "mode"], properties: { text: { type: "string" }, mode: { type: "string", default: "plain" } } },
} as unknown as Product;

describe("adding a step to a DAG", () => {
  it("starts a DAG with the product's latest image and its required inputs to fill in", () => {
    const dag = load(withStep("", product) ?? "") as { tasks: Record<string, unknown>[] };
    expect(dag.tasks).toEqual([
      { id: "upper-case-transform", image: `localhost:5001/local/upper-case@sha256:${"9".repeat(64)}`, action: "transform", team: "local", inputs: { text: "", mode: "plain" } },
    ]);
  });

  it("adds to what's there, with an id of its own", () => {
    const once = withStep('{"name": "mine", "tasks": []}', product) ?? "";
    const dag = load(withStep(once, product) ?? "") as { name: string; tasks: { id: string }[] };
    expect(dag.name).toBe("mine");
    expect(dag.tasks.map((t) => t.id)).toEqual(["upper-case-transform", "upper-case-transform-2"]);
  });

  it("leaves a DAG it can't read alone", () => {
    expect(withStep("tasks: [", product)).toBeNull();
    expect(withStep("tasks: 3", product)).toBeNull();
  });
});
