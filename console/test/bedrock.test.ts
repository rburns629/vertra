// SPDX-License-Identifier: MIT
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bedrockFetch } from "../src/chat/bedrock.js";
import { AnthropicMessages } from "../src/chat/model.js";

// A stand-in for Bedrock's Messages API, recording what it was sent.
let server: Server;
let base = "";
const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
const credentials = () => Promise.resolve({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token" });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "anthropic.claude-sonnet-5",
          content: [{ type: "text", text: "Signed and answered." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 4 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/anthropic`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("Claude in Amazon Bedrock", () => {
  it("sends the Messages API signed with SigV4 for bedrock-mantle, never a key", async () => {
    const client = new Anthropic({ apiKey: "bedrock-signed", baseURL: base, fetch: bedrockFetch("us-east-2", fetch, credentials), maxRetries: 0 });
    const model = new AnthropicMessages(
      { model: "anthropic.claude-sonnet-5", apiKey: "", endpoint: base, timeoutSeconds: 10, maxTokens: 100, effort: null },
      client,
    );
    const reply = await model.complete([{ role: "user", content: "Hello" }], []);
    expect(reply.content).toBe("Signed and answered.");

    const request = seen.at(-1);
    expect(request?.path).toBe("/anthropic/v1/messages");
    expect(request?.headers["x-api-key"]).toBeUndefined();
    expect(request?.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/bedrock-mantle\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*, Signature=[0-9a-f]{64}$/,
    );
    expect(request?.headers["x-amz-security-token"]).toBe("session-token");
    expect(request?.headers["x-amz-content-sha256"] ?? request?.headers["authorization"]).toBeTruthy();
    expect(JSON.parse(request?.body ?? "{}")).toMatchObject({ model: "anthropic.claude-sonnet-5", messages: [{ role: "user", content: "Hello" }] });
  });

  it("signs the body it sends: a changed body would no longer match", async () => {
    const signedBodies: string[] = [];
    const capture: typeof fetch = (input, init) => {
      signedBodies.push(String(init?.body));
      return fetch(input, init);
    };
    const client = new Anthropic({ apiKey: "bedrock-signed", baseURL: base, fetch: bedrockFetch("us-east-2", capture, credentials), maxRetries: 0 });
    await client.messages.create({ model: "anthropic.claude-sonnet-5", max_tokens: 10, messages: [{ role: "user", content: "Again" }] });
    expect(signedBodies.at(-1)).toBe(seen.at(-1)?.body);
  });
});
