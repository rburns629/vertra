// SPDX-License-Identifier: MIT
/**
 * The console proves who it is to kernel-api with its projected
 * ServiceAccount token (kernel/app/api/auth.py checks it). The kubelet
 * rotates the file, so it has to be read on every call, not once.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { config } from "../src/config.js";
import { getExecution } from "../src/kernel/client.js";

describe("kernel-api client", () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.spyOn>;
  const originalTokenFile = config.kernelApiTokenFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kernel-token-"));
    fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ state: "RUNNING" }), { status: 200 })));
  });

  afterEach(async () => {
    fetchMock.mockRestore();
    config.kernelApiTokenFile = originalTokenFile;
    await rm(dir, { recursive: true, force: true });
  });

  function authorizationOfCall(index: number): string | null {
    const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
    return new Headers(init?.headers).get("Authorization");
  }

  it("sends the projected token, re-read on every call", async () => {
    const tokenFile = join(dir, "token");
    config.kernelApiTokenFile = tokenFile;

    await writeFile(tokenFile, "first-token\n");
    await getExecution("e1");
    await writeFile(tokenFile, "rotated-token\n");
    await getExecution("e2");

    expect(authorizationOfCall(0)).toBe("Bearer first-token");
    expect(authorizationOfCall(1)).toBe("Bearer rotated-token");
  });

  it("sends no token when none is configured (kernel-api's check disabled)", async () => {
    config.kernelApiTokenFile = undefined;

    await getExecution("e1");

    expect(authorizationOfCall(0)).toBeNull();
  });

  it("fails rather than calling without a token when the file is missing", async () => {
    config.kernelApiTokenFile = join(dir, "missing");

    await expect(getExecution("e1")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
