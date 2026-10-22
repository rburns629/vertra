// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
/**
 * The whole app, routed and signed in, over a fake console API: every page
 * renders, the navigation follows who you are, and the sign-in rules hold.
 * The fake answers each `/api/vertra.console.v1.<Service>/<Method>` call
 * with canned JSON (an empty message when a test gives none), so these
 * tests check what the pages do with the API, whatever the pages look like.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { create, toBinary } from "@bufbuild/protobuf";
import { FailureSchema } from "./gen/vertra/console/v1/common_pb.js";
import { CssBaseline, ThemeProvider } from "@mui/material";
import type { ComponentType } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { theme } from "./theme";

type Answer = unknown | ((request: Record<string, unknown>) => unknown);
let answers: Record<string, Answer> = {};

/** A Connect error, as the console sends one: its Connect code, and the
 * console's stable code in a Failure detail. */
const refused = (status: number, code: string, message: string, failure?: string) => ({ refused: { status, code, message, failure } });

function connectResponse(key: string, request: Record<string, unknown>, streaming: boolean): Response {
  const answer = answers[key];
  const value = typeof answer === "function" ? (answer as (r: Record<string, unknown>) => unknown)(request) : (answer ?? {});
  if (value && typeof value === "object" && "refused" in value) {
    const { status, code, message, failure } = (value as ReturnType<typeof refused>).refused;
    const details = failure
      ? [{ type: "vertra.console.v1.Failure", value: btoa(String.fromCharCode(...toBinary(FailureSchema, create(FailureSchema, { code: failure, message })))) }]
      : undefined;
    return new Response(JSON.stringify({ code, message, details }), { status, headers: { "content-type": "application/json" } });
  }
  if (!streaming) return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  // A server stream: the end-of-stream envelope alone (no messages).
  const end = new TextEncoder().encode("{}");
  const envelope = new Uint8Array(5 + end.length);
  envelope[0] = 0b10;
  new DataView(envelope.buffer).setUint32(1, end.length);
  envelope.set(end, 5);
  return new Response(envelope, { status: 200, headers: { "content-type": "application/connect+json" } });
}

const calls: string[] = [];

beforeAll(() => {
  // Before the app's API client exists: it keeps the fetch it's given.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const match = /\/api\/vertra\.console\.v1\.(\w+)\/(\w+)$/.exec(url.pathname);
    if (!match) return new Response("not found", { status: 404 });
    const key = `${match[1]}/${match[2]}`;
    calls.push(key);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const streaming = (headers.get("content-type") ?? "").startsWith("application/connect+");
    let body: Record<string, unknown> = {};
    const raw = init?.body;
    if (typeof raw === "string") body = JSON.parse(raw || "{}") as Record<string, unknown>;
    else if (raw instanceof Uint8Array) {
      const text = new TextDecoder().decode(streaming ? raw.subarray(5) : raw);
      body = JSON.parse(text || "{}") as Record<string, unknown>;
    }
    return connectResponse(key, body, streaming);
  });
  // MUI and recharts measure; jsdom has neither of these.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // A desktop-sized window: min-width queries match (the sidebar is shown).
  window.matchMedia = ((query: string) => ({ matches: /min-width/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  answers = {};
  calls.length = 0;
});

const ADMIN = { userId: "u1", email: "ana@acme.com", teamNames: ["azure-apps"], maintainerOf: ["azure-apps"], isAdmin: true, mustChangePassword: false };
const MEMBER = { ...ADMIN, isAdmin: false, maintainerOf: [] };

let App: ComponentType;
async function renderAt(path: string, me: typeof ADMIN | null, extra: Record<string, Answer> = {}) {
  App ??= (await import("./App")).App;
  if (me) localStorage.setItem("token", "a-session");
  answers = { "AuthService/GetEnvironment": { label: "test" }, ...(me ? { "AuthService/GetMe": me } : {}), ...extra };
  render(
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** Each signed-in page, and what it needs beyond empty answers to have something to show. */
const PAGES: [string, Record<string, Answer>][] = [
  ["/", {}],
  ["/teams", {}],
  ["/teams/azure-apps", {}],
  ["/admin", {}],
  ["/account", {}],
  ["/runs", {}],
  ["/runs/submit", {}],
  ["/runs/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", {}],
  ["/catalog", {}],
  ["/products", {}],
  ["/apis", {}],
  ["/apis/payments/orders", { "ApiService/GetApi": { api: { team: "payments", name: "orders", displayName: "Orders API", mayCall: true, endpoints: [] }, openapi: "{}" } }],
  ["/observe", {}],
  [
    "/docs",
    {
      "GuideService/ListGuides": { guides: [{ id: "01-getting-started", title: "Getting started" }] },
      "GuideService/GetGuide": { markdown: "# Getting started\n\nHello." },
    },
  ],
];

describe("every page", () => {
  it.each(PAGES)("%s renders inside the app's layout", async (path, needs) => {
    await renderAt(path, ADMIN, needs);
    const main = await screen.findByRole("main");
    // The page itself, once its lazy chunk has loaded: a heading of its own.
    expect((await within(main).findAllByRole("heading", {}, { timeout: 5000 })).length).toBeGreaterThan(0);
  });
});

describe("the navigation", () => {
  it("offers Admin to admins only", async () => {
    await renderAt("/", ADMIN);
    const nav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(nav).getByRole("link", { name: /admin/i })).toBeTruthy();
    cleanup();

    await renderAt("/", MEMBER);
    const memberNav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(memberNav).queryByRole("link", { name: /admin/i })).toBeNull();
  });
});

describe("pages that moved", () => {
  it.each([
    ["/executions", "Runs"],
    ["/executions/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", "Runs"],
    ["/run?action=title-case", "Catalog"],
  ])("%s opens its new place", async (path, place) => {
    await renderAt(path, ADMIN);
    const nav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(nav).getByRole("link", { name: place }).getAttribute("aria-current")).toBe("page");
  });
});

