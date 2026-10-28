// SPDX-License-Identifier: MIT
/**
 * Scores the chat agent's answers (decision 24, Correctness) on the question
 * set (test/docQuestions.ts), against whatever model a console has: each
 * question asked through ChatService/Ask as a person would, as the token's
 * user, one at a time. For each answer: whether it cites a section that
 * answers the question, whether it's flagged as citing nothing it found,
 * what it must and mustn't say, and how long it took. Writes
 * chat-eval-results/<model>-<time>.json, to compare models and prompts.
 *
 *   VERTRA_TOKEN=... npm run chat-eval            # every question
 *   VERTRA_TOKEN=... npm run chat-eval -- 5       # the first five
 *
 * CONSOLE_URL (http://localhost:18080) and TEAM (the token's first) as needed.
 * A model's run, not CI: real models are slow, and their answers vary.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { DOC_QUESTIONS } from "../test/docQuestions.js";

const consoleUrl = (process.env["CONSOLE_URL"] ?? "http://localhost:18080").replace(/\/+$/, "");
const token = process.env["VERTRA_TOKEN"] ?? "";
const limit = Number(process.argv[2] ?? DOC_QUESTIONS.length);

interface Answer {
  text?: string;
  citations?: { guide: string; heading: string; link: string }[];
  uncited?: boolean;
  steps?: { tool: string; ok: boolean }[];
  model?: string;
  code?: string;
  message?: string;
}

async function call<T>(method: string, body: unknown): Promise<T> {
  const response = await fetch(`${consoleUrl}/api/vertra.console.v1.${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function main(): Promise<void> {
  if (!token) throw new Error("VERTRA_TOKEN: a token for the console");
  const settings = await call<{ enabled?: boolean; model?: string }>("ChatService/GetChatSettings", {});
  if (!settings.enabled) throw new Error("Chat is off on this console: set chat.model.");
  const me = await call<{ teamNames?: string[] }>("AuthService/GetMe", {});
  const team = process.env["TEAM"] ?? me.teamNames?.[0] ?? "";
  const rows = [];
  for (const q of DOC_QUESTIONS.slice(0, limit)) {
    const started = Date.now();
    const a = await call<Answer>("ChatService/Ask", { team, messages: [{ role: "user", content: q.question }] });
    const ms = Date.now() - started;
    const text = a.text ?? "";
    const cited = (a.citations ?? []).some((c) =>
      q.answers.some((answer) => {
        const [guide, heading = ""] = answer.split(" :: ");
        return c.guide === guide && c.heading.includes(heading);
      }),
    );
    const missing = (q.mustSay ?? []).filter((s) => !text.includes(s));
    const said = (q.mustNotSay ?? []).filter((s) => text.includes(s));
    const row = {
      question: q.question,
      error: a.code ? `${a.code}: ${a.message ?? ""}` : null,
      citedAnAnswer: cited,
      uncited: a.uncited ?? false,
      citations: (a.citations ?? []).map((c) => `${c.guide} :: ${c.heading}`),
      missing,
      said,
      steps: (a.steps ?? []).map((s) => (s.ok ? s.tool : `${s.tool}(failed)`)),
      seconds: Math.round(ms / 100) / 10,
      answer: text,
    };
    rows.push(row);
    console.log(
      `${row.error ? "ERROR" : row.citedAnAnswer ? "cited" : row.uncited ? "UNCITED" : "other"}  ${String(row.seconds).padStart(5)}s  ${q.question}` +
        (missing.length > 0 ? `  [missing: ${missing.join(", ")}]` : "") +
        (said.length > 0 ? `  [said: ${said.join(", ")}]` : ""),
    );
  }
  const answered = rows.filter((r) => !r.error);
  const summary = {
    model: settings.model,
    at: new Date().toISOString(),
    questions: rows.length,
    errors: rows.length - answered.length,
    citedAnAnswer: answered.filter((r) => r.citedAnAnswer).length,
    uncited: answered.filter((r) => r.uncited).length,
    mustSayMissed: rows.filter((r) => r.missing.length > 0).length,
    mustNotSaySaid: rows.filter((r) => r.said.length > 0).length,
    medianSeconds: median(rows.map((r) => r.seconds)),
    slowestSeconds: Math.max(...rows.map((r) => r.seconds)),
  };
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
  mkdirSync("chat-eval-results", { recursive: true });
  const file = `chat-eval-results/${String(settings.model).replace(/[^a-zA-Z0-9.-]/g, "_")}-${summary.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
  console.log(`Written: ${file}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
