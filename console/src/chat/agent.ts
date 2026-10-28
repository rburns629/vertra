// SPDX-License-Identifier: MIT
/**
 * The chat agent (decision 24): one answer to the person's latest message,
 * the model calling the tools (tools.ts) as many times as it needs, up to
 * config.chat.maxSteps, each as the person. Its answer's citations are
 * checked against what it retrieved (citations.ts). It never orders
 * anything: a cart it proposes is the person's to open and place.
 *
 * Stateless: the panel sends the conversation's messages (text only) with
 * each question, and nothing is kept here; the steps it took are logged
 * (which tools, how many sources, whether it cited them), not what was
 * said.
 */
import { Code } from "@connectrpc/connect";
import type { FastifyBaseLogger } from "fastify";
import { ApiError } from "../apiError.js";
import { ensureMayOrder } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { config } from "../config.js";
import { checkCitations, type Citation } from "./citations.js";
import { chatModel, ModelUnavailable, type ChatMessage, type ChatModel } from "./model.js";
import { forModel, runTool, toolSpecs, type TurnState } from "./tools.js";

export interface AskRequest {
  /** The team the person is working for, if they've chosen one. */
  team: string | null;
  /** The conversation so far, oldest first, the person's question last. */
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface Answer {
  text: string;
  citations: Citation[];
  /** It searched the docs and cites nothing it found: not from the docs. */
  uncited: boolean;
  /** A cart it proposes: the person opens it, and places the order. */
  cart: { team: string; actions: string[] } | null;
  /** What it did, in order: each tool and whether it worked. */
  steps: { tool: string; ok: boolean }[];
  model: string;
}

const MAX_MESSAGES = 40;
const MAX_MESSAGE = 4000;

function systemPrompt(caller: AuthUser, team: string | null): string {
  return [
    "You are the assistant in Vertra's console. Vertra runs teams' reviewed products (containers) as steps of runs, from a catalog; people order what they need from it.",
    `Today is ${new Date().toISOString().slice(0, 10)}. The person is in ${caller.teamNames.length > 0 ? `teams ${caller.teamNames.join(", ")}` : "no team"}${caller.isAdmin ? ", and is an admin" : ""}${team ? `; they're working for team ${team}` : ""}.`,
    "Rules:",
    "- Facts about this platform come only from your tools. Never answer from memory what a team has, what a run did, what an offering needs or what the docs say.",
    "- For a question about how Vertra works or how to do something, use search_docs (and read_doc_section if an excerpt isn't enough), answer only from what they return, and cite each fact's section by its id in brackets, like [S2]. If they return nothing that answers it, say the docs don't cover it. Don't invent sources or links.",
    "- Design history (kind history) says why something was decided, with options that were rejected: never present it as how things work now.",
    "- To help someone order: find_offerings, describe_offering, list_team_resources to see what they already have, plan_order, then propose_cart. Say what was added because something needs it, what they can reuse, what's suggested, and what they'll fill in. You never place orders: they open the cart and place it.",
    "- If a tool refuses (not shared, not their team), say so plainly; don't work around it.",
    "- Be brief and concrete. Use the person's words for things, then Vertra's.",
  ].join("\n");
}

function checked(caller: AuthUser | undefined, request: AskRequest): { who: AuthUser; team: string | null } {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  // An ordering bot orders its templates, and nothing else (decision 23).
  ensureMayOrder(caller);
  const { messages, team } = request;
  if (messages.length === 0 || messages.length > MAX_MESSAGES || messages.at(-1)?.role !== "user") {
    throw new ApiError(400, "BAD_REQUEST", `Send 1 to ${String(MAX_MESSAGES)} messages, the person's question last.`);
  }
  if (messages.some((m) => m.content.length === 0 || m.content.length > MAX_MESSAGE)) {
    throw new ApiError(400, "BAD_REQUEST", `Each message is 1 to ${String(MAX_MESSAGE)} characters.`);
  }
  if (team && !caller.isAdmin && !caller.teamNames.includes(team)) {
    throw new ApiError(403, "FORBIDDEN", `You aren't a member of team "${team}".`);
  }
  return { who: caller, team: team || null };
}

/** The person's latest question answered. `model`: the install's, unless given (tests). */
export async function ask(caller: AuthUser | undefined, request: AskRequest, log: FastifyBaseLogger, model: ChatModel | null = chatModel()): Promise<Answer> {
  const { who, team } = checked(caller, request);
  if (!model) throw new ApiError(503, "CHAT_OFF", "The chat agent isn't set up on this install: an admin sets chat.model.", Code.Unavailable);
  const started = Date.now();
  const state: TurnState = { caller: who, team, log, sources: [], cart: null };
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(who, team) },
    // Earlier answers' citations named that turn's sources, not this one's.
    ...request.messages.map((m) => ({ role: m.role, content: m.role === "assistant" ? m.content.replace(/\s*\[S\d+(?:,\s*S\d+)*\]/g, "") : m.content })),
  ];
  const steps: Answer["steps"] = [];
  const maxSteps = config.chat?.maxSteps ?? 8;
  let text: string | null = null;
  try {
    for (let i = 0; i < maxSteps; i++) {
      const reply = await model.complete(messages, toolSpecs);
      if (reply.toolCalls.length === 0) {
        text = reply.content;
        break;
      }
      messages.push({ role: "assistant", content: reply.content, toolCalls: reply.toolCalls });
      for (const call of reply.toolCalls) {
        const { result, ok } = await runTool(state, call.name, call.arguments);
        steps.push({ tool: call.name, ok });
        messages.push({ role: "tool", toolCallId: call.id, content: forModel(result) });
      }
    }
    // Out of steps: an answer from what it has, with no more tools.
    if (text === null) {
      messages.push({ role: "user", content: "Answer now from what the tools have returned, saying what you couldn't find out." });
      text = (await model.complete(messages, [])).content;
    }
  } catch (error) {
    if (error instanceof ModelUnavailable) {
      log.warn({ event: "chat_model_unavailable", model: model.name, err: error }, "the chat model didn't answer");
      throw new ApiError(503, "MODEL_UNAVAILABLE", "The chat model didn't answer. Try again in a moment.", Code.Unavailable);
    }
    throw error;
  }
  const result = checkCitations(text || "I couldn't put an answer together.", state.sources);
  log.info(
    {
      event: "chat_answered",
      model: model.name,
      steps: steps.map((s) => s.tool),
      sources: state.sources.length,
      citations: result.citations.length,
      invented: result.invented.length,
      uncited: result.uncited,
      cart: state.cart !== null,
      ms: Date.now() - started,
    },
    "the chat agent answered",
  );
  return { text: result.text, citations: result.citations, uncited: result.uncited, cart: state.cart, steps, model: model.name };
}
