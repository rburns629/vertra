// SPDX-License-Identifier: MIT
/**
 * The API reference (frontend/src/gen/api-reference.json, written by
 * `make proto` from the protos) describes the API that's served: every
 * service the console mounts, and the same methods open to anyone.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC } from "../src/rpc/interceptors.js";

interface Reference {
  services: { fullName: string; comment: string; methods: { name: string; comment: string; public: boolean }[] }[];
}

const reference = JSON.parse(readFileSync("frontend/src/gen/api-reference.json", "utf-8")) as Reference;
const procedures = reference.services.flatMap((s) => s.methods.map((m) => ({ ...m, procedure: `${s.fullName}/${m.name}` })));

describe("the API reference", () => {
  it("marks exactly the methods the console lets anyone call", () => {
    expect(procedures.filter((m) => m.public).map((m) => m.procedure).sort()).toEqual([...PUBLIC].sort());
  });

  it("documents every service and method", () => {
    expect(reference.services.filter((s) => !s.comment).map((s) => s.fullName)).toEqual([]);
    expect(procedures.filter((m) => !m.comment).map((m) => m.procedure)).toEqual([]);
  });
});
