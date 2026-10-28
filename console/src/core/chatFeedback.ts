// SPDX-License-Identifier: MIT
/**
 * Ratings of the chat agent's answers (decision 24, Correctness; db's
 * chatFeedback): anyone who can ask may rate an answer they got, sending
 * the question and answer with it; only admins read them. The agent keeps
 * nothing itself, so a rating is the one place a conversation is kept,
 * and only because the person chose to send it. Kept 90 days.
 */
import { Code } from "@connectrpc/connect";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { ApiError } from "../apiError.js";
import { ensureTeamMember } from "../auth/access.js";
import type { AuthUser } from "../auth/plugin.js";
import { db } from "../db/client.js";
import { findTeamByName } from "../db/queries.js";
import { chatFeedback, users } from "../db/schema.js";

export interface Rating {
  rating: "up" | "down";
  team: string | null;
  question: string;
  answer: string;
  citations: { id: string; title: string; heading: string; kind: string; link: string }[];
  steps: string[];
  model: string;
  comment: string | null;
}

function signedIn(caller: AuthUser | undefined): AuthUser {
  if (!caller) throw new ApiError(401, "UNAUTHORIZED", "Sign in first.", Code.Unauthenticated);
  return caller;
}

/** Records a rating of an answer the caller got. */
export async function rateAnswer(caller: AuthUser | undefined, rating: Rating): Promise<{ id: string }> {
  const who = signedIn(caller);
  if (rating.team) {
    ensureTeamMember(who, rating.team);
    if (!(await findTeamByName(rating.team))) throw new ApiError(404, "NOT_FOUND", `No team named "${rating.team}".`, Code.NotFound);
  }
  const [made] = await db
    .insert(chatFeedback)
    .values({ ...rating, userId: who.id })
    .returning({ id: chatFeedback.id });
  return { id: made?.id ?? "" };
}

export interface RatingView extends Rating {
  id: string;
  /** Who rated it; null once their account is gone. */
  email: string | null;
  createdAt: Date;
}

/** The ratings, newest first, at most 200: admins only. */
export async function listChatFeedback(caller: AuthUser | undefined, filter: { rating?: "up" | "down" | undefined }): Promise<RatingView[]> {
  const who = signedIn(caller);
  if (!who.isAdmin) throw new ApiError(403, "FORBIDDEN", "Only admins read the chat's ratings.");
  const where: (SQL | undefined)[] = [filter.rating ? eq(chatFeedback.rating, filter.rating) : undefined];
  const rows = await db
    .select({ f: chatFeedback, email: users.email })
    .from(chatFeedback)
    .leftJoin(users, eq(users.id, chatFeedback.userId))
    .where(and(...where))
    .orderBy(desc(chatFeedback.createdAt))
    .limit(200);
  return rows.map(({ f, email }) => ({
    id: f.id,
    rating: f.rating,
    team: f.team,
    question: f.question,
    answer: f.answer,
    citations: f.citations,
    steps: f.steps,
    model: f.model,
    comment: f.comment,
    email,
    createdAt: f.createdAt,
  }));
}
