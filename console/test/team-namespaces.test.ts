// SPDX-License-Identifier: MIT
/**
 * The console managing team namespaces and SecretStores, so catalog CI needs
 * no cluster credentials: which calls reach Kubernetes, and who may make
 * them. Kubernetes is faked; what k8s.ts then does in the cluster, and what
 * the namespace and purge policies refuse, is proven on kind.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { addTeamMember, createTeam, createUser, setUserAdmin } from "../src/db/queries.js";
import { teams, users } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import {
  applySecretStoreObjects,
  deleteTeamNamespace,
  NamespaceNotTeamsError,
  ProtectedNamespaceError,
  setTeamNamespace,
  writeTeamPullSecret,
} from "../src/k8s.js";
import { syncPullSecrets } from "../src/pullSecret.js";
import { checkSecretStoreObjects } from "../src/secretStores.js";

vi.mock("../src/k8s.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/k8s.js")>()),
  setTeamNamespace: vi.fn(() => Promise.resolve(true)),
  deleteTeamNamespace: vi.fn(() => Promise.resolve()),
  applySecretStoreObjects: vi.fn(() => Promise.resolve()),
  writeTeamPullSecret: vi.fn(() => Promise.resolve(true)),
}));
// Purging asks kernel-api about unfinished executions; these teams have none.
vi.mock("../src/kernel/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kernel/client.js")>()),
  getExecutionStates: vi.fn(() => Promise.resolve([])),
}));

const prefix = `ns-${randomUUID().slice(0, 6)}`;
const emails: string[] = [];
let app: FastifyInstance;
let admin: string;
const original = { ...config.teamNamespaces };

async function newUser(isAdmin = false): Promise<{ id: string; token: string }> {
  const email = `${prefix}-${randomUUID().slice(0, 6)}@example.com`;
  emails.push(email);
  const user = await createUser(email, await hashPassword("correct-horse-battery"));
  if (isAdmin) await setUserAdmin(user.id, true);
  return { id: user.id, token: app.jwt.sign({ userId: user.id }) };
}

const as = (token: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

async function mint(scopes: string[]): Promise<string> {
  const response = await as(admin, "POST", "/api/automation-tokens", { label: prefix, scopes });
  return response.json<{ token: string }>().token;
}

const name = (suffix: string) => `${prefix}-${suffix}`;

beforeAll(async () => {
  config.teamNamespaces.manage = true;
  config.teamNamespaces.purge = true;
  app = await buildApp();
  await app.ready();
  admin = (await newUser(true)).token;
});

afterAll(async () => {
  Object.assign(config.teamNamespaces, original);
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await db.delete(users).where(inArray(users.email, emails));
  await app.close();
});

beforeEach(() => {
  vi.mocked(setTeamNamespace).mockClear();
  vi.mocked(deleteTeamNamespace).mockClear();
  vi.mocked(applySecretStoreObjects).mockClear();
  vi.mocked(writeTeamPullSecret).mockClear();
});

describe("creating a team", () => {
  it("creates its namespace, labelled a team's", async () => {
    const response = await as(admin, "POST", "/api/teams", { name: name("new") });
    expect(response.statusCode).toBe(201);
    expect(setTeamNamespace).toHaveBeenCalledWith(name("new"), "true", expect.objectContaining({ createIfMissing: true, label: "acyclix/team" }));
  });

  it("refuses a name that can't be a namespace", async () => {
    for (const bad of ["Team_A", "-a", "a".repeat(64), "has space"]) {
      expect((await as(admin, "POST", "/api/teams", { name: bad })).statusCode).toBe(400);
    }
    expect(setTeamNamespace).not.toHaveBeenCalled();
  });

  it("creates no team when the namespace can't be its", async () => {
    vi.mocked(setTeamNamespace).mockRejectedValueOnce(new ProtectedNamespaceError("protected"));
    expect((await as(admin, "POST", "/api/teams", { name: name("prot") })).statusCode).toBe(422);
    vi.mocked(setTeamNamespace).mockRejectedValueOnce(new NamespaceNotTeamsError("someone else's"));
    const taken = await as(admin, "POST", "/api/teams", { name: name("taken") });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ error: string }>().error).toBe("NAMESPACE_EXISTS");
    const created = await db.select().from(teams).where(inArray(teams.name, [name("prot"), name("taken")]));
    expect(created).toEqual([]);
  });

  it("leaves namespaces alone when the console doesn't manage them", async () => {
    config.teamNamespaces.manage = false;
    try {
      expect((await as(admin, "POST", "/api/teams", { name: name("unmanaged") })).statusCode).toBe(201);
      expect(setTeamNamespace).not.toHaveBeenCalled();
    } finally {
      config.teamNamespaces.manage = true;
    }
  });
});

describe("PUT /teams/:name, what catalog CI calls for every team folder", () => {
  it("creates the team the first time, and is a no-op after", async () => {
    const ci = await mint(["teams:create"]);
    const first = await as(ci, "PUT", `/api/teams/${name("ensure")}`);
    expect(first.statusCode).toBe(201);
    expect(first.json<{ created: boolean }>().created).toBe(true);
    const again = await as(ci, "PUT", `/api/teams/${name("ensure")}`);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ created: boolean }>().created).toBe(false);
    expect(setTeamNamespace).toHaveBeenCalledTimes(2); // a drifted label is put back every time
  });

  it("un-retires a retired team only with teams:retire too", async () => {
    await createTeam(name("back"));
    await as(admin, "POST", `/api/teams/${name("back")}/retire`);
    expect((await as(await mint(["teams:create"]), "PUT", `/api/teams/${name("back")}`)).statusCode).toBe(403);
    const both = await as(await mint(["teams:create", "teams:retire"]), "PUT", `/api/teams/${name("back")}`);
    expect(both.statusCode).toBe(200);
    expect(both.json<{ retiredAt: string | null }>().retiredAt).toBeNull();
  });

  it("refuses a purged team's name, and anyone without teams:create", async () => {
    await createTeam(name("gone"));
    await as(admin, "POST", `/api/teams/${name("gone")}/retire`);
    await as(admin, "DELETE", `/api/teams/${name("gone")}`);
    expect((await as(admin, "PUT", `/api/teams/${name("gone")}`)).json<{ error: string }>().error).toBe("NAME_RESERVED");
    expect((await as((await newUser()).token, "PUT", `/api/teams/${name("anyone")}`)).statusCode).toBe(403);
    expect((await as(await mint(["products:register"]), "PUT", `/api/teams/${name("anyone")}`)).statusCode).toBe(403);
  });
});

describe("retiring and purging", () => {
  it("relabels the namespace retired, without creating one", async () => {
    await createTeam(name("ret"));
    expect((await as(admin, "POST", `/api/teams/${name("ret")}/retire`)).statusCode).toBe(200);
    expect(setTeamNamespace).toHaveBeenCalledWith(name("ret"), "retired", expect.objectContaining({ createIfMissing: false }));
    await as(admin, "POST", `/api/teams/${name("ret")}/unretire`);
    expect(setTeamNamespace).toHaveBeenLastCalledWith(name("ret"), "true", expect.objectContaining({ createIfMissing: true }));
  });

  it("deletes the namespace when purging, and again when asked again", async () => {
    await createTeam(name("purge"));
    await as(admin, "POST", `/api/teams/${name("purge")}/retire`);
    const purged = await as(admin, "DELETE", `/api/teams/${name("purge")}`);
    expect(purged.statusCode).toBe(200);
    expect(purged.json<{ namespaceDeleted: boolean }>().namespaceDeleted).toBe(true);
    expect(deleteTeamNamespace).toHaveBeenCalledWith(name("purge"), expect.any(Array));
    // A namespace deletion that failed the first time can simply be retried.
    const again = await as(admin, "DELETE", `/api/teams/${name("purge")}`);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ alreadyPurged: boolean }>().alreadyPurged).toBe(true);
    expect(deleteTeamNamespace).toHaveBeenCalledTimes(2);
  });

  it("leaves the namespace when the console isn't allowed to purge", async () => {
    config.teamNamespaces.purge = false;
    try {
      await createTeam(name("keep"));
      await as(admin, "POST", `/api/teams/${name("keep")}/retire`);
      const purged = await as(admin, "DELETE", `/api/teams/${name("keep")}`);
      expect(purged.statusCode).toBe(200);
      expect(purged.json<{ namespaceDeleted: boolean }>().namespaceDeleted).toBe(false);
      expect(deleteTeamNamespace).not.toHaveBeenCalled();
    } finally {
      config.teamNamespaces.purge = true;
    }
  });
});

describe("applying a team's SecretStore file", () => {
  const store = (team: string, spec: object = { provider: { gcpsm: { projectID: "p", auth: { workloadIdentity: { serviceAccountRef: { name: "eso-gcp" } } } } } }) => ({
    apiVersion: "external-secrets.io/v1",
    kind: "SecretStore",
    metadata: { name: "vault", namespace: team },
    spec,
  });

  it("allows the store and ESO's ServiceAccounts, in the team's namespace", () => {
    const sa = { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "eso-gcp", annotations: { "iam.gke.io/gcp-service-account": "x@p.iam.gserviceaccount.com" } } };
    const checked = checkSecretStoreObjects("team-a", [sa, store("team-a")]);
    expect(checked.problems).toEqual([]);
    expect(checked.objects.map((o) => o.kind)).toEqual(["ServiceAccount", "SecretStore"]);
  });

  it("refuses anything that reaches outside the team", () => {
    const problems = (docs: unknown[]) => checkSecretStoreObjects("team-a", docs).problems.join(" | ");
    expect(problems([store("team-b")])).toContain('namespace must be "team-a"');
    expect(problems([{ ...store("team-a"), kind: "ClusterSecretStore" }])).toContain("only SecretStore");
    expect(problems([store("team-a", { provider: { kubernetes: { remoteNamespace: "x", server: { caProvider: { namespace: "kube-system" } } } } })])).toContain("points into another namespace");
    expect(problems([store("team-a", { provider: { onepassword: { auth: { secretRef: { connectTokenSecretRef: { name: "someone-elses" } } } } } })])).toContain('must name the Secret "eso-auth"');
    expect(problems([store("team-a"), { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "product-sa" } }])).toContain("the only ServiceAccounts allowed");
    expect(problems([{ apiVersion: "v1", kind: "Secret", metadata: { name: "eso-auth" } }])).toContain("only SecretStore");
    expect(problems([{ apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "eso-gcp" } }])).toContain("No SecretStore");
  });

  it("applies it with secret-stores:apply or as an admin, and nobody else", async () => {
    const team = name("stores");
    await createTeam(team);
    const member = await newUser();
    const [row] = await db.select().from(teams).where(inArray(teams.name, [team]));
    await addTeamMember(member.id, row?.id ?? "");
    const body = { documents: [store(team)], credential: "not-a-real-token" };

    expect((await as(member.token, "PUT", `/api/teams/${team}/secret-store`, body)).statusCode).toBe(403);
    expect((await as(await mint(["teams:create"]), "PUT", `/api/teams/${team}/secret-store`, body)).statusCode).toBe(403);
    expect(applySecretStoreObjects).not.toHaveBeenCalled();

    expect((await as(await mint(["secret-stores:apply"]), "PUT", `/api/teams/${team}/secret-store`, body)).statusCode).toBe(204);
    expect(applySecretStoreObjects).toHaveBeenCalledWith(team, [expect.objectContaining({ kind: "SecretStore" })], "not-a-real-token");
    expect((await as(admin, "PUT", `/api/teams/${team}/secret-store`, body)).statusCode).toBe(204);
  });

  it("applies nothing when the file isn't allowed, and says why", async () => {
    const team = name("bad-store");
    await createTeam(team);
    const response = await as(admin, "PUT", `/api/teams/${team}/secret-store`, { documents: [store("other")] });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ problems: string[] }>().problems[0]).toContain('namespace must be');
    expect(applySecretStoreObjects).not.toHaveBeenCalled();
  });
});

describe("registering a secret", () => {
  it("refuses the name of a SecretStore's own credential, and of the pull Secret", async () => {
    const team = name("reserved");
    await createTeam(team);
    for (const secretName of ["eso-auth", "acyclix-pull"]) {
      const response = await as(admin, "POST", "/api/secrets", { namespace: team, secretName, data: { token: "x" } });
      expect(response.statusCode).toBe(422);
    }
  });
});

describe("the registry pull Secret", () => {
  const PULL = '{"auths":{"ghcr.io":{"auth":"eDp5"}}}';

  beforeAll(() => {
    const file = join(mkdtempSync(join(tmpdir(), "pull-")), "config.json");
    writeFileSync(file, PULL);
    config.teamPullSecretFile = file;
  });

  afterAll(() => {
    config.teamPullSecretFile = "";
  });

  it("is copied into a new team's namespace", async () => {
    expect((await as(admin, "POST", "/api/teams", { name: name("pull") })).statusCode).toBe(201);
    expect(writeTeamPullSecret).toHaveBeenCalledWith(name("pull"), PULL);
  });

  it("isn't copied when a team is retired", async () => {
    await as(admin, "POST", "/api/teams", { name: name("pull-retire") });
    vi.mocked(writeTeamPullSecret).mockClear();
    await as(admin, "POST", `/api/teams/${name("pull-retire")}/retire`);
    expect(writeTeamPullSecret).not.toHaveBeenCalled();
  });

  it("is copied into every team on a resync, and a failure is reported", async () => {
    await createTeam(name("pull-sync"));
    expect(await syncPullSecrets()).toBe(true);
    expect(writeTeamPullSecret).toHaveBeenCalledWith(name("pull-sync"), PULL);
    vi.mocked(writeTeamPullSecret).mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await expect(syncPullSecrets()).rejects.toThrow("Couldn't copy the pull Secret");
  });

  it("isn't copied when not configured", async () => {
    config.teamPullSecretFile = ""; // the last test: afterAll leaves it so
    expect(await syncPullSecrets()).toBe(false);
    expect(writeTeamPullSecret).not.toHaveBeenCalled();
  });
});
