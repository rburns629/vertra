// SPDX-License-Identifier: MIT
/**
 * The chat agent (src/chat/): its loop, its tools and its checks, with a
 * scripted model standing in for a real one (each reply a function of what
 * it was sent), on the real test database and the image's docs. What a real
 * model says is scored separately (decision 24, Correctness): here, that
 * whatever it says, the facts and the checks are the platform's.
 */
import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ask } from "../src/chat/agent.js";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicMessages, ModelUnavailable, OpenAICompatible, withoutThinking, type ChatMessage, type ChatModel, type ModelReply } from "../src/chat/model.js";
import type { AuthUser } from "../src/auth/plugin.js";
import { db } from "../src/db/client.js";
import { createTeam, upsertProduct } from "../src/db/queries.js";
import { products, resources, teams } from "../src/db/schema.js";
import { buildApp } from "../src/index.js";
import { caller, rpcClient } from "./rpc.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;
const prefix = `chat-${randomUUID().slice(0, 6)}`;
const mine = `${prefix}-mine`;
const theirs = `${prefix}-theirs`;

/** A model whose replies are functions of what it's sent, in order; it records what it saw. */
class Scripted implements ChatModel {
  readonly name = "scripted";
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly replies: ((sent: ChatMessage[]) => Partial<ModelReply>)[]) {}
  complete(messages: ChatMessage[]): Promise<ModelReply> {
    this.seen.push([...messages]);
    const next = this.replies.shift();
    if (!next) return Promise.resolve({ content: "(out of script)", toolCalls: [], finishReason: "stop" });
    return Promise.resolve({ content: "", toolCalls: [], finishReason: "stop", ...next(messages) });
  }
}

const call = (name: string, args: Record<string, unknown>, id = "c1") => () => ({ toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const say = (content: string) => () => ({ content });
/** The last tool result the model was sent, parsed. */
const lastResult = (sent: ChatMessage[]): Record<string, unknown> => {
  const last = [...sent].reverse().find((m) => m.role === "tool");
  return JSON.parse(last?.content ?? "{}") as Record<string, unknown>;
};

const person = (teamNames: string[], extra: Partial<AuthUser> = {}): AuthUser => ({
  id: randomUUID(),
  teamNames,
  maintainerOf: [],
  isAdmin: false,
  scopes: [],
  ...extra,
});
const question = (content: string, team: string | null = mine) => ({ team, messages: [{ role: "user" as const, content }] });

let app: FastifyInstance;
const users = rpcClient(() => app);
const rpc = caller(() => app);

beforeAll(async () => {
  app = await buildApp();
  const team = await createTeam(mine);
  await createTeam(theirs);
  await upsertProduct({
    name: `${mine}-bucket-create`,
    image: `registry.example/${mine}/bucket:1`,
    action: "create",
    teamId: team.id,
    displayName: "Storage bucket",
    description: "A bucket for files.",
    inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "The bucket's name." } } },
  });
  // Theirs alone: their product's, made for them (a product's own team sees what it made).
  await db.insert(resources).values({
    product: `${theirs}-bucket-create`,
    productTeam: theirs,
    type: "demo/bucket",
    externalId: `${prefix}-their-secret-bucket`,
    ownerTeam: theirs,
    executionId: randomUUID(),
    taskId: "bucket",
  });
});

afterAll(async () => {
  await db.delete(resources).where(like(resources.externalId, `${prefix}%`));
  await db.delete(products).where(like(products.name, `${prefix}%`));
  await db.delete(teams).where(like(teams.name, `${prefix}%`));
  await users.cleanUp();
  await app.close();
});

