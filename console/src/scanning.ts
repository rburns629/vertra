// SPDX-License-Identifier: MIT
/**
 * Scanning every image before it's registered or run, whoever built it.
 * Catalog CI scans what it publishes, but an image registered by hand, or
 * one that turns vulnerable after it shipped, would otherwise run unchecked.
 *
 * One verdict per digest (db/schema.ts's imageScans), from a Trivy client
 * Job (k8s.ts's createScanJob) run against the chart's Trivy server, which
 * holds the vulnerability database. The rule is catalog CI's: a HIGH or
 * CRITICAL vulnerability that has a fix, or a secret baked into the image,
 * fails it; unfixable ones are reported, not blocking. A failed digest
 * blocks new registrations and runs (routes/products.ts, routes/
 * executions.ts), never steps already running, until a rescan finds it
 * clean or an admin accepts it with a reason. Images in use are rescanned
 * daily, since new vulnerabilities are published against old images. The
 * kernel chart's scan policy holds the failed digests (syncScanPolicy), so
 * the cluster refuses them however a Job reaches it.
 */
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { imageScans } from "./db/schema.js";
import { normalizeImage } from "./imageRef.js";
import { createScanJob, deleteScanJob, readScanJob, updateScanPolicy } from "./k8s.js";

export type ScanRow = typeof imageScans.$inferSelect;

export interface Finding {
  kind: "vulnerability" | "secret";
  id: string;
  severity: string;
  package?: string;
  installed?: string;
  fixedIn?: string;
  title?: string;
}

export interface ScanFindings {
  fixable: number;
  unfixable: number;
  secrets: number;
  /** The blocking ones first, at most MAX_FINDINGS. */
  findings: Finding[];
  error?: string;
}

const MAX_FINDINGS = 25;

/**
 * Trivy's `--format template`: one line per HIGH/CRITICAL vulnerability and
 * per secret, then END, so a cut-off output is never read as a clean one.
 * (`.` is the report's Results.)
 */
export const SCAN_TEMPLATE =
  "{{- range . }}{{- range .Vulnerabilities }}" +
  '{{- if or (eq .Severity "CRITICAL") (eq .Severity "HIGH") }}' +
  "V|{{ .Severity }}|{{ .FixedVersion }}|{{ .VulnerabilityID }}|{{ .PkgName }}|{{ .InstalledVersion }}\n" +
  "{{ end }}{{- end }}" +
  "{{- range .Secrets }}S|{{ .Severity }}|{{ .RuleID }}|{{ .Title }}\n{{ end }}" +
  "{{- end }}END\n";

/** The scan's findings, or null when the output isn't a complete scan. */
export function parseScanOutput(output: string): ScanFindings | null {
  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.at(-1) !== "END") return null;
  const result: ScanFindings = { fixable: 0, unfixable: 0, secrets: 0, findings: [] };
  const blocking: Finding[] = [];
  const reported: Finding[] = [];
  for (const line of lines.slice(0, -1)) {
    const fields = line.split("|");
    if (fields[0] === "V") {
      const [, severity = "", fixedIn = "", id = "", pkg = "", installed = ""] = fields;
      const finding: Finding = { kind: "vulnerability", id, severity, package: pkg, installed, ...(fixedIn ? { fixedIn } : {}) };
      if (fixedIn) {
        result.fixable++;
        blocking.push(finding);
      } else {
        result.unfixable++;
        reported.push(finding);
      }
    } else if (fields[0] === "S") {
      const [, severity = "", id = "", title = ""] = fields;
      result.secrets++;
      blocking.push({ kind: "secret", id, severity, title });
    }
  }
  result.findings = [...blocking, ...reported].slice(0, MAX_FINDINGS);
  return result;
}

export function verdictOf(findings: ScanFindings): "passed" | "failed" {
  return findings.fixable > 0 || findings.secrets > 0 ? "failed" : "passed";
}

