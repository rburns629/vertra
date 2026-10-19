// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { cachedImageCount, checkImage, parseImageRef, pinImages } from "../src/registry.js";

// A fake registry behind a stubbed fetch: GAR-style token auth, where an
// anonymous HEAD gets a Bearer challenge, the token service takes Basic
// credentials, and the manifest answers 200 or 404.
const HOST = "us-central1-docker.pkg.dev";
const CREDENTIAL = { username: "_json_key", password: "secret" };
const ALLOWED = [`${HOST}/proj/catalog-products/`];
const DIGEST = `sha256:${"a".repeat(64)}`;
const EXPECTED_BASIC = `Basic ${Buffer.from("_json_key:secret").toString("base64")}`;

interface Call {
  url: string;
  authorization: string | undefined;
}
let calls: Call[];
let existing: Set<string>;
let realm: string;

function fakeRegistry(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
  calls.push({ url: url.href, authorization });
  if (url.pathname === "/v2/token") {
    return Promise.resolve(
      authorization === EXPECTED_BASIC
        ? Response.json({ token: "registry-token" })
        : new Response(null, { status: 401 }),
    );
  }
  if (authorization !== "Bearer registry-token") {
    return Promise.resolve(
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": `Bearer realm="${realm}",service="${HOST}"` },
      }),
    );
  }
  return Promise.resolve(
    existing.has(url.pathname)
      ? new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } })
      : new Response(null, { status: 404 }),
  );
}

/** A fresh image name, so the one-minute cache never answers for another test. */
function image(): { ref: string; manifestPath: string } {
  const name = `product-${randomUUID().slice(0, 8)}`;
  return { ref: `${HOST}/proj/catalog-products/${name}:abc`, manifestPath: `/v2/proj/catalog-products/${name}/manifests/abc` };
}

beforeEach(() => {
  calls = [];
  existing = new Set();
  realm = `https://${HOST}/v2/token`;
  config.registryCredentials.set(HOST, CREDENTIAL);
  vi.stubGlobal("fetch", vi.fn(fakeRegistry));
});

afterEach(() => {
  config.registryCredentials.clear();
  vi.unstubAllGlobals();
});

describe("parseImageRef", () => {
  it("splits registry, repository and tag or digest", () => {
    expect(parseImageRef(`${HOST}/p/r/img:1.2`)).toEqual({ host: HOST, repository: "p/r/img", reference: "1.2" });
    expect(parseImageRef("localhost:5000/img@sha256:abc")).toEqual({
      host: "localhost:5000", repository: "img", reference: "sha256:abc",
    });
    // How a submission is pinned: the tag stays for people, the digest is asked for.
    expect(parseImageRef(`${HOST}/p/img:latest@sha256:abc`)).toEqual({
      host: HOST, repository: "p/img", reference: "sha256:abc",
    });
    expect(parseImageRef("docker.io/nginx")).toEqual({
      host: "registry-1.docker.io", repository: "library/nginx", reference: "latest",
    });
  });

  it("has nothing to ask for an image with no registry host", () => {
    expect(parseImageRef("demo-1-greet-product:local")).toBeNull();
    expect(parseImageRef("team/product:1")).toBeNull();
  });
});

describe("checkImage", () => {
  it("reports an existing image as available and a deleted one as missing", async () => {
    const present = image();
    existing.add(present.manifestPath);
    expect(await checkImage(present.ref, ALLOWED)).toBe("available");
    expect(await checkImage(image().ref, ALLOWED)).toBe("missing");
  });

  it("sends the credential only to the registry's token service, never with the manifest request", async () => {
    await checkImage(image().ref, ALLOWED);
    const token = calls.filter((c) => c.url.startsWith(realm));
    expect(token).toHaveLength(1);
    expect(token[0]?.authorization).toBe(EXPECTED_BASIC);
    expect(calls.filter((c) => c.authorization === EXPECTED_BASIC)).toHaveLength(1);
  });

  it("remembers a bounded number of images", async () => {
    for (let i = 0; i < 1100; i++) await checkImage(image().ref, ALLOWED);
    expect(cachedImageCount()).toBeLessThanOrEqual(1000);
  });

  it("never contacts a registry outside the allowed sources", async () => {
    expect(await checkImage(`registry.example.com/x/${randomUUID()}:1`, ALLOWED)).toBe("unverified");
    expect(await checkImage("169.254.169.254/latest/meta-data:1", ALLOWED)).toBe("unverified");
    expect(await checkImage(`${HOST}/other-project/repo/app:1`, ALLOWED)).toBe("unverified");
    expect(await checkImage("demo-1-greet-product:local", ALLOWED)).toBe("unverified");
    expect(calls).toEqual([]);
  });

  it("asks an allowed public registry anonymously", async () => {
    config.registryCredentials.clear();
    await checkImage(image().ref, ALLOWED);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.authorization === undefined || c.authorization.startsWith("Bearer"))).toBe(true);
  });

  it("won't hand the credential to a token service on another host", async () => {
    realm = "https://attacker.example.com/token";
    expect(await checkImage(image().ref, ALLOWED)).toBe("unverified");
    expect(calls.some((c) => c.url.startsWith(realm))).toBe(false);
  });

  it("treats an unreachable registry as unverified, not missing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))));
    expect(await checkImage(image().ref, ALLOWED)).toBe("unverified");
  });
});

describe("pinImages", () => {
  it("pins a tag to the digest it names now, keeps a pinned image, and lists what it couldn't resolve", async () => {
    const tagged = image();
    existing.add(tagged.manifestPath);
    const missing = image();
    const pinnedAlready = `${HOST}/proj/catalog-products/x@sha256:${"b".repeat(64)}`;
    const outside = "registry.elsewhere.example/app:1";
    const { pinned, unresolved } = await pinImages([tagged.ref, missing.ref, pinnedAlready, outside], ALLOWED);
    expect(pinned.get(tagged.ref)).toBe(`${tagged.ref}@${DIGEST}`);
    expect(pinned.get(pinnedAlready)).toBe(pinnedAlready);
    expect(unresolved.sort()).toEqual([missing.ref, outside].sort());
  });

  it("asks a registry through its mirror, with the image host's credential", async () => {
    config.registryMirrors.set(HOST, "http://kind-registry:5000");
    try {
      const tagged = image();
      existing.add(tagged.manifestPath);
      const { pinned } = await pinImages([tagged.ref], ALLOWED);
      expect(pinned.get(tagged.ref)).toBe(`${tagged.ref}@${DIGEST}`);
      expect(calls.some((call) => call.url.startsWith("http://kind-registry:5000/v2/proj/"))).toBe(true);
      expect(calls.some((call) => call.url.startsWith(`https://${HOST}/v2/proj/`))).toBe(false);
    } finally {
      config.registryMirrors.clear();
    }
  });
});