describe("the settings menu", () => {
  it("holds Preferences, Help and guides, and Sign out; the sidebar has neither Docs nor Help", async () => {
    await renderAt("/", MEMBER);
    const nav = await screen.findByRole("navigation", { name: /main/i });
    expect(within(nav).queryByRole("link", { name: /docs|help/i })).toBeNull();
    screen.getByRole("button", { name: "Settings" }).click();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Preferences", "Help and guides", "Sign out"]);
  });
});

describe("signing in", () => {
  it("sends someone who isn't signed in to the sign-in page", async () => {
    await renderAt("/observe", null);
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: /main/i })).toBeNull();
  });

  it("treats a session the console no longer accepts as signed out", async () => {
    await renderAt("/observe", ADMIN, { "AuthService/GetMe": refused(401, "unauthenticated", "Session expired.") });
    expect(await screen.findByLabelText(/email/i)).toBeTruthy();
    expect(localStorage.getItem("token")).toBeNull();
  });

  it("offers single sign-on only when the install has it", async () => {
    await renderAt("/login", null, { "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" } });
    expect(await screen.findByRole("link", { name: /sign in with google/i })).toBeTruthy();
    cleanup();

    await renderAt("/login", null);
    await screen.findByLabelText(/email/i);
    expect(screen.queryByRole("link", { name: /sign in with google/i })).toBeNull();
  });

  it("holds someone with a password set by someone else until they choose their own", async () => {
    let changed = false;
    await renderAt("/observe", { ...MEMBER, mustChangePassword: true }, {
      "AuthService/GetMe": () => ({ ...MEMBER, mustChangePassword: !changed }),
      "AuthService/ChangePassword": () => {
        changed = true;
        return { token: "their-own-session" };
      },
    });
    expect(await screen.findByRole("heading", { name: /choose your own password/i })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: /main/i })).toBeNull();
    expect(calls).not.toContain("ObserveService/GetSecurity");

    fireEvent.change(screen.getByLabelText(/temporary password/i), { target: { value: "from-the-admin" } });
    fireEvent.change(screen.getByLabelText(/^new password \*?$/i), { target: { value: "too-short" } });
    fireEvent.change(screen.getByLabelText(/new password, again/i), { target: { value: "too-short" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    expect(await screen.findByText(/at least 12 characters: this one has 9/i)).toBeTruthy();
    expect(calls).not.toContain("AuthService/ChangePassword");

    fireEvent.change(screen.getByLabelText(/^new password \*?$/i), { target: { value: "a-long-enough-one" } });
    fireEvent.change(screen.getByLabelText(/new password, again/i), { target: { value: "a-long-enough-one" } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    expect(await screen.findByRole("navigation", { name: /main/i })).toBeTruthy();
    expect(localStorage.getItem("token")).toBe("their-own-session");
  });

  it("says when a team requires single sign-on instead of a password", async () => {
    await renderAt("/login", null, {
      "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" },
      "AuthService/Login": refused(403, "permission_denied", "payments signs in with Google: use that instead of a password.", "SSO_REQUIRED"),
    });
    fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: "lee@acme.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "their-password" } });
    fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByText(/sign in with google instead/i)).toBeTruthy();
    expect(screen.getByText(/payments signs in with google/i)).toBeTruthy();
  });
});

describe("a retired team", () => {
  it("says it's read-only, and offers an admin to un-retire it", async () => {
    await renderAt("/teams/old-team", ADMIN, {
      "TeamService/GetTeam": { team: { id: "t1", name: "old-team", retiredAt: "2026-10-21T12:00:00Z" } },
    });
    expect(await screen.findByText(/read-only/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /un-retire/i })).toBeTruthy();
  });
});

