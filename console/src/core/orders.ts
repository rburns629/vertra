// SPDX-License-Identifier: MIT
/**
 * The order builder (decision 23): OrderService/PreviewOrder. A cart of
 * actions becomes one run's steps, each input wired by its wiring type: an
 * input's x-vertra-needs to the one output in the cart whose
 * x-vertra-provides is the same type (the catalog's wiring_types).
 *
 *   - Nothing in the cart provides a required input's type: the type's
 *     default provider (wiring_types.default_provider) is added as a step,
 *     or, for a shared type, one parameter (named for the type) is asked
 *     once for every input of that type.
 *   - Two outputs could fill an input: it's left for the person, with the
 *     options (AMBIGUOUS), unless the request chose one.
 *   - Steps feeding each other round: CYCLE, and the cart's order kept.
 *
 * It never runs anything: Compose opens what it answers, for a person to
 * review and run, or propose as a template. planOrder is the whole of the
 * wiring, without I/O; previewOrder checks who may and loads what it needs.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { ensureMayOrder, ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { findRunnableProduct, listWiringTypes, type WiringType } from "../db/queries.js";
import type { TeamProduct } from "./templates.js";

export const MAX_CART = 50;

export type OrderInput =
  | { kind: "step"; step: string; output: string }
  | { kind: "parameter"; parameter: string }
  | { kind: "unset" };

export interface OrderChoice {
  step: string;
  input: string;
  fromStep: string;
  fromOutput: string;
}

export interface OrderStep {
  id: string;
  product: string;
  inputs: Record<string, OrderInput>;
  added: boolean;
}

export interface OrderProblem {
  code: "AMBIGUOUS" | "NO_PROVIDER" | "CYCLE";
  step: string;
  input: string;
  message: string;
  options: OrderChoice[];
}

interface Field {
  name: string;
  required: boolean;
  /** x-vertra-needs on an input, x-vertra-provides on an output. */
  wiring: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fields(schema: unknown, hint: "x-vertra-needs" | "x-vertra-provides"): Field[] {
  const s = isRecord(schema) ? schema : {};
  const properties = isRecord(s["properties"]) ? s["properties"] : {};
  const required = Array.isArray(s["required"]) ? s["required"] : [];
  return Object.entries(properties).map(([name, raw]) => {
    const wiring = isRecord(raw) ? raw[hint] : undefined;
    return { name, required: required.includes(name), wiring: typeof wiring === "string" ? wiring : null };
  });
}

/** "<team>/<product>.<action>" (a default provider) as its registered name, <team>-<product>-<action>. */
export function registeredName(ref: string): string | null {
  const m = /^([a-z0-9-]+)\/([a-z0-9-]+)\.([a-z0-9-]+)$/.exec(ref);
  return m ? `${m[1] ?? ""}-${m[2] ?? ""}-${m[3] ?? ""}` : null;
}

