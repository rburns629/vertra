// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import {
  allowedPrefixes,
  imageRefusal,
  invalidSourceReason,
  isBroadSource,
  isImageAllowed,
  normalizeImage,
  type ImagePolicy,
} from "../src/imagePolicy.js";
import { buildApp } from "../src/index.js";
import { submitExecution } from "../src/kernel/client.js";
import { ImagePolicyConflictError, writeImagePolicyData } from "../src/k8s.js";

// The cluster's policy is the only thing faked: `stored` plays it.
let stored: { source: string; additional: string[]; version: string } | null;
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  readImagePolicyData: vi.fn(() => Promise.resolve(stored)),
  writeImagePolicyData: vi.fn(),
}));
vi.mock("../src/kernel/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/client.js")>();
  const { randomUUID: uuid } = await import("node:crypto");
  return { ...actual, submitExecution: vi.fn(() => Promise.resolve({ executionId: uuid(), state: "PENDING", created: true })) };
});

const SOURCE = "us-central1-docker.pkg.dev/proj/catalog-products";

function policy(source: string, additional: string[] = []): ImagePolicy {
  return { exists: true, source, additional, version: "1" };
}

describe("the rules (the same ones image-policy.yaml's CEL applies)", () => {
  const prefixes = allowedPrefixes(policy(SOURCE, ["docker.io/library"]));

  it.each([
    [`${SOURCE}/app:1`, true],
    [`${SOURCE}-evil/app:1`, false],
    ["us-central1-docker.pkg.dev/other/catalog-products/app:1", false],
    ["node:20", true],
    ["docker.io/library/python:3.12", true],
    ["team/app:1", false],
    ["docker.io/evil/app", false],
    ["localhost:5001/app:1", false],
  ])("%s allowed: %s", (image, allowed) => {
    expect(isImageAllowed(image, prefixes)).toBe(allowed);
  });

  it("reads short names the way the kubelet does", () => {
    expect(normalizeImage("node:20")).toBe("docker.io/library/node:20");
    expect(normalizeImage("team/app")).toBe("docker.io/team/app");
    expect(normalizeImage("localhost:5001/app")).toBe("localhost:5001/app");
  });

  it("only accepts registry paths as sources, and flags whole-registry ones", () => {
    expect(invalidSourceReason(SOURCE)).toBeNull();
    expect(invalidSourceReason("https://localhost:5001")).toBeNull();
    expect(invalidSourceReason("catalog-products")).toMatch(/registry host/);
    expect(invalidSourceReason(`${SOURCE}/app:1`)).toMatch(/tag/);
    expect(invalidSourceReason(`${SOURCE}/app@sha256:abc`)).toMatch(/digest/);
    expect(invalidSourceReason("   ")).toMatch(/empty/);
    // Written into the policy as a CEL string literal: nothing that could close it.
    expect(invalidSourceReason('localhost:5001/x"+"y')).toMatch(/letters, digits/);
    expect(invalidSourceReason("localhost:5001/x\\")).toMatch(/letters, digits/);
    expect(isBroadSource("docker.io")).toBe(true);
    expect(isBroadSource("docker.io/library")).toBe(false);
  });

  it("explains a refusal, naming what is allowed", () => {
    const refusal = imageRefusal(["docker.io/evil/app", `${SOURCE}/ok:1`], policy(SOURCE));
    expect(refusal?.error).toBe("IMAGE_NOT_ALLOWED");
    expect(refusal?.disallowedImages).toEqual(["docker.io/evil/app"]);
    expect(refusal?.message).toContain(`Allowed: ${SOURCE}/`);
  });

  it("refuses everything until a source is configured", () => {
    expect(imageRefusal([`${SOURCE}/ok:1`], policy(""))?.error).toBe("IMAGE_POLICY_NOT_CONFIGURED");
    const missing = imageRefusal(["x"], { exists: false, source: "", additional: [], version: "" });
    expect(missing?.message).toContain("image policy doesn't exist");
  });
});

