// SPDX-License-Identifier: MIT
/**
 * Ordering tasks for the chat agent (decision 24, Correctness): what a
 * person asks for, and what the agent must do about it, judged by its
 * actions, not its words: the tools it used (planning before it proposes),
 * the cart it proposed (or that it proposed none), and what its answer
 * must say. Scored with the question set by scripts/chat-eval.ts, against
 * a console whose catalog has the gcp and local samples registered (kind,
 * after `make catalog-publish SAMPLES="local gcp"`); nothing is ordered.
 */
export interface ChatTask {
  request: string;
  /** Tools it must use, in this order (others may come between). */
  tools: string[];
  /** Actions the proposed cart must hold; null: it must propose none; undefined: not judged. */
  cart?: string[] | null;
  /** Words its answer must contain (any case), each one. */
  mustSay?: string[];
}

export const CHAT_TASKS: ChatTask[] = [
  {
    request: "I need app hosting on GCP for my service shop-api",
    tools: ["find_offerings", "plan_order", "propose_cart"],
    cart: ["gcp-app-hosting-create"],
    // What the plan says it needs: a project (added or reused), the region
    // asked once, the image to fill in.
    mustSay: ["project", "region", "image"],
  },
  {
    request: "Host shop-api on Cloud Run with a Postgres database",
    tools: ["find_offerings", "plan_order", "propose_cart"],
    cart: ["gcp-app-hosting-create", "gcp-cloud-sql-create"],
  },
  {
    // Asked for plainly, the sample's ticket goes in the cart.
    request: "Open a test ticket for my team with the sample ticket product",
    tools: ["find_offerings", "propose_cart"],
    cart: ["local-ticket-open"],
  },
  {
    // Judgment: the only ticket product is a sample that opens a pretend
    // ticket. Haiku (2026-10-28) once declined without looking in the
    // catalog, once proposed the sample saying it's pretend: what's judged
    // is that it looks, and says so, not whether it proposes.
    request: "Open a ticket for my team: the nightly build is broken",
    tools: ["find_offerings"],
    mustSay: ["sample"],
  },
  {
    // Nothing in the catalog makes a Kafka cluster: say so, propose nothing.
    request: "I need a Kafka cluster for my team",
    tools: ["find_offerings"],
    cart: null,
  },
];