/** A step's id: its product's own name (without its team and action), made unique. */
function stepId(product: TeamProduct, taken: Set<string>): string {
  const prefix = `${product.teamName}-`;
  const suffix = `-${product.action}`;
  const base =
    product.name.startsWith(prefix) && product.name.endsWith(suffix) && product.name.length > prefix.length + suffix.length
      ? product.name.slice(prefix.length, -suffix.length)
      : product.action;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${String(n)}`;
  taken.add(id);
  return id;
}

/**
 * Wires a cart. `products` are the cart's, in its order; `defaults` resolves
 * a default provider (null: not here, or not for this caller).
 */
export function planOrder(
  cart: TeamProduct[],
  types: Pick<WiringType, "name" | "shared" | "defaultProvider">[],
  defaults: Map<string, TeamProduct | null>,
  choices: OrderChoice[],
): { steps: OrderStep[]; problems: OrderProblem[] } {
  const typeOf = new Map(types.map((t) => [t.name, t]));
  const taken = new Set<string>();
  const planned = cart.map((product) => ({ id: stepId(product, taken), product, added: false }));
  const problems: OrderProblem[] = [];

  const provided = (type: string) => planned.some((s) => fields(s.product.outputSchema, "x-vertra-provides").some((o) => o.wiring === type));
  // Default providers, until nothing more is needed: a provider added may
  // need its own. Each is added once, whatever it turns out to provide.
  const added = new Set<string>();
  // A for...of over an array visits what's pushed onto it while it runs.
  for (const step of planned) {
    for (const input of fields(step.product.inputSchema, "x-vertra-needs")) {
      if (!input.required || !input.wiring || provided(input.wiring)) continue;
      const type = typeOf.get(input.wiring);
      if (!type || type.shared || !type.defaultProvider || added.has(type.defaultProvider)) continue;
      added.add(type.defaultProvider);
      const provider = defaults.get(type.defaultProvider);
      if (provider) planned.push({ id: stepId(provider, taken), product: provider, added: true });
    }
  }

  const steps: OrderStep[] = planned.map((s) => {
    const inputs: Record<string, OrderInput> = {};
    for (const input of fields(s.product.inputSchema, "x-vertra-needs")) {
      inputs[input.name] = { kind: "unset" };
      if (!input.wiring) continue;
      const options: OrderChoice[] = planned
        .filter((other) => other.id !== s.id)
        .flatMap((other) =>
          fields(other.product.outputSchema, "x-vertra-provides")
            .filter((o) => o.wiring === input.wiring)
            .map((o) => ({ step: s.id, input: input.name, fromStep: other.id, fromOutput: o.name })),
        );
      const chosen = choices.find((c) => c.step === s.id && c.input === input.name);
      const pick = chosen ? options.find((o) => o.fromStep === chosen.fromStep && o.fromOutput === chosen.fromOutput) : options.length === 1 ? options[0] : undefined;
      if (pick) {
        inputs[input.name] = { kind: "step", step: pick.fromStep, output: pick.fromOutput };
      } else if (options.length > 1) {
        problems.push({ code: "AMBIGUOUS", step: s.id, input: input.name, message: `${s.id}'s ${input.name} (${input.wiring}) could come from ${options.map((o) => `${o.fromStep}.${o.fromOutput}`).join(" or ")}: choose one.`, options });
      } else if (typeOf.get(input.wiring)?.shared) {
        inputs[input.name] = { kind: "parameter", parameter: input.wiring };
      } else if (input.required) {
        const provider = typeOf.get(input.wiring)?.defaultProvider;
        problems.push({
          code: "NO_PROVIDER",
          step: s.id,
          input: input.name,
          message: `Nothing in the order provides ${input.wiring} for ${s.id}'s ${input.name}${provider ? ` (its default, ${provider}, isn't available to you)` : ""}: give it a value, or add a step that provides it.`,
          options: [],
        });
      }
    }
    return { id: s.id, product: s.product.name, inputs, added: s.added };
  });

  // Each step after those it takes outputs from (Kahn's, keeping the cart's order among equals).
  const ordered: OrderStep[] = [];
  const left = [...steps];
  while (left.length > 0) {
    const next = left.findIndex((s) =>
      Object.values(s.inputs).every((i) => i.kind !== "step" || ordered.some((o) => o.id === i.step)),
    );
    if (next === -1) {
      problems.push({ code: "CYCLE", step: left.map((s) => s.id).join(", "), input: "", message: `These steps take each other's outputs, round in a circle: ${left.map((s) => s.id).join(", ")}. Choose a value for one of their inputs.`, options: [] });
      ordered.push(...left);
      break;
    }
    ordered.push(...left.splice(next, 1));
  }
  return { steps: ordered, problems };
}

/** Whether `who` may use a product in an order: its team's own, or shared with one of theirs. */
function mayUse(who: AuthUser, product: TeamProduct): boolean {
  return who.isAdmin || who.teamNames.includes(product.teamName) || product.shareWith.includes("*") || who.teamNames.some((t) => product.shareWith.includes(t));
}

export async function previewOrder(caller: AuthUser | undefined, request: { team: string; actions: string[]; choices: OrderChoice[] }) {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  const who = caller;
  ensureMayOrder(who);
  ensureTeamMember(who, request.team);
  if (request.actions.length === 0) throw new ApiError(400, "BAD_REQUEST", "Put at least one action in the order.");
  if (request.actions.length > MAX_CART) throw new ApiError(400, "BAD_REQUEST", `An order has at most ${String(MAX_CART)} actions.`);
  const cart: TeamProduct[] = [];
  for (const name of request.actions) {
    const product = await findRunnableProduct(name);
    if (!product || !mayUse(who, product)) throw new ApiError(404, "NOT_FOUND", `No action "${name}" that's shared with you.`);
    cart.push(product);
  }
  const types = await listWiringTypes();
  const defaults = new Map<string, TeamProduct | null>();
  for (const ref of new Set(types.map((t) => t.defaultProvider).filter((p): p is string => p !== null))) {
    const name = registeredName(ref);
    const product = name ? await findRunnableProduct(name) : undefined;
    defaults.set(ref, product && mayUse(who, product) ? product : null);
  }
  return planOrder(cart, types, defaults, request.choices);
}