/** The digest an image is pinned to, or null for a tag. */
export function digestOf(image: string): string | null {
  return /@(sha256:[a-f0-9]{64})$/.exec(image)?.[1] ?? null;
}

/** What the scan Job pulls: through the registry's mirror when there is one. */
export function scanTarget(image: string): { target: string; insecure: boolean } {
  const normalized = normalizeImage(image);
  const host = normalized.split("/")[0] ?? "";
  const mirror = config.registryMirrors.get(host);
  if (!mirror) return { target: normalized, insecure: false };
  const url = new URL(mirror);
  return { target: url.host + normalized.slice(host.length), insecure: url.protocol === "http:" };
}

function blocks(row: ScanRow): boolean {
  return row.status === "failed" && row.acceptedAt === null;
}

async function startScan(row: { digest: string; image: string }): Promise<void> {
  const name = `scan-${row.digest.slice(7, 27)}-${Date.now().toString(36)}`;
  const { target, insecure } = scanTarget(row.image);
  // The job name is taken first, so two consoles don't both start one.
  const claimed = await db
    .update(imageScans)
    .set({ jobName: name, requestedAt: new Date() })
    .where(and(eq(imageScans.digest, row.digest), isNull(imageScans.jobName)))
    .returning({ digest: imageScans.digest });
  if (claimed.length === 0) return;
  await createScanJob({
    namespace: config.platformNamespace,
    name,
    scannerImage: config.scanning.image,
    serverUrl: config.scanning.serverUrl,
    serviceAccount: config.scanning.serviceAccount,
    pullSecretName: config.scanning.pullSecretName,
    target,
    insecure,
    platform: config.scanning.platform,
    template: SCAN_TEMPLATE,
  });
}

/**
 * Makes sure `image` (pinned) has a scan: starts one if it has never been
 * scanned, its last scan errored, or its verdict is older than the rescan
 * interval; marks it used either way. Returns its row.
 */
export async function requestScan(image: string): Promise<ScanRow | null> {
  const digest = digestOf(image);
  if (!digest || !config.scanning.enabled) return null;
  const now = new Date();
  await db
    .insert(imageScans)
    .values({ digest, image, status: "pending" })
    .onConflictDoUpdate({ target: imageScans.digest, set: { lastUsedAt: now } });
  const [row] = await db.select().from(imageScans).where(eq(imageScans.digest, digest));
  if (!row) return null;
  const stale = row.scannedAt !== null && now.getTime() - row.scannedAt.getTime() > config.scanning.rescanHours * 3_600_000;
  if (row.jobName === null && (row.status === "pending" || row.status === "error" || stale)) {
    await startScan(row);
  }
  return row;
}

/** Reads every running scan Job, records the finished ones' verdicts, and
 * starts the rescans that are due. Returns whether any verdict changed. */
export async function reconcileScans(): Promise<boolean> {
  if (!config.scanning.enabled) return false;
  const namespace = config.platformNamespace;
  let changed = false;
  const running = await db.select().from(imageScans).where(isNotNull(imageScans.jobName));
  for (const row of running) {
    if (!row.jobName) continue;
    const job = await readScanJob(namespace, row.jobName);
    if (job.state === "running") continue;
    const findings = job.state === "succeeded" ? parseScanOutput(job.output) : null;
    const status = findings ? verdictOf(findings) : "error";
    const recorded: ScanFindings = findings ?? {
      fixable: 0,
      unfixable: 0,
      secrets: 0,
      findings: [],
      error: job.state === "missing" ? "The scan Job disappeared." : (job.output.trim().split("\n").slice(-5).join("\n") || "The scan failed."),
    };
    // An accepted verdict stays accepted only while it finds nothing the
    // admin didn't see.
    const previous = new Set(((row.findings as ScanFindings | null)?.findings ?? []).map((f) => f.id));
    const somethingNew = recorded.findings.some((f) => !previous.has(f.id));
    await db
      .update(imageScans)
      .set({
        // A rescan that couldn't run keeps the last real verdict.
        status: status === "error" && row.status !== "pending" ? row.status : status,
        findings: status === "error" && row.status !== "pending" ? row.findings : recorded,
        scannedAt: status === "error" && row.status !== "pending" ? row.scannedAt : new Date(),
        jobName: null,
        ...(status === "failed" && somethingNew ? { acceptedAt: null, acceptedBy: null, acceptedReason: null } : {}),
      })
      .where(eq(imageScans.digest, row.digest));
    await deleteScanJob(namespace, row.jobName);
    changed ||= status !== row.status;
  }
  const due = await db
    .select()
    .from(imageScans)
    .where(
      and(
        isNull(imageScans.jobName),
        gt(imageScans.lastUsedAt, sql`now() - interval '30 days'`),
        or(
          eq(imageScans.status, "error"),
          lt(imageScans.scannedAt, sql`now() - make_interval(hours => ${config.scanning.rescanHours})`),
        ),
      ),
    )
    .limit(20);
  for (const row of due) await startScan(row);
  if (changed) await syncScanPolicy();
  return changed;
}

