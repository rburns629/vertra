// SPDX-License-Identifier: MIT
/**
 * Pull-based catalog registration: this console reads its catalog's release
 * (proto/vertra/catalog/v1/release.proto) from the registry, verifies its
 * signature where the install trusts one, and applies it. Catalog CI only
 * builds, tests, scans, signs and pushes; it holds no console credential,
 * and any number of installs read the same catalog.
 *
 * Applying a release, as the catalog's CI used to through the API, and with
 * exactly its old token's rights (CATALOG):
 *   - each team it names exists and is active, with its namespace; a team
 *     made by an earlier release that this one doesn't name is retired
 *     (reversible). Purging stays an admin's action, never a release's. A
 *     team that exists but no release made (by hand, or before this console
 *     read releases) is left alone, its products and SecretStores too, until
 *     an admin adopts it (adoptTeam): a new catalog folder never takes over
 *     an existing team's namespace and secrets by itself;
 *   - each product action is registered at its pinned image (scanned, owned,
 *     checked as any registration is); one an earlier release registered
 *     that this one doesn't have is unregistered;
 *   - each team's templates are stored as the release has them; one it
 *     no longer has is removed;
 *   - each team's SecretStore documents are applied. A store's stored
 *     credential is set per install (TeamService.SetSecretStoreCredential),
 *     never carried by a release.
 * One item that fails is recorded and the rest still apply; the release
 * isn't applied again unless asked (SyncCatalog), and the next one is.
 *
 * Every few minutes (config.catalog.pollSeconds), and on SyncCatalog; one
 * console at a time (an advisory lock), so replicas don't apply it twice.
 */
import { fromJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@bufbuild/protobuf";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import { writeAuditEntry } from "./audit.js";
import { SCOPES } from "./auth/scopes.js";
import type { AuthUser } from "./auth/plugin.js";
import { config } from "./config.js";
import { deleteProduct, registerProduct } from "./core/products.js";
import { applySecretStore, ensureTeam, retireTeam } from "./core/teams.js";
import { parameterSchemaProblem, templateStepProblems } from "./core/templates.js";
import { db } from "./db/client.js";
import { deleteTemplatesExcept, findTeamByName, upsertTemplate } from "./db/queries.js";
import { catalogSync, products, teams } from "./db/schema.js";
import { ReleaseSchema, type Release } from "./gen/vertra/catalog/v1/release_pb.js";
import { createVerifyJob, deleteScanJob, readScanJob } from "./k8s.js";
import { fetchRelease } from "./registry.js";

/** The rights a release is applied with: what catalog CI's token held. */
const CATALOG: AuthUser = {
  id: "catalog-sync",
  teamNames: [],
  maintainerOf: [],
  isAdmin: false,
  scopes: [SCOPES.TEAMS_CREATE, SCOPES.TEAMS_RETIRE, SCOPES.PRODUCTS_REGISTER, SCOPES.SECRET_STORES_APPLY],
};

/** Any constant no one else uses: one console applies a release at a time. */
const LOCK_KEY = 4_170_225_610;

export interface CatalogProblem {
  item: string;
  message: string;
  /** A team the catalog didn't make, which an admin may adopt. */
  adoptableTeam?: string;
}

export interface CatalogStatus {
  /** Where the release is read from; empty: no catalog configured. */
  release: string;
  digest: string | null;
  commit: string | null;
  repository: string | null;
  appliedAt: Date | null;
  problems: CatalogProblem[];
  checkedAt: Date | null;
  error: string | null;
}

export async function catalogStatus(): Promise<CatalogStatus> {
  const [row] = await db.select().from(catalogSync).where(eq(catalogSync.id, 1));
  return {
    release: config.catalog.release,
    digest: row?.digest ?? null,
    commit: row?.commit ?? null,
    repository: row?.repository ?? null,
    appliedAt: row?.appliedAt ?? null,
    problems: row?.problems ?? [],
    checkedAt: row?.checkedAt ?? null,
    error: row?.error ?? null,
  };
}

async function record(values: Partial<typeof catalogSync.$inferInsert>): Promise<void> {
  await db
    .insert(catalogSync)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: catalogSync.id, set: values });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What `cosign verify` needs to check a release against each trusted
 * signer: one try per public key, then keyless. Empty: nothing trusted, so
 * nothing verified (the registry's main-only write access is the trust). */
function verifications(reference: string): { args: string[]; publicKey?: string }[] {
  const { publicKeys, keylessIssuer, keylessSubjectRegExp } = config.catalog.signature;
  // Registry sign-in as the scan Jobs have it: the pull Secret's Docker
  // config when there is one (cosign's default keychain), else the cloud
  // identity of the Job's ServiceAccount (GKE Workload Identity, EKS), which
  // cosign reads only with --k8s-keychain.
  const keychain = config.scanning.pullSecretName ? [] : ["--k8s-keychain"];
  // Catalog CI's key signatures go to no public log (`vertra catalog publish`'s signing).
  const tries: { args: string[]; publicKey?: string }[] = publicKeys.map((publicKey) => ({
    args: [...keychain, "--key", "env://COSIGN_PUBLIC_KEY", "--insecure-ignore-tlog=true", reference],
    publicKey,
  }));
  if (keylessIssuer && keylessSubjectRegExp) {
    tries.push({
      args: [...keychain, "--certificate-oidc-issuer", keylessIssuer, "--certificate-identity-regexp", keylessSubjectRegExp, reference],
    });
  }
  return tries;
}

/** Whether any trusted signer signed `reference` (pinned by digest). */
async function verified(reference: string, log: FastifyBaseLogger): Promise<boolean> {
  const namespace = config.platformNamespace;
  for (const [i, attempt] of verifications(reference).entries()) {
    const name = `catalog-verify-${Date.now().toString(36)}-${String(i)}`;
    await createVerifyJob({
      namespace,
      name,
      image: config.catalog.verifierImage,
      serviceAccount: config.scanning.serviceAccount,
      pullSecretName: config.scanning.pullSecretName,
      ...attempt,
    });
    const deadline = Date.now() + 300_000;
    let state = await readScanJob(namespace, name, "cosign");
    while (state.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      state = await readScanJob(namespace, name, "cosign");
    }
    await deleteScanJob(namespace, name);
    if (state.state === "succeeded") return true;
    log.warn({ event: "catalog_release_unverified", reference, output: "output" in state ? state.output.slice(-500) : state.state },
      "a trusted signer didn't verify the catalog release");
  }
  return false;
}

/** Applies a release; returns what it couldn't do. */
async function apply(release: Release, log: FastifyBaseLogger): Promise<CatalogProblem[]> {
  const problems: CatalogProblem[] = [];
  const attempt = async (item: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      problems.push({ item, message: message(error) });
      log.warn({ event: "catalog_apply_problem", item, err: error }, `catalog release: ${item} failed`);
    }
  };
  const named = new Set(release.teams.map((t) => t.name));
  // Teams this release may not touch: ones no release made.
  const foreign = new Set<string>();
  for (const team of release.teams) {
    const [existing] = await db
      .select({ fromCatalog: teams.fromCatalog, deletedAt: teams.deletedAt })
      .from(teams)
      .where(eq(teams.name, team.name));
    if (existing && !existing.fromCatalog && !existing.deletedAt) {
      foreign.add(team.name);
      problems.push({
        item: `team ${team.name}`,
        message: `a team named ${team.name} already exists here and the catalog didn't make it; its products and SecretStores weren't applied. Adopt it if the catalog's folder is meant to be that team, or rename the folder.`,
        adoptableTeam: team.name,
      });
      continue;
    }
    await attempt(`team ${team.name}`, async () => {
      await ensureTeam(CATALOG, team.name, log);
      const allowedTargets = team.allowedTargets.map((rule) => ({
        teams: rule.teams,
        targets: Object.fromEntries(rule.targets.map((t) => [t.type, t.values])),
      }));
      await db
        .update(teams)
        .set({
          fromCatalog: true,
          allowedTargets,
          contact: team.contact || null,
          helpChat: team.helpChat || null,
          helpUrl: team.helpUrl || null,
        })
        .where(eq(teams.name, team.name));
    });
  }
  const released = new Set<string>();
  for (const p of release.products) {
    released.add(p.name);
    if (foreign.has(p.team)) continue;
    await attempt(`product ${p.name}`, async () => {
      await registerProduct(CATALOG, {
        name: p.name,
        image: p.image,
        action: p.action,
        team: p.team,
        inputSchema: p.inputSchema ?? {},
        outputSchema: p.outputSchema ?? {},
        ...(p.displayName ? { displayName: p.displayName } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.serviceAccount ? { serviceAccount: p.serviceAccount } : {}),
        secretRefs: p.secretRefs,
        tokenAudiences: p.tokenAudiences,
        shareWith: p.shareWith,
        hidden: p.hidden,
        ...(p.path ? { sourcePath: p.path } : {}),
        idempotent: p.idempotent,
        maxAttempts: p.maxAttempts > 0 ? p.maxAttempts : 1,
        concurrencyKey: p.concurrencyKey,
        errorHelp: Object.fromEntries(
          Object.entries(p.errors).map(([code, help]) => [code, { means: help.means, ...(help.do ? { do: help.do } : {}) }]),
        ),
        deprecated: p.deprecated,
        ...(p.resources
          ? {
              resources: Object.fromEntries(
                Object.entries({ cpu: p.resources.cpu, memory: p.resources.memory, memoryLimit: p.resources.memoryLimit }).filter(
                  ([, v]) => v,
                ),
              ),
            }
          : {}),
      });
      await db.update(products).set({ fromCatalog: true }).where(eq(products.name, p.name));
    });
  }
  // Each named team's templates, as the release has them. One that fails to
  // apply keeps what was stored; every other template of a team the catalog
  // made goes, as its products do.
  const keepTemplates = new Set<string>();
  for (const t of release.templates) {
    if (foreign.has(t.team) || !named.has(t.team)) continue;
    const team = await findTeamByName(t.team);
    if (!team) continue; // its own problem, above
    keepTemplates.add(`${team.id}/${t.name}`);
    await attempt(`template ${t.team}/${t.name}`, async () => {
      const parameters = t.parameters ?? { type: "object" };
      const problem = parameterSchemaProblem(parameters);
      if (problem) throw new Error(`its parameters aren't a usable JSON Schema: ${problem}`);
      // Every step's action, as applied just above, shared with this team.
      const stepProblems = await templateStepProblems(t.team, t.name, t.steps);
      if (stepProblems.length > 0) throw new Error(stepProblems.join(" "));
      await upsertTemplate({
        teamId: team.id,
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        parameters,
        steps: t.steps.map((step) => ({
          id: step.id,
          action: step.action,
          ...(step.dependsOn.length > 0 ? { dependsOn: step.dependsOn } : {}),
          ...(step.inputs ? { inputs: step.inputs } : {}),
          ...(step.timeoutSeconds !== undefined ? { timeoutSeconds: step.timeoutSeconds } : {}),
          ...(step.maxAttempts !== undefined ? { maxAttempts: step.maxAttempts } : {}),
        })),
        shareWith: t.shareWith,
        hidden: t.hidden,
        sourcePath: t.path || null,
        deprecated: t.deprecated || null,
      });
    });
  }
  await attempt("removing templates", () => deleteTemplatesExcept(keepTemplates));
  // What earlier releases made and this one no longer has.
  for (const gone of await db.select({ name: products.name }).from(products).where(eq(products.fromCatalog, true))) {
    if (!released.has(gone.name)) await attempt(`removing product ${gone.name}`, () => deleteProduct(CATALOG, gone.name));
  }
  const catalogTeams = await db
    .select({ name: teams.name, retiredAt: teams.retiredAt, deletedAt: teams.deletedAt })
    .from(teams)
    .where(eq(teams.fromCatalog, true));
  for (const team of catalogTeams) {
    if (!named.has(team.name) && !team.retiredAt && !team.deletedAt) {
      await attempt(`retiring team ${team.name}`, () => retireTeam(CATALOG, team.name, log));
    }
  }
  for (const team of release.teams.filter((t) => t.secretStoreDocuments.length > 0 && !foreign.has(t.name))) {
    await attempt(`secret stores of ${team.name}`, () =>
      applySecretStore(CATALOG, team.name, { documents: team.secretStoreDocuments }, log),
    );
  }
  return problems;
}

