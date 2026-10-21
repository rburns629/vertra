// SPDX-License-Identifier: MIT
/**
 * Allowed targets (X1): where another team may aim a team's products. An
 * action input typed (x-vertra-needs) as a kind of target names the
 * project, folder, account or subscription the owning team's identity acts
 * on; when another team runs it, the value must match one of the owning
 * team's rules for that team (team.yaml's allowedTargets, from the
 * catalog's release). The owning team's own runs, and admins', aren't
 * limited. A value an earlier step produced ($fromTask) isn't checked: that
 * step made it. The owning identity's cloud permissions, scoped to the same
 * folders, are the backstop; the console never asks the cloud.
 */
import type { TargetRule } from "./db/schema.js";

/** The kinds of target, as team.yaml and x-vertra-needs name them. */
export const TARGET_TYPES = ["gcp.project", "gcp.folder", "aws.account", "azure.subscription"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An action's target inputs: input name to kind, from its input schema. */
export function targetInputs(inputSchema: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const properties = isRecord(inputSchema) && isRecord(inputSchema["properties"]) ? inputSchema["properties"] : {};
  for (const [name, property] of Object.entries(properties)) {
    const kind = isRecord(property) ? property["x-vertra-needs"] : undefined;
    if (typeof kind === "string" && (TARGET_TYPES as readonly string[]).includes(kind)) out.set(name, kind);
  }
  return out;
}

/** Whether a value matches a pattern: exact, where * matches any run of characters. */
export function matchesTarget(pattern: string, value: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

/** The values or patterns `teams` may supply for a kind of target, under the owner's rules. */
export function allowedValues(rules: TargetRule[], teams: string[], kind: string): string[] {
  return rules
    .filter((rule) => rule.teams.includes("*") || rule.teams.some((team) => teams.includes(team)))
    .flatMap((rule) => rule.targets[kind] ?? []);
}

/**
 * Why these inputs aim the owner's product somewhere `teams` may not, one
 * problem per input; none when every target input is allowed (or comes
 * from an earlier step).
 */
export function targetProblems(
  owner: { name: string; allowedTargets: TargetRule[] },
  inputSchema: unknown,
  inputs: Record<string, unknown>,
  teams: string[],
): { field: string; message: string }[] {
  const problems: { field: string; message: string }[] = [];
  for (const [name, kind] of targetInputs(inputSchema)) {
    const value = inputs[name];
    if (value === undefined || (isRecord(value) && "$fromTask" in value)) continue;
    const allowed = allowedValues(owner.allowedTargets, teams, kind);
    if (typeof value === "string" && allowed.some((pattern) => matchesTarget(pattern, value))) continue;
    problems.push({
      field: name,
      message:
        allowed.length > 0
          ? `${owner.name} lets your team use ${kind} ${allowed.join(", ")} here, not ${JSON.stringify(value)}.`
          : `${owner.name} doesn't let your team aim this at any ${kind}: ask them to add one to their team.yaml's allowedTargets.`,
    });
  }
  return problems;
}
