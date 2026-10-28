// SPDX-License-Identifier: MIT
/** ChatService (proto/vertra/console/v1/chat.proto): src/chat/agent.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { ask } from "../../chat/agent.js";
import { listChatFeedback, rateAnswer } from "../../core/chatFeedback.js";
import { config } from "../../config.js";
import type { ChatService } from "../../gen/vertra/console/v1/chat_pb.js";
import { callerOf, logOf } from "../context.js";
import { timestamp } from "../convert.js";
import { check } from "../validate.js";

const Turn = Type.Object({ role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]), content: Type.String({ minLength: 1, maxLength: 4000 }) });

export function chatService(): ServiceImpl<typeof ChatService> {
  return {
    getChatSettings() {
      return { enabled: config.chat !== null, model: config.chat?.model ?? "" };
    },

    async rateAnswer(req, ctx) {
      const valid = check(
        {
          rating: Type.Union([Type.Literal("up"), Type.Literal("down")]),
          team: Type.String({ maxLength: 253 }),
          question: Type.String({ minLength: 1, maxLength: 4000 }),
          answer: Type.String({ maxLength: 20000 }),
          model: Type.String({ maxLength: 200 }),
          comment: Type.String({ maxLength: 2000 }),
          steps: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 40 }),
        },
        { rating: req.rating, team: req.team, question: req.question, answer: req.answer, model: req.model, comment: req.comment, steps: req.steps },
      );
      return rateAnswer(callerOf(ctx), {
        ...valid,
        team: valid.team || null,
        comment: valid.comment || null,
        citations: req.citations.slice(0, 40).map((c) => ({ id: c.id, title: c.title, heading: c.heading, kind: c.kind, link: c.link })),
      });
    },

    async listChatFeedback(req, ctx) {
      const { rating } = check({ rating: Type.Union([Type.Literal(""), Type.Literal("up"), Type.Literal("down")]) }, { rating: req.rating });
      const ratings = await listChatFeedback(callerOf(ctx), { rating: rating || undefined });
      return {
        ratings: ratings.map((r) => ({
          id: r.id,
          rating: r.rating,
          team: r.team ?? "",
          question: r.question,
          answer: r.answer,
          citations: r.citations.map((c) => ({ ...c, guide: "" })),
          steps: r.steps,
          model: r.model,
          comment: r.comment ?? "",
          email: r.email ?? "",
          createdAt: timestamp(r.createdAt),
        })),
      };
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