describe("answering from the docs", () => {
  it("cites what it retrieved, linked by the console, and drops what it didn't", async () => {
    const model = new Scripted([
      call("search_docs", { query: "how do I back up the databases" }),
      (sent) => {
        const found = (lastResult(sent)["found"] ?? []) as { id: string; section: string }[];
        const backups = found.find((f) => f.section === "Backups");
        return { content: `Back up both databases [${backups?.id ?? "S0"}], restore with pg_restore [S42].` };
      },
    ]);
    const answer = await ask(person([mine]), question("How do I back up?"), log, model);
    expect(answer.citations).toMatchObject([{ guide: "reference-operations", heading: "Backups", link: "/docs/reference-operations#backups" }]);
    expect(answer.text).not.toContain("S42");
    expect(answer.uncited).toBe(false);
    // Its own search, after the console's first one.
    expect(answer.steps).toEqual([{ tool: "search_docs", ok: true }, { tool: "search_docs", ok: true }]);
  });

  it("searches first, so a model that never searches still answers from the docs", async () => {
    const model = new Scripted([
      (sent) => {
        const found = (lastResult(sent)["found"] ?? []) as { id: string; section: string }[];
        return { content: `Nightly dumps [${found.find((f) => f.section === "Backups")?.id ?? "S0"}].` };
      },
    ]);
    const answer = await ask(person([mine]), question("how do I back up the databases"), log, model);
    expect(answer.steps).toEqual([{ tool: "search_docs", ok: true }]);
    expect(answer.citations).toMatchObject([{ heading: "Backups" }]);
  });

  it("asks once for an uncited or empty answer again, keeping the repair only when it's cited", async () => {
    const cited = new Scripted([say("Back up nightly."), (sent) => {
      const first = (JSON.parse(sent.find((m) => m.role === "tool")?.content ?? "{}") as { found?: { id: string }[] }).found?.[0]?.id ?? "S0";
      return { content: `Back up nightly [${first}].` };
    }]);
    const repaired = await ask(person([mine]), question("how do I back up the databases"), log, cited);
    expect(repaired).toMatchObject({ uncited: false, steps: [{ tool: "search_docs" }, { tool: "repair", ok: true }] });

    const stubborn = await ask(person([mine]), question("how do I back up the databases"), log, new Scripted([say("Back up nightly."), say("Still nightly.")]));
    expect(stubborn).toMatchObject({ text: "Back up nightly.", uncited: true, steps: [{ tool: "search_docs" }, { tool: "repair", ok: false }] });

    const empty = await ask(person([mine]), question("how do I back up the databases"), log, new Scripted([say(""), say("The docs don't cover that.")]));
    expect(empty.text).toBe("The docs don't cover that.");
  });

  it("flags an answer that searched and cites nothing", async () => {
    const model = new Scripted([call("search_docs", { query: "backups" }), say("Back up nightly.")]);
    expect((await ask(person([mine]), question("Backups?"), log, model)).uncited).toBe(true);
  });

  it("leaves design history out unless asked why", async () => {
    const model = new Scripted([call("search_docs", { query: "rejected temporal message broker decisions" }), say("ok")]);
    await ask(person([mine]), question("Why not Temporal?"), log, model);
    const found = (lastResult(model.seen[1] ?? [])["found"] ?? []) as { kind: string }[];
    expect(found.some((f) => f.kind === "history")).toBe(false);
  });

  it("strips earlier answers' citations from what the model is sent", async () => {
    const model = new Scripted([say("Yes.")]);
    await ask(person([mine]), { team: mine, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "It is [S1, S2]." }, { role: "user", content: "b" }] }, log, model);
    expect(model.seen[0]?.find((m) => m.role === "assistant")?.content).toBe("It is.");
  });
});

