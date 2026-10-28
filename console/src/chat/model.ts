// SPDX-License-Identifier: MIT
/**
 * The chat agent's model (decision 24): one interface, so the agent's loop,
 * its tools and its checks are the same whatever answers. Behind it, one
 * adapter per API shape, not per cloud: openai-compatible (LM Studio,
 * Ollama, Gemini on Vertex's compatible endpoint) and Anthropic's Messages
 * API (Claude, with an API key; on Vertex and Bedrock through their own
 * clients, later). A cloud's
 * sign-in (a key from a Secret here; workload identity later) is the
 * adapter's, never the agent's.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

export interface ToolCall {
  id: string;
  name: string;
  /** As the model wrote them: JSON, unchecked. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  // raw: the model's own reply, as its API gave it (Claude's thinking
  // blocks with it), sent back unchanged on the next call of the same turn.
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON Schema for an object: the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface ModelReply {
  content: string;
  toolCalls: ToolCall[];
  /** stop, tool_calls, length, content_filter: as the provider says. */
  finishReason: string;
  /** The reply as the provider gave it, for the adapter to send back. */
  raw?: unknown;
}

export interface ChatModel {
  readonly name: string;
  /** `noTools`: answer in words; the tools are still described (the history may hold their calls). */
  complete(messages: ChatMessage[], tools: ToolSpec[], options?: { noTools?: boolean; signal?: AbortSignal }): Promise<ModelReply>;
}

/** The model couldn't be reached, or answered with something unusable. */
export class ModelUnavailable extends Error {}

/** A reasoning model's thinking (Qwen's <think>...</think>): not the answer. */
export function withoutThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim();
}

/** OpenAI's chat completions, which LM Studio, Ollama and Vertex (for Gemini) speak too. */
export class OpenAICompatible implements ChatModel {
  constructor(
    private readonly options: { endpoint: string; model: string; apiKey: string; timeoutSeconds: number; maxTokens: number },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get name(): string {
    return this.options.model;
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[], options: { noTools?: boolean; signal?: AbortSignal } = {}): Promise<ModelReply> {
    const { signal } = options;
    const body = {
      model: this.options.model,
      temperature: 0.2,
      max_tokens: this.options.maxTokens,
      messages: messages.map((m) =>
        m.role === "tool"
          ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
          : m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0
            ? {
                role: "assistant",
                content: m.content,
                tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
              }
            : { role: m.role, content: m.content },
      ),
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
            ...(options.noTools ? { tool_choice: "none" } : {}),
          }
        : {}),
    };
    const timeout = AbortSignal.timeout(this.options.timeoutSeconds * 1000);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new ModelUnavailable(`The model at ${this.options.endpoint} didn't answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new ModelUnavailable(`The model answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);
    }
    const data = (await response.json()) as {
      choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
    };
    const choice = data.choices?.[0];
    if (!choice?.message) throw new ModelUnavailable("The model's answer had no message.");
    return {
      content: withoutThinking(choice.message.content ?? ""),
      toolCalls: (choice.message.tool_calls ?? []).map((c, i) => ({
        id: c.id || `call-${String(i)}`,
        name: c.function?.name ?? "",
        arguments: c.function?.arguments ?? "{}",
      })),
      finishReason: choice.finish_reason ?? "stop",
    };
  }
}

/**
 * Claude, through Anthropic's Messages API. The system prompt goes in
 * `system`; each assistant turn of the loop goes back as Claude wrote it
 * (raw, thinking blocks included, as the API requires within a turn); tool
 * results go back together in one user message. The tools and system
 * prompt are the same on every call, so the request is cached (a cached
 * read costs a tenth). Thinking is the model's own default (adaptive);
 * effort, when set, is config.chat.effort.
 */
export class AnthropicMessages implements ChatModel {
  private readonly client: Anthropic;

  constructor(
    private readonly options: { model: string; apiKey: string; endpoint: string; timeoutSeconds: number; maxTokens: number; effort: "low" | "medium" | "high" | null },
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey: options.apiKey, ...(options.endpoint ? { baseURL: options.endpoint } : {}), maxRetries: 2 });
  }

  get name(): string {
    return this.options.model;
  }

  /** The conversation in the Messages API's shape. */
  static messagesOf(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
    const system = messages.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n");
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") {
        out.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        if (m.raw !== undefined) {
          out.push({ role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] });
          continue;
        }
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const call of m.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(call.arguments || "{}");
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
        }
        if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      } else if ("toolCallId" in m) {
        const result: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
        const last = out.at(-1);
        // Every result of one turn's calls in one user message.
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
          last.content.push(result);
        } else {
          out.push({ role: "user", content: [result] });
        }
      }
    }
    return { system, messages: out };
  }

  async complete(messages: ChatMessage[], tools: ToolSpec[], options: { noTools?: boolean; signal?: AbortSignal } = {}): Promise<ModelReply> {
    const { signal } = options;
    const { system, messages: converted } = AnthropicMessages.messagesOf(messages);
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          ...(system ? { system } : {}),
          messages: converted,
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
                ...(options.noTools ? { tool_choice: { type: "none" as const } } : {}),
              }
            : {}),
          ...(this.options.effort ? { output_config: { effort: this.options.effort } } : {}),
          cache_control: { type: "ephemeral" },
        },
        { timeout: this.options.timeoutSeconds * 1000, ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new ModelUnavailable(`Claude answered ${String(error.status ?? "no status")}: ${error.message.slice(0, 300)}`);
      }
      throw error;
    }
    if (response.stop_reason === "refusal") {
      return { content: "I can't help with that one.", toolCalls: [], finishReason: "refusal" };
    }
    return {
      content: response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim(),
      toolCalls: response.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }] : [])),
      finishReason: response.stop_reason ?? "end_turn",
      raw: response.content,
    };
  }
}

/** The install's model, or null when chat is off. */
export function chatModel(): ChatModel | null {
  const c = config.chat;
  if (!c) return null;
  return c.provider === "anthropic" ? new AnthropicMessages(c) : new OpenAICompatible(c);
}
