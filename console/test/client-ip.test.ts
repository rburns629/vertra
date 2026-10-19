// SPDX-License-Identifier: MIT
/**
 * Who the client is behind a load balancer (config.trustProxy): with
 * Google's front ends and the load balancer's address trusted, the client is
 * the address the load balancer appended, not one a client wrote into
 * X-Forwarded-For itself; with nothing trusted (the default), or a
 * connection from anywhere else, the header is ignored.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";

let app: FastifyInstance | undefined;
const original = config.trustProxy;
const GOOGLE = ["35.191.0.0/16", "130.211.0.0/22", "34.120.1.2"];

afterEach(async () => {
  config.trustProxy = original;
  await app?.close();
});

async function clientIp(trusted: string[], forwardedFor: string, from = "35.191.0.10"): Promise<string> {
  config.trustProxy = trusted;
  app = await buildApp();
  app.get("/test-client-ip", async (request) => ({ ip: request.ip }));
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: "/test-client-ip",
    remoteAddress: from, // by default a Google front end
    headers: { "x-forwarded-for": forwardedFor },
  });
  return response.json<{ ip: string }>().ip;
}

describe("the client's address", () => {
  it("behind Google's load balancer is the one it appended, whatever the client wrote", async () => {
    expect(await clientIp(GOOGLE, "6.6.6.6, 203.0.113.7, 34.120.1.2")).toBe("203.0.113.7");
  });

  it("is the connection's by default", async () => {
    expect(await clientIp([], "203.0.113.7, 34.120.1.2")).toBe("35.191.0.10");
  });

  it("is the connection's when it doesn't come through the load balancer", async () => {
    expect(await clientIp(GOOGLE, "203.0.113.7, 34.120.1.2", "198.51.100.9")).toBe("198.51.100.9");
  });
});