describe("the routes", () => {
  const prefix = `imgpol-${randomUUID().slice(0, 6)}`;
  const emails: string[] = [];
  let app: FastifyInstance;
  let admin: string;
  let member: string;
  let teamName: string;

  async function newUser(isAdmin: boolean): Promise<string> {
    const email = `${prefix}-${randomUUID()}@example.com`;
    emails.push(email);
    const user = await createUser(email, await hashPassword("correct-horse-battery"));
    if (isAdmin) await setUserAdmin(user.id, true);
    return user.id;
  }

  function as(userId: string, method: "GET" | "PUT" | "POST", url: string, payload?: object) {
    return app.inject({ method, url, headers: { authorization: `Bearer ${app.jwt.sign({ userId })}` }, payload });
  }

  function submit(image: string) {
    return as(member, "POST", "/api/executions", {
      name: "img", requestId: randomUUID(),
      tasks: [{ id: "t", image, action: "create", team: teamName }],
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    admin = await newUser(true);
    member = await newUser(false);
    teamName = `${prefix}-team`;
    const team = await createTeam(teamName);
    await addTeamMember(member, team.id);
  });

  beforeEach(() => {
    stored = { source: `${SOURCE}/`, additional: [], version: "7" };
    vi.mocked(submitExecution).mockClear();
    vi.mocked(writeImagePolicyData).mockReset().mockResolvedValue("8");
  });

  afterAll(async () => {
    await app.close();
    await db.delete(teams).where(inArray(teams.name, [teamName]));
    await db.delete(users).where(inArray(users.email, emails));
  });

  it("refuses a submission from outside the allowed sources and says what's allowed", async () => {
    const response = await submit("docker.io/evil/app:1");
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: string; message: string; allowedSources: string[] }>();
    expect(body.error).toBe("IMAGE_NOT_ALLOWED");
    expect(body.allowedSources).toEqual([`${SOURCE}/`]);
    expect(submitExecution).not.toHaveBeenCalled();
  });

  it("refuses everything while no source is configured", async () => {
    stored = { source: "", additional: [], version: "7" };
    const response = await submit(`${SOURCE}/app:1`);
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("IMAGE_POLICY_NOT_CONFIGURED");
  });

  it("lets anyone signed in read the sources, but only admins change them", async () => {
    const read = await as(member, "GET", "/api/image-policy");
    expect(read.statusCode).toBe(200);
    expect(read.json<{ allowed: string[] }>().allowed).toEqual([`${SOURCE}/`]);

    const change = { source: SOURCE, additional: ["docker.io/library"], version: "7" };
    expect((await as(member, "PUT", "/api/image-policy", change)).statusCode).toBe(403);
    expect(writeImagePolicyData).not.toHaveBeenCalled();

    const saved = await as(admin, "PUT", "/api/image-policy", change);
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ allowed: string[] }>().allowed).toEqual([`${SOURCE}/`, "docker.io/library/"]);
    expect(writeImagePolicyData).toHaveBeenCalledWith(
      "kernel-execution-kernel-image",
      { source: `${SOURCE}/`, additional: ["docker.io/library/"] },
      "7",
    );
  });

  it("rejects an invalid source, and a save based on a stale version", async () => {
    const bad = await as(admin, "PUT", "/api/image-policy", { source: "catalog-products", additional: [], version: "7" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ message: string }>().message).toContain("registry host");

    vi.mocked(writeImagePolicyData).mockRejectedValueOnce(new ImagePolicyConflictError("stale"));
    const stale = await as(admin, "PUT", "/api/image-policy", { source: SOURCE, additional: [], version: "6" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ message: string }>().message).toContain("Reload");
  });

  it("says so when the cluster's policy itself is missing", async () => {
    stored = null;
    const response = await as(admin, "PUT", "/api/image-policy", { source: SOURCE, additional: [], version: "7" });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("IMAGE_POLICY_MISSING");
  });
});