describe("what it sees and does", () => {
  it("sees only what the person may: another team's resources aren't there", async () => {
    const model = new Scripted([call("list_team_resources", { team: theirs }), say("done")]);
    await ask(person([mine]), question("What has the other team got?"), log, model);
    const result = lastResult(model.seen[1] ?? []);
    expect(JSON.stringify(result)).not.toContain("their-secret-bucket");
  });

  it("proposes a cart of actions shared with them, and refuses one that isn't", async () => {
    const ok = await ask(person([mine]), question("A bucket please"), log, new Scripted([call("propose_cart", { actions: [`${mine}-bucket-create`] }), say("Open the cart."), say("Open the cart.")]));
    expect(ok.cart).toEqual({ team: mine, actions: [`${mine}-bucket-create`] });

    const outsider = new Scripted([call("propose_cart", { actions: [`${mine}-bucket-create`] }), say("Couldn't.")]);
    const refused = await ask(person([theirs]), question("A bucket please", theirs), log, outsider);
    expect(refused.cart).toBeNull();
    expect(refused.steps.filter((x) => x.tool === "propose_cart")).toEqual([{ tool: "propose_cart", ok: false }]);
    expect(String(lastResult(outsider.seen[1] ?? [])["error"])).toContain("shared");
  });

  it("describes an action from the catalog, not from the model", async () => {
    const model = new Scripted([call("describe_offering", { name: `${mine}-bucket-create` }), say("It needs a name.")]);
    await ask(person([mine]), question("What does the bucket need?"), log, model);
    expect(lastResult(model.seen[1] ?? [])).toMatchObject({ title: "Storage bucket", inputs: [{ name: "name", required: true }] });
  });

  it("answers a bad tool call with what was wrong, and carries on", async () => {
    const model = new Scripted([
      call("drop_database", {}),
      () => ({ toolCalls: [{ id: "c2", name: "search_docs", arguments: "{not json" }] }),
      say("Sorry."),
    ]);
    const answer = await ask(person([mine]), question("x"), log, model);
    expect(answer.steps.slice(1, 3)).toEqual([{ tool: "drop_database", ok: false }, { tool: "search_docs", ok: false }]);
    expect(answer.text).toBe("Sorry.");
  });

  it("stops at its step limit and answers from what it has", async () => {
    const model = new Scripted([...Array.from({ length: 8 }, () => call("search_docs", { query: "dag" })), say("Here's what I found.")]);
    const answer = await ask(person([mine]), question("loop"), log, model);
    // The console's search, the model's eight, and a repair it didn't take.
    expect(answer.steps.filter((x) => x.tool === "search_docs")).toHaveLength(9);
    expect(answer.text).toBe("Here's what I found.");
  });
});

describe("who it answers", () => {
  it("refuses an ordering bot, someone outside the team, and says when the model's away", async () => {
    await expect(ask(person([mine], { orderTemplates: [] }), question("x"), log, new Scripted([]))).rejects.toMatchObject({ code: "ORDERS_ONLY" });
    await expect(ask(person([theirs]), question("x", mine), log, new Scripted([]))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const away: ChatModel = { name: "away", complete: () => Promise.reject(new ModelUnavailable("down")) };
    await expect(ask(person([mine]), question("x"), log, away)).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
    await expect(ask(person([mine]), question("x"), log, null)).rejects.toMatchObject({ code: "CHAT_OFF" });
  });

  it("is off over the API when no model is set", async () => {
    const token = await users.signIn((await users.makeUser()).email);
    expect((await rpc<{ enabled: boolean }>(token, "ChatService/GetChatSettings", {})).body.enabled ?? false).toBe(false);
    expect((await rpc(token, "ChatService/Ask", { messages: [{ role: "user", content: "hi" }] })).failure).toBe("CHAT_OFF");
  });
});

describe("the openai-compatible model", () => {
  it("sends the tools and reads tool calls, without the model's thinking", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = vi.fn((_url: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: { content: "<think>hmm</think>Looking.", tool_calls: [{ id: "t1", function: { name: "search_docs", arguments: '{"query":"x"}' } }] },
              },
            ],
          }),
        ),
      );
    });
    const model = new OpenAICompatible({ endpoint: "http://m/v1", model: "qwen", apiKey: "", timeoutSeconds: 5, maxTokens: 100 }, fetchFn as unknown as typeof fetch);
    const reply = await model.complete([{ role: "user", content: "hi" }], [{ name: "search_docs", description: "d", parameters: { type: "object" } }]);
    expect(reply).toEqual({ content: "Looking.", toolCalls: [{ id: "t1", name: "search_docs", arguments: '{"query":"x"}' }], finishReason: "tool_calls" });
    expect(body).toMatchObject({ model: "qwen", tools: [{ type: "function", function: { name: "search_docs" } }] });
    expect(withoutThinking("<think>a\nb</think>\nAnswer")).toBe("Answer");
  });

  it("says when the model can't be reached", async () => {
    const down = new OpenAICompatible({ endpoint: "http://m/v1", model: "q", apiKey: "", timeoutSeconds: 5, maxTokens: 10 }, (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    await expect(down.complete([{ role: "user", content: "x" }], [])).rejects.toBeInstanceOf(ModelUnavailable);
  });
});

