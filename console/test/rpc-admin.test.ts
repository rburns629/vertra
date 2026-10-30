// SPDX-License-Identifier: MIT
/**
 * AdminService and ImageService through Connect: admins only (but the
 * allowed image sources, which anyone signed in may read), a stale image
 * policy refused, and Connect calls showing up in the audit log they read.
 * The rules themselves are tested in depth elsewhere, through the same
 * core/admin.ts and core/images.ts.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ImagePolicyConflictError, writeImagePolicyData } from "../src/k8s.js";
import { buildApp } from "../src/index.js";
import { config } from "../src/config.js";
import { failureCode, rpcClient, type RpcError } from "./rpc.js";

// The cluster's image policy is the only thing faked: `stored` plays it.
let stored: { source: string; additional: string[]; version: string } | null = {
  source: "registry.example/catalog",
  additional: [],
  version: "7",
};
vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  readImagePolicyData: vi.fn(() => Promise.resolve(stored)),
  writeImagePolicyData: vi.fn(),
}));

let app: FastifyInstance;
const { rpc, makeUser, signIn, cleanUp } = rpcClient(() => app);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanUp();
});

describe("admins only", () => {
  it.each([
    ["AdminService", "GetStats"],
    ["AdminService", "ListAuditEntries"],
    ["AdminService", "GetPolicySync"],
    ["AdminService", "GetInstall"],
    ["ImageService", "ListImageScans"],
  ])("%s.%s refuses anyone else", async (service, method) => {
    const token = await signIn((await makeUser()).email);
    const response = await rpc(service, method, {}, { token });
    expect(response.statusCode).toBe(403);
    expect(failureCode(response.json<RpcError>())).toBe("FORBIDDEN");
  });
});

describe("AdminService", () => {
  it("counts, and lists the audit log with Connect calls in it", async () => {
    const admin = await makeUser({ admin: true });
    const token = await signIn(admin.email);

    const stats = await rpc("AdminService", "GetStats", {}, { token });
    expect(Number(stats.json<{ users: string }>().users)).toBeGreaterThan(0);

    // A change made through Connect, then found through Connect.
    await rpc("UserService", "SetAdmin", { email: admin.email, admin: true }, { token });
    const page = await rpc("AdminService", "ListAuditEntries", { actorId: admin.id, limit: 5 }, { token });
    const entries = page.json<{ entries: { route: string; method: string; status: number }[] }>().entries;
    expect(entries[0]).toMatchObject({ route: "vertra.console.v1.UserService/SetAdmin", method: "RPC", status: 200 });
  });

  it("says what this install is: its version and which optional parts are on", async () => {
    const token = await signIn((await makeUser({ admin: true })).email);
    const install = (await rpc("AdminService", "GetInstall", {}, { token })).json<Record<string, unknown>>();
    // The tests' settings: built locally, no catalog, no logs, no copy.
    expect(install).toMatchObject({ version: "development", catalog: false, logs: false, auditCopy: false });
    expect(Number(install["runRetentionDays"])).toBeGreaterThan(0);
  });

  it("names the install's settings, never a credential", async () => {
    const token = await signIn((await makeUser({ admin: true })).email);
    // As a chart would set them; restored after.
    const saved = structuredClone({ catalog: config.catalog, email: config.notifications.email, audit: config.audit, monitoring: config.monitoring });
    const savedSignatures = config.imageSignaturesRequired;
    Object.assign(config.catalog, {
      release: "us-docker.pkg.dev/other/vertra-products/catalog-release:v1.4.0",
      newestVersion: false,
      external: true,
      pollSeconds: 120,
      signature: { publicKeys: ["-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----"], keylessIssuer: "https://token.actions.githubusercontent.com", keylessSubjectRegExp: "^https://github.com/acme/catalog/" },
    });
    Object.assign(config.notifications.email, { host: "smtp.example.com", from: "Vertra <vertra@example.com>", username: "smtp-user", passwordFile: "/var/run/secrets/vertra/smtp/password" });
    Object.assign(config.audit.export, { bucket: "acme-audit", keepDays: 400, lock: true });
    Object.assign(config.monitoring, { provider: "google", grafanaUrl: "https://grafana.example.com" });
    config.imageSignaturesRequired = true;
    try {
      const response = await rpc("AdminService", "GetInstall", {}, { token });
      const install = response.json<Record<string, unknown>>();
      expect(install).toMatchObject({
        catalogVersion: "v1.4.0",
        catalogPollSeconds: 120,
        catalogSignerKeys: 1,
        catalogKeylessIssuer: "https://token.actions.githubusercontent.com",
        catalogKeylessSubject: "^https://github.com/acme/catalog/",
        externalCatalog: "us-docker.pkg.dev/other/vertra-products",
        email: true,
        emailHost: "smtp.example.com",
        emailFrom: "Vertra <vertra@example.com>",
        monitoringProvider: "google",
        grafanaUrl: "https://grafana.example.com",
        sessionLength: config.jwtTtl,
        auditKeepDays: 400,
        auditLock: true,
        imageSignaturesRequired: true,
      });
      expect(Number(install["policySyncSeconds"])).toBeGreaterThan(0);
      // Never the SMTP sign-in, the public keys themselves, or anything like a secret.
      expect(response.body).not.toContain("smtp-user");
      expect(response.body).not.toContain("/var/run/secrets");
      expect(response.body).not.toContain("BEGIN PUBLIC KEY");
      // Following the newest version instead of a tag.
      config.catalog.newestVersion = true;
      expect((await rpc("AdminService", "GetInstall", {}, { token })).json<Record<string, unknown>>()["catalogVersion"]).toBe("newest");
    } finally {
      Object.assign(config.catalog, saved.catalog);
      Object.assign(config.notifications.email, saved.email);
      Object.assign(config.audit.export, saved.audit.export);
      Object.assign(config.monitoring, saved.monitoring);
      config.imageSignaturesRequired = savedSignatures;
    }
  });

  it("checks the audit query", async () => {
    const token = await signIn((await makeUser({ admin: true })).email);
    const response = await rpc("AdminService", "ListAuditEntries", { actorId: "not-a-uuid", limit: 900 }, { token });
    expect(response.json<RpcError>().code).toBe("invalid_argument");
  });
});

describe("ImageService", () => {
  it("lets anyone signed in read the allowed sources", async () => {
    const token = await signIn((await makeUser()).email);
    const response = await rpc("ImageService", "GetImagePolicy", {}, { token });
    expect(response.statusCode).toBe(200);
    const policy = response.json<{ policy: { source: string; version: string; allowed: string[] } }>().policy;
    expect(policy).toMatchObject({ source: "registry.example/catalog/", version: "7" });
    expect(policy.allowed.length).toBeGreaterThan(0);

    const unsigned = await rpc("ImageService", "GetImagePolicy", {});
    expect(unsigned.statusCode).toBe(401);
  });

  it("refuses a change from a stale read", async () => {
    const token = await signIn((await makeUser({ admin: true })).email);
    vi.mocked(writeImagePolicyData).mockRejectedValueOnce(new ImagePolicyConflictError());
    const response = await rpc(
      "ImageService",
      "SetImagePolicy",
      { source: "registry.example/catalog", additional: [], version: "6" },
      { token },
    );
    expect(response.json<RpcError>().code).toBe("failed_precondition");
    expect(failureCode(response.json<RpcError>())).toBe("CONFLICT");
  });

  it("says when the cluster has no image policy", async () => {
    const token = await signIn((await makeUser({ admin: true })).email);
    const saved = stored;
    stored = null;
    try {
      const response = await rpc("ImageService", "SetImagePolicy", { source: "registry.example/x", additional: [], version: "1" }, { token });
      expect(failureCode(response.json<RpcError>())).toBe("IMAGE_POLICY_MISSING");
    } finally {
      stored = saved;
    }
  });
});