/** Writes every blocking digest into the kernel chart's scan policy. */
export async function syncScanPolicy(): Promise<boolean> {
  if (!config.scanning.enabled || !config.scanning.policyName) return false;
  return updateScanPolicy(config.scanning.policyName, async () => {
    const rows = await db.select().from(imageScans).where(eq(imageScans.status, "failed"));
    return JSON.stringify(rows.filter(blocks).map((row) => row.digest).sort());
  });
}

export interface ScanBlocker {
  error: "IMAGE_SCAN_FAILED" | "IMAGE_SCAN_PENDING" | "IMAGE_SCAN_ERROR";
  message: string;
  images: { image: string; digest: string; findings?: ScanFindings | null }[];
}

/**
 * Why these (pinned) images may not run, or null when they may: each must
 * have passed its scan, or been accepted. A first scan is waited for, up to
 * config.scanning.waitSeconds; one still running then asks the caller to
 * try again.
 */
export async function scanBlocker(images: string[]): Promise<ScanBlocker | null> {
  if (!config.scanning.enabled) return null;
  const pinned = [...new Set(images)].filter((image) => digestOf(image) !== null);
  const deadline = Date.now() + config.scanning.waitSeconds * 1000;
  for (;;) {
    const rows = new Map<string, ScanRow>();
    for (const image of pinned) {
      const row = await requestScan(image);
      if (row) rows.set(image, row);
    }
    const failed = pinned.filter((image) => {
      const row = rows.get(image);
      return row !== undefined && blocks(row);
    });
    if (failed.length > 0) {
      return {
        error: "IMAGE_SCAN_FAILED",
        message:
          `${failed.length === 1 ? "This image fails" : "These images fail"} the security scan (a HIGH or CRITICAL ` +
          `vulnerability with a fix, or a secret in the image): ${failed.join(", ")}. Rebuild it, or an admin can ` +
          "accept it with a reason.",
        images: failed.map((image) => ({ image, digest: digestOf(image) ?? "", findings: rows.get(image)?.findings as ScanFindings | null })),
      };
    }
    const waiting = pinned.filter((image) => rows.get(image)?.status === "pending");
    const errored = pinned.filter((image) => rows.get(image)?.status === "error");
    if (waiting.length === 0 && errored.length === 0) return null;
    if (Date.now() >= deadline) {
      return waiting.length > 0
        ? {
            error: "IMAGE_SCAN_PENDING",
            message: `Still scanning ${waiting.join(", ")} for the first time; try again in a minute.`,
            images: waiting.map((image) => ({ image, digest: digestOf(image) ?? "" })),
          }
        : {
            error: "IMAGE_SCAN_ERROR",
            message: `Couldn't scan ${errored.join(", ")}; it's being tried again. Try again in a minute.`,
            images: errored.map((image) => ({ image, digest: digestOf(image) ?? "", findings: rows.get(image)?.findings as ScanFindings | null })),
          };
    }
    await reconcileScans();
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