describe("the anthropic model", () => {
  const options = { model: "claude-haiku-5-5", apiKey: "test", endpoint: "", timeoutSeconds: 5, maxTokens: 8000, effort: null };
  /** A client whose messages.create answers with `reply`, recording each request. */
  const fakeClient = (reply: unknown) => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      messages: {
        create: (body: Record<string, unknown>) => {
          sent.push(body);
          return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
        },
      },
    } as unknown as Anthropic;
    return { client, sent };
  };

  it("sends the conversation in the Messages API's shape: Claude's own turns unchanged, a turn's results together", () => {
    const raw = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t1", name: "search_docs", input: { query: "x" } }];
    const { system, messages } = AnthropicMessages.messagesOf([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "first", name: "search_docs", arguments: '{"query":"hi"}' }] },
      { role: "tool", toolCallId: "first", content: "{}" },
      { role: "assistant", content: "", toolCalls: [], raw },
      { role: "tool", toolCallId: "t1", content: "a" },
      { role: "tool", toolCallId: "t2", content: "b" },
    ]);
    expect(system).toBe("Be brief.");
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "first", name: "search_docs", input: { query: "hi" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "first", content: "{}" }] },
      { role: "assistant", content: raw },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a" }, { type: "tool_result", tool_use_id: "t2", content: "b" }] },
    ]);
  });

  it("reads Claude's reply, thinking kept to send back, and asks for no tools when told", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "search_docs", input: { query: "x" } },
    ];
    const { client, sent } = fakeClient({ content, stop_reason: "tool_use" });
    const model = new AnthropicMessages(options, client);
    const tools = [{ name: "search_docs", description: "d", parameters: { type: "object" } }];
    const reply = await model.complete([{ role: "system", content: "s" }, { role: "user", content: "hi" }], tools);
    expect(reply).toEqual({ content: "Looking.", toolCalls: [{ id: "t1", name: "search_docs", arguments: '{"query":"x"}' }], finishReason: "tool_use", raw: content });
    expect(sent[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 8000, system: "s", cache_control: { type: "ephemeral" }, tools: [{ name: "search_docs", input_schema: { type: "object" } }] });
    expect(sent[0]).not.toHaveProperty("tool_choice");
    await model.complete([{ role: "user", content: "hi" }], tools, { noTools: true });
    expect(sent[1]).toMatchObject({ tool_choice: { type: "none" } });
  });

  it("says a refusal, and an API it can't reach", async () => {
    const refused = new AnthropicMessages(options, fakeClient({ content: [], stop_reason: "refusal" }).client);
    expect((await refused.complete([{ role: "user", content: "x" }], [])).content).toBe("I can't help with that one.");
    const down = new AnthropicMessages(options, fakeClient(new Anthropic.APIConnectionError({ message: "down" })).client);
    await expect(down.complete([{ role: "user", content: "x" }], [])).rejects.toBeInstanceOf(ModelUnavailable);
  });
});
