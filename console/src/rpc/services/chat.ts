// SPDX-License-Identifier: MIT
/** ChatService (proto/vertra/console/v1/chat.proto): src/chat/agent.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { ask } from "../../chat/agent.js";
import { config } from "../../config.js";
import type { ChatService } from "../../gen/vertra/console/v1/chat_pb.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";

const Turn = Type.Object({ role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), content: Type.String({ minLength: 1, maxLength: 4000 }) });

export function chatService(): ServiceImpl<typeof ChatService> {
  return {
    getChatSettings() {
      return { enabled: config.chat !== null, model: config.chat?.model ?? "" };
    },

    async ask(req, ctx) {
      const { messages, team } = check(
        { messages: Type.Array(Turn, { minItems: 1, maxItems: 40 }), team: Type.String({ maxLength: 253 }) },
        { messages: req.messages.map((m) => ({ role: m.role, content: m.content })), team: req.team },
      );
      const answer = await ask(callerOf(ctx), { team: team || null, messages }, logOf(ctx));
      return {
        text: answer.text,
        citations: answer.citations,
        uncited: answer.uncited,
        ...(answer.cart ? { cart: answer.cart } : {}),
        steps: answer.steps,
        model: answer.model,
      };
    },
  };
}