/**
 * One look: fetch the release, and if it's new (or `force`), verify and
 * apply it. Never throws: the outcome is recorded (catalogStatus) and
 * logged. Returns false when another console holds the lock.
 */
export async function syncCatalog(log: FastifyBaseLogger, force = false): Promise<boolean> {
  if (!config.catalog.release) return true;
  return db.transaction(async (tx) => {
    // Released when this transaction ends.
    const locked = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`);
    if (!locked.rows[0]?.locked) return false;
    const now = new Date();
    try {
      const { digest, json } = await fetchRelease(config.catalog.release);
      const [current] = await db.select().from(catalogSync).where(eq(catalogSync.id, 1));
      if (!force && current?.digest === digest) {
        await record({ checkedAt: now, error: null });
        return true;
      }
      const repository = config.catalog.release.replace(/[:@][^/]*$/, "");
      if (verifications(`${repository}@${digest}`).length > 0 && !(await verified(`${repository}@${digest}`, log))) {
        throw new Error(`no trusted signer signed the catalog release ${repository}@${digest}; nothing was applied`);
      }
      const release = fromJson(ReleaseSchema, JSON.parse(json) as JsonValue, { ignoreUnknownFields: true });
      const problems = await apply(release, log);
      await record({ digest, commit: release.commit, repository: release.repository, appliedAt: now, problems, checkedAt: now, error: null });
      await writeAuditEntry(log, {
        actorId: null,
        method: "CATALOG",
        route: "catalog-sync",
        target: { commit: release.commit, teams: release.teams.length, products: release.products.length, problems: problems.length },
        status: problems.length === 0 ? 200 : 207,
        requestId: digest,
      });
      log.info(
        { event: "catalog_release_applied", commit: release.commit, digest, teams: release.teams.length, products: release.products.length, problems: problems.length },
        "catalog release applied",
      );
    } catch (error) {
      await record({ checkedAt: now, error: message(error) });
      log.error({ event: "catalog_sync_failed", err: error }, "couldn't sync the catalog");
    }
    return true;
  });
}

/**
 * Lets releases manage a team they didn't make; the next sync then applies
 * its products and SecretStores. Admins only (core/admin.ts).
 */
export async function adoptTeam(name: string): Promise<boolean> {
  const adopted = await db
    .update(teams)
    .set({ fromCatalog: true })
    .where(and(eq(teams.name, name), isNull(teams.deletedAt)))
    .returning({ id: teams.id });
  return adopted.length > 0;
}

/** Syncs every pollSeconds from now on, and once right away. */
export function startCatalogSync(log: FastifyBaseLogger): void {
  if (!config.catalog.release) return;
  void syncCatalog(log);
  setInterval(() => void syncCatalog(log), config.catalog.pollSeconds * 1000).unref();
}
