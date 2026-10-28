// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from "react";

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
}

const KEY = "vertra.cart";
const EMPTY: Cart = { team: null, actions: [] };
const listeners = new Set<() => void>();

function read(): Cart {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { team, actions } = parsed as Record<string, unknown>;
    return {
      team: typeof team === "string" ? team : null,
      actions: Array.isArray(actions) ? actions.filter((a): a is string => typeof a === "string").slice(0, 50) : [],
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

export const cart = {
  add(action: string): void {
    if (current.actions.length < 50) write({ ...current, actions: [...current.actions, action] });
  },
  removeAt(index: number): void {
    write({ ...current, actions: current.actions.filter((_, i) => i !== index) });
  },
  setTeam(team: string): void {
    write({ ...current, team });
  },
  clear(): void {
    write({ team: current.team, actions: [] });
  },
};
