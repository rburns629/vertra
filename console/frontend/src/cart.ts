// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from "react";
import type { OrderOption } from "./api";

/**
 * The cart (decision 25): actions a person collects in the Catalog, then
 * orders together for one team (CartPage). Kept in this browser only, a
 * convenience: nothing about it is the server's until it's placed, so an
 * empty or unreadable store just means an empty cart.
 */
export interface Cart {
  /** The team it's for; null until chosen. */
  team: string | null;
  /** Registered actions (<team>-<product>-<action>); one may be in it twice. */
  actions: string[];
  /** Choices and values a chat answer filled in (by step, then input), for the cart page to start from. */
  choices: OrderOption[];
  values: Record<string, Record<string, unknown>>;
}

const KEY = "vertra.cart";
const EMPTY: Cart = { team: null, actions: [], choices: [], values: {} };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const listeners = new Set<() => void>();

function read(): Cart {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { team, actions, choices, values } = parsed as Record<string, unknown>;
    return {
      team: typeof team === "string" ? team : null,
      actions: Array.isArray(actions) ? actions.filter((a): a is string => typeof a === "string").slice(0, 50) : [],
      choices: Array.isArray(choices) ? choices.filter((c): c is OrderOption => isRecord(c) && typeof c["step"] === "string" && typeof c["input"] === "string") : [],
      values: isRecord(values) ? Object.fromEntries(Object.entries(values).filter((e): e is [string, Record<string, unknown>] => isRecord(e[1]))) : {},
    };
  } catch {
    return EMPTY;
  }
}

let current = read();

function write(next: Cart): void {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not kept (a private window): it still works on this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab's change.
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) {
      current = read();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useCart(): Cart {
  return useSyncExternalStore(subscribe, () => current);
}

// A changed cart's steps (or team) may not be the ones a chat answer's
// choices and values were for: they're dropped.
export const cart = {
  add(action: string): void {
    if (current.actions.length < 50) write({ ...current, actions: [...current.actions, action], choices: [], values: {} });
  },
  removeAt(index: number): void {
    write({ ...current, actions: current.actions.filter((_, i) => i !== index), choices: [], values: {} });
  },
  setTeam(team: string): void {
    write({ ...current, team, choices: [], values: {} });
  },
  /** What a chat answer proposed, in place of what's there. */
  replace(team: string, actions: string[], choices: OrderOption[] = [], values: Cart["values"] = {}): void {
    write({ team, actions: actions.slice(0, 50), choices, values });
  },
  clear(): void {
    write({ team: current.team, actions: [], choices: [], values: {} });
  },
};
