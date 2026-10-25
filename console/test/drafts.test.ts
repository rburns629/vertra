// SPDX-License-Identifier: MIT
/**
 * Compose's drafts (src/core/drafts.ts): kept for the team each is for, so
 * its members and admins see and change them, and nobody else; a save made
 * on an older version is refused, not applied; a retired team's are
 * read-only. The real console on the real test database.
 */
import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../src/db/client.js";
import { addTeamMember, createTeam } from "../src/db/queries.js";
import { teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, failureDetail, rpcClient, type RpcError } from "./rpc.js";

const prefix = `drf-${randomUUID().slice(0, 6)}`;
const own = `${prefix}-own`;
const other = `${prefix}-other`;

let app: FastifyInstance;
const users = rpcClient(() => app);
const call = caller(() => app);
let alice: string;
let bob: string;
let outsider: string;
let admin: string;

interface Listed {
  drafts?: { team: string; name: string; version: string; updatedBy: string; body: Record<string, unknown> }[];
}
interface Saved {
  draft?: { version: string; updatedBy: string };
}

const body = (steps: number) => ({ displayName: "Mine", steps: Array.from({ length: steps }, (_, i) => ({ product: `p${String(i)}` })) });

beforeAll(async () => {
  app = await buildApp();
  const ownTeam = await createTeam(own);
  const otherTeam = await createTeam(other);
  const [a, b, o, ad] = await Promise.all([users.makeUser(), users.makeUser(), users.makeUser(), users.makeUser({ admin: true })]);
  await addTeamMember(a?.id ?? "", ownTeam.id, "member");
  await addTeamMember(b?.id ?? "", ownTeam.id, "member");
  await addTeamMember(o?.id ?? "", otherTeam.id, "member");
  [alice, bob, outsider, admin] = await Promise.all([a, b, o, ad].map((u) => users.signIn(u?.email ?? "")));
});

afterAll(async () => {
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("a team's drafts", () => {
  it("are its members' and admins', from any device, and nobody else's", async () => {
    const made = await call<Saved>(alice, "DraftService/SaveDraft", { team: own, name: "my-template", body: body(1), version: 0 });
    expect(made.code).toBe("ok");
    expect(made.body.draft?.version).toBe("1");

    const seen = await call<Listed>(bob, "DraftService/ListDrafts", {});
    expect(seen.body.drafts?.filter((d) => d.team === own).map((d) => [d.name, d.body])).toEqual([["my-template", body(1)]]);
    expect((await call<Listed>(admin, "DraftService/ListDrafts", { team: own })).body.drafts).toHaveLength(1);

    expect((await call<Listed>(outsider, "DraftService/ListDrafts", {})).body.drafts?.filter((d) => d.team === own) ?? []).toEqual([]);
    expect((await call(outsider, "DraftService/ListDrafts", { team: own })).code).toBe("permission_denied");
    expect((await call(outsider, "DraftService/SaveDraft", { team: own, name: "mine-now", body: body(1), version: 0 })).code).toBe("permission_denied");
    expect((await call(outsider, "DraftService/DeleteDraft", { team: own, name: "my-template" })).code).toBe("permission_denied");
  });

  it("refuses a save made on an older version, and a new one whose name is taken", async () => {
    const bobs = await call<Saved>(bob, "DraftService/SaveDraft", { team: own, name: "my-template", body: body(2), version: 1 });
    expect(bobs.body.draft).toMatchObject({ version: "2" });

    const late = await call(alice, "DraftService/SaveDraft", { team: own, name: "my-template", body: body(3), version: 1 });
    expect([late.code, late.failure]).toEqual(["failed_precondition", "DRAFT_CHANGED"]);
    expect(failureDetail(late.body as unknown as RpcError)?.["version"]).toBe(2);

    const taken = await call(alice, "DraftService/SaveDraft", { team: own, name: "my-template", body: body(1), version: 0 });
    expect(taken.failure).toBe("DRAFT_CHANGED");
    const [kept] = (await call<Listed>(alice, "DraftService/ListDrafts", { team: own })).body.drafts ?? [];
    expect(kept?.body).toEqual(body(2));
  });

  it("are bounded, and named as a template's file", async () => {
    const big = { text: "x".repeat(70 * 1024) };
    expect((await call(alice, "DraftService/SaveDraft", { team: own, name: "big", body: big, version: 0 })).failure).toBe("DRAFT_TOO_LARGE");
    expect((await call(alice, "DraftService/SaveDraft", { team: own, name: "Not A Name", body: {}, version: 0 })).code).toBe("invalid_argument");
  });

  it("are read-only once the team is retired, and go when deleted", async () => {
    await db.update(teams).set({ retiredAt: new Date() }).where(eq(teams.name, own));
    expect((await call(alice, "DraftService/SaveDraft", { team: own, name: "my-template", body: body(4), version: 2 })).failure).toBe("TEAM_RETIRED");
    await db.update(teams).set({ retiredAt: null }).where(eq(teams.name, own));
    expect((await call(alice, "DraftService/DeleteDraft", { team: own, name: "my-template" })).code).toBe("ok");
    expect((await call<Listed>(alice, "DraftService/ListDrafts", { team: own })).body.drafts ?? []).toEqual([]);
  });
});
