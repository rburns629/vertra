// SPDX-License-Identifier: MIT
/**
 * The chat agent's model (decision 24): one interface, so the agent's loop,
 * its tools and its checks are the same whatever answers. Behind it, one
 * adapter per API shape, not per cloud: openai-compatible here (LM Studio,
 * Ollama, Gemini on Vertex's compatible endpoint); Anthropic's format
 * (Claude direct, on Vertex, on Bedrock) when it's wanted. A cloud's
 * sign-in (a key from a Secret here; workload identity later) is the
 * adapter's, never the agent's.
 */
import { config } from "../config.js";

export interface ToolCall {
  id: string;
  name: string;
  /** As the model wrote them: JSON, unchecked. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
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
}

export interface ChatModel {
  readonly name: string;
  complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<ModelReply>;
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

  async complete(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): Promise<ModelReply> {
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
        ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
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

/** The install's model, or null when chat is off. */
export function chatModel(): ChatModel | null {
  const c = config.chat;
  return c ? new OpenAICompatible(c) : null;
}
