// @vitest-environment jsdom
// SPDX-License-Identifier: MIT
/**
 * The whole app, routed and signed in, over a fake console API: every page
 * renders, the navigation follows who you are, and the sign-in rules hold.
 * The fake answers each `/api/vertra.console.v1.<Service>/<Method>` call
 * with canned JSON (an empty message when a test gives none), so these
 * tests check what the pages do with the API, whatever the pages look like.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  // A server stream: its messages (an answer that's a list), then its end.
  const frame = (flags: number, json: unknown) => {
    const body = new TextEncoder().encode(JSON.stringify(json));
    const envelope = new Uint8Array(5 + body.length);
    envelope[0] = flags;
    new DataView(envelope.buffer).setUint32(1, body.length);
    envelope.set(body, 5);
    return envelope;
  };
  const frames = [...(Array.isArray(value) ? value.map((m) => frame(0, m)) : []), frame(0b10, {})];
  // One byte array: jsdom's Blob isn't one Node's Response can read.
  const body = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  frames.reduce((offset, f) => {
    body.set(f, offset);
    return offset + f.length;
  }, 0);
  return new Response(body, { status: 200, headers: { "content-type": "application/connect+json" } });
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
    else if (raw && ArrayBuffer.isView(raw)) {
      // A byte array, possibly from another realm (jsdom's), so not instanceof.
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const text = new TextDecoder().decode(streaming ? bytes.subarray(5) : bytes);
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

const ADMIN = { userId: "u1", email: "ana@acme.com", teamNames: ["azure-apps"], maintainerOf: ["azure-apps"], isAdmin: true, mustChangePassword: false, hasPassword: true, usesSso: false };
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
  ["/admin?tab=scans", {}],
  ["/account", {}],
  ["/runs", {}],
  ["/runs/submit", {}],
  ["/runs/made", {}],
  ["/catalog/compose", {}],
  ["/runs/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", { "ExecutionService/WatchExecution": [{ execution: { executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", name: "a run", state: "EXECUTION_STATE_SUCCEEDED", createdAt: "2026-10-21T16:20:00Z", tasks: [] } }] }],
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
    // A code comment that slipped into JSX shows as text.
    expect(main.textContent).not.toMatch(/(^|[^:])\/\/ /);
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

describe("image scans", () => {
  const FAILED = {
    digest: "sha256:" + "a".repeat(64),
    image: "registry.example/web/site@sha256:" + "a".repeat(64),
    status: "SCAN_STATUS_FAILED",
    findings: { fixable: 1, unfixable: 0, secrets: 0, findings: [{ kind: "vulnerability", id: "CVE-2026-1", severity: "HIGH", package: "openssl", installed: "3.0.1", fixedIn: "3.0.2" }] },
  };
  const PASSED = { digest: "sha256:" + "b".repeat(64), image: "registry.example/web/api@sha256:" + "b".repeat(64), status: "SCAN_STATUS_PASSED" };

  it("filters by verdict, and opens a failed one to accept it only with a reason", async () => {
    await renderAt("/admin?tab=scans", ADMIN, { "ImageService/ListImageScans": { scans: [FAILED, PASSED] } });
    fireEvent.click(await screen.findByRole("button", { name: /^Failed 1/ }));
    expect(screen.queryByText("registry.example/web/api")).toBeNull();
    fireEvent.click(screen.getByText("registry.example/web/site"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("CVE-2026-1")).toBeTruthy();
    const accept = within(dialog).getByRole("button", { name: "Accept" });
    expect(accept.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Why it may run anyway"), { target: { value: "No fix upstream; not reachable here." } });
    expect(accept.hasAttribute("disabled")).toBe(false);
  });
});

describe("runs", () => {
  const RUN = {
    executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11",
    name: "orders-api first deploy",
    teams: ["azure-apps"],
    createdAt: "2026-10-22T14:02:00Z",
    state: "EXECUTION_STATE_RUNNING",
    template: "gcp-platform/app-on-cloud-run",
    steps: { SUCCEEDED: 2, RUNNING: 1, PENDING: 1 },
  };

  it("says what each run was and how far its steps got", async () => {
    await renderAt("/runs", MEMBER, { "ExecutionService/ListExecutions": { executions: [RUN] } });
    expect(await screen.findByRole("link", { name: "orders-api first deploy" })).toBeTruthy();
    expect(screen.getByText("app-on-cloud-run · gcp-platform")).toBeTruthy();
    expect(screen.getByText("2 of 4")).toBeTruthy();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
  });

  it("asks the server for your own runs, and lists the steps waiting for your team to approve", async () => {
    const asked: Record<string, unknown>[] = [];
    await renderAt("/runs", MEMBER, {
      "ExecutionService/ListExecutions": (request: Record<string, unknown>) => {
        asked.push(request);
        return { executions: [RUN] };
      },
      "ExecutionService/ListPendingApprovals": {
        approvals: [{ executionId: RUN.executionId, executionName: "orders-api prod database", taskId: "database", team: "gcp-platform", requestedBy: "sam@acme.com", canDecide: true }],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Mine" }));
    await waitFor(() => { expect(asked.at(-1)).toMatchObject({ mine: true }); });

    fireEvent.click(screen.getByRole("button", { name: /to approve \(1\)/i }));
    expect(await screen.findByRole("link", { name: "orders-api prod database" })).toBeTruthy();
    expect(screen.getByText("sam@acme.com")).toBeTruthy();
  });
});

describe("a run", () => {
  const FAILED_RUN = {
    executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11",
    name: "billing-api staging",
    state: "EXECUTION_STATE_FAILED",
    teams: ["azure-apps"],
    createdAt: "2026-10-21T16:20:00Z",
    tasks: [
      { taskId: "project", state: "TASK_STATE_SUCCEEDED", attemptCount: 1, attempts: [{ number: 1, startedAt: "2026-10-21T16:20:01Z", completedAt: "2026-10-21T16:21:00Z" }] },
      {
        taskId: "deploy",
        state: "TASK_STATE_FAILED",
        attemptCount: 1,
        dependsOn: ["project"],
        failure: { code: "REGION_QUOTA_EXCEEDED", message: "the region is out of quota", retryable: true },
        help: { means: "The project has used all its CPU in us-central1.", whatToDo: "Run again in europe-west1.", retry: "safe", team: "gcp-platform" },
        attempts: [{ number: 1, startedAt: "2026-10-21T16:21:01Z", completedAt: "2026-10-21T16:26:00Z", failure: { code: "REGION_QUOTA_EXCEEDED", message: "the region is out of quota", retryable: true } }],
      },
    ],
  };

  it("explains why it failed, and retries the failed step", async () => {
    const retried: Record<string, unknown>[] = [];
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }],
      "ExecutionService/RetryTask": (request: Record<string, unknown>) => {
        retried.push(request);
        return {};
      },
    });
    expect(await screen.findByText(/failed at step 2 of 2, deploy: the region is out of quota/i)).toBeTruthy();
    expect(screen.getAllByText("REGION_QUOTA_EXCEEDED").length).toBeGreaterThan(0);
    expect(screen.getByText(/run again in europe-west1/i)).toBeTruthy();
    // The failed step is the one shown below the timeline.
    expect(screen.getByRole("button", { name: /deploy/i, pressed: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry deploy" }));
    await waitFor(() => { expect(retried).toEqual([{ executionId: FAILED_RUN.executionId, taskId: "deploy" }]); });
  });

  it("shows what it made, and deletes it all as a cleanup run", async () => {
    const made = (id: string, name: string) => ({
      id,
      type: "gcp/project",
      externalId: `${name}-7f3`,
      name,
      link: "https://console.cloud.google.com/home?project=x",
      product: "gcp-platform-project-create",
      productTeam: "gcp-platform",
      ownerTeam: "azure-apps",
      executionId: FAILED_RUN.executionId,
      taskId: "project",
      firstReportedAt: "2026-10-21T16:21:00Z",
      state: "exists",
      canDelete: true,
    });
    const asked: Record<string, unknown>[] = [];
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }],
      "ResourceService/ListResources": { resources: [made("a1b2c3d4-0000-4000-8000-000000000001", "billing-api"), made("a1b2c3d4-0000-4000-8000-000000000002", "billing-db")] },
      "ResourceService/DeleteRunResources": (request: Record<string, unknown>) => {
        asked.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    expect(await screen.findByRole("heading", { name: "What it made" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /billing-db/ }).getAttribute("href")).toBe("https://console.cloud.google.com/home?project=x");
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all", hidden: false }));
    await waitFor(() => { expect(asked).toEqual([{ executionId: FAILED_RUN.executionId }]); });
  });

  it("says what a step waiting its turn is waiting for", async () => {
    const waiting = {
      ...FAILED_RUN,
      state: "EXECUTION_STATE_RUNNING",
      tasks: [{ taskId: "project", state: "TASK_STATE_READY", attemptCount: 0, attempts: [], waitingFor: { projectId: "orders-api" } }],
    };
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, { "ExecutionService/WatchExecution": [{ execution: waiting }] });
    expect(await screen.findByText(/another run is changing the same projectId \(orders-api\)/i)).toBeTruthy();
  });

  it("shows another step when it's picked on the timeline", async () => {
    await renderAt(`/runs/${FAILED_RUN.executionId}`, MEMBER, { "ExecutionService/WatchExecution": [{ execution: FAILED_RUN }] });
    fireEvent.click(await screen.findByRole("button", { name: /^project/i }));
    expect(screen.getByRole("heading", { name: "project" })).toBeTruthy();
    expect(screen.getByText(/attempt 1 · succeeded after 59s/i)).toBeTruthy();
  });
});

describe("the catalog", () => {
  const CATALOG = {
    runnables: [
      {
        kind: "KIND_TEMPLATE",
        team: "gcp-platform",
        name: "app-on-cloud-run",
        displayName: "App on Cloud Run",
        description: "A project, an image and a Cloud Run service.",
        parameters: { type: "object", properties: { projectId: { type: "string" }, region: { type: "string" } } },
        actions: ["gcp-platform/project.create", "gcp-platform/app-hosting.create"],
        shared: true,
        sourceUrl: "https://github.com/acme/vertra-catalog/blob/main/teams/gcp-platform/templates/app.yaml",
      },
      {
        kind: "KIND_ACTION",
        team: "aws-platform",
        name: "rds",
        displayName: "RDS for PostgreSQL",
        actions: ["aws-platform/rds.create"],
        shared: false,
        shareWith: ["data-team"],
        askForAccessUrl: "https://github.com/acme/vertra-catalog/issues/new?title=rds",
      },
    ],
  };

  it("shows what you can run and what you can ask for, by team", async () => {
    await renderAt("/catalog", MEMBER, { "TemplateService/ListTemplates": CATALOG });
    expect(await screen.findByRole("heading", { name: "App on Cloud Run" })).toBeTruthy();
    expect(screen.getByText("projectId, region")).toBeTruthy();
    expect(screen.getByText("gcp-platform · template · 2 steps")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Run" }).getAttribute("href")).toBe("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run");
    expect(screen.getByRole("link", { name: /ask for access/i }).getAttribute("href")).toContain("issues/new");
    expect(screen.getByRole("link", { name: /catalog repository/i }).getAttribute("href")).toBe("https://github.com/acme/vertra-catalog");

    fireEvent.click(screen.getByRole("button", { name: "aws-platform" }));
    expect(screen.queryByRole("heading", { name: "App on Cloud Run" })).toBeNull();
    expect(screen.getByRole("heading", { name: "RDS for PostgreSQL" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "All teams" }));
    fireEvent.click(screen.getByRole("switch", { name: /only what i can run/i }));
    expect(screen.queryByRole("heading", { name: "RDS for PostgreSQL" })).toBeNull();
    expect(screen.getByRole("heading", { name: "App on Cloud Run" })).toBeTruthy();
  });
});

describe("an API", () => {
  const ORDERS = { team: "payments", name: "orders", displayName: "Orders API", state: "API_STATE_LIVE", mayCall: true, endpoints: [{ method: "GET", path: "/orders/{id}", summary: "One order" }], perMinute: 600 };

  it("tells a caller how to call it, without its team's tabs", async () => {
    await renderAt("/apis/payments/orders", MEMBER, { "ApiService/GetApi": { api: ORDERS, openapi: "{}" } });
    expect(await screen.findByRole("heading", { name: "Orders API" })).toBeTruthy();
    expect(screen.getByText(/curl -X GET/)).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Traffic" })).toBeNull();
  });

  it("gives its own team its traffic, and lets a maintainer pause it", async () => {
    const paused: Record<string, unknown>[] = [];
    await renderAt("/apis/payments/orders?tab=definition", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "ApiService/GetApi": { api: { ...ORDERS, backendUrl: "https://orders.internal", sourcePath: "teams/payments/apis/orders/api.yaml" }, openapi: "{}" },
      "ApiService/PauseApi": (request: Record<string, unknown>) => {
        paused.push(request);
        return {};
      },
    });
    expect(await screen.findByText("teams/payments/apis/orders/api.yaml")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Traffic" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/message to callers/i), { target: { value: "Failing over" } });
    fireEvent.click(screen.getByRole("button", { name: "Pause this API" }));
    await waitFor(() => { expect(paused).toEqual([{ team: "payments", name: "orders", message: "Failing over" }]); });

    fireEvent.click(screen.getByRole("tab", { name: "Traffic" }));
    await waitFor(() => { expect(calls).toContain("ApiService/GetApiTraffic"); });
  });
});

describe("admin", () => {
  const PEOPLE = {
    users: [
      { email: "ana@acme.com", isAdmin: true, teamNames: ["azure-apps"], hasPassword: true, usesSso: true, lastSignedInAt: "2026-10-22T13:58:00Z" },
      { email: "lee@acme.com", teamNames: ["payments"], hasPassword: true, mustChangePassword: true },
      { email: "kim@acme.com", teamNames: [], usesSso: true },
    ],
  };

  it("lists people with how they sign in, and resets a password from a person's menu", async () => {
    const reset: Record<string, unknown>[] = [];
    await renderAt("/admin?tab=people", ADMIN, {
      "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" },
      "UserService/ListUsers": PEOPLE,
      "UserService/ResetPassword": (request: Record<string, unknown>) => {
        reset.push(request);
        return {};
      },
    });
    expect(await screen.findByText("Google and a password")).toBeTruthy();
    expect(screen.getByText(/hasn't chosen a password yet/i)).toBeTruthy();
    expect(screen.getByText("No team yet")).toBeTruthy();
    expect(screen.getAllByText("Never")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Actions for lee@acme.com" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /reset password/i }));
    fireEvent.change(await screen.findByLabelText(/temporary password/i), { target: { value: "a-temporary-one" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => { expect(reset).toEqual([{ email: "lee@acme.com", newPassword: "a-temporary-one" }]); });
  });

  it("opens a tab from the address", async () => {
    await renderAt("/admin?tab=gateway", ADMIN, { "ApiService/GetGateway": { enabled: true, url: "http://gateway:8080" } });
    expect(await screen.findByRole("button", { name: "Close the gateway" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Gateway", selected: true })).toBeTruthy();
  });
});

describe("observe", () => {
  it("filters what was refused by who refused it, with the gateway's counts", async () => {
    await renderAt("/observe", MEMBER, {
      "ObserveService/GetSecurity": {
        refusals: [
          { what: "local step t (registry/x)", code: "IMAGE_NOT_ALLOWED", why: "Not an allowed source.", source: "step", count: 1 },
          { what: "azure-apps → payments/orders: POST /orders", code: "INVALID_REQUEST", why: "Didn't fit.", source: "gateway", count: 214 },
        ],
      },
    });
    expect(await screen.findByText(/payments\/orders: POST \/orders, 214 calls/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cluster" }));
    expect(screen.queryByText(/214 calls/)).toBeNull();
    expect(screen.getByText("local step t (registry/x)")).toBeTruthy();
  });

  it("says whether the audit log's chain held", async () => {
    await renderAt("/observe?tab=audit", MEMBER, {
      "ObserveService/GetAuditCopy": { enabled: true, copiedThrough: "41206", checkedAt: "2026-10-22T08:00:00Z", copiedAt: "2026-10-22T14:05:00Z" },
    });
    expect(await screen.findByText("Chain intact")).toBeTruthy();
  });
});

describe("home", () => {
  it("shows your runs that are going, and what waits for you", async () => {
    await renderAt("/", MEMBER, {
      "ExecutionService/ListExecutions": {
        executions: [
          { executionId: "r1", name: "orders-api first deploy", createdAt: new Date(Date.now() - 300_000).toISOString(), state: "EXECUTION_STATE_RUNNING", steps: { SUCCEEDED: 2, RUNNING: 1, PENDING: 1 } },
          { executionId: "r2", name: "yesterday's", createdAt: new Date(Date.now() - 86_400_000).toISOString(), state: "EXECUTION_STATE_SUCCEEDED", steps: { SUCCEEDED: 1 } },
        ],
      },
      "ExecutionService/ListPendingApprovals": { approvals: [{ executionId: "r9", executionName: "orders-api prod database", taskId: "database", team: "azure-apps", requestedBy: "sam@acme.com", canDecide: true }] },
    });
    expect(await screen.findByRole("link", { name: "orders-api first deploy" })).toBeTruthy();
    expect(screen.getByText("2 of 4 steps done")).toBeTruthy();
    expect(screen.getByText(/1 of your runs is going\. 1 step waits for you to approve\./)).toBeTruthy();
    expect(screen.getByText(/sam@acme.com asked to run database in orders-api prod database/)).toBeTruthy();
  });
});

describe("preferences", () => {
  it("say a single sign-on account has no password to change", async () => {
    await renderAt("/account", { ...MEMBER, hasPassword: false, usesSso: true }, { "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" } });
    expect(await screen.findByText(/you sign in with google, as ana@acme.com/i)).toBeTruthy();
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
  });

  it("let someone with a password change it", async () => {
    await renderAt("/account", MEMBER);
    expect(await screen.findByLabelText(/current password/i)).toBeTruthy();
  });
});

describe("a run form", () => {
  const TEMPLATE = {
    kind: "KIND_TEMPLATE",
    team: "gcp-platform",
    name: "app-on-cloud-run",
    displayName: "App on Cloud Run",
    shared: true,
    actions: ["gcp-platform/project.create", "gcp-platform/app-hosting.create"],
    parameters: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string", title: "Project ID", minLength: 6, pattern: "^[a-z][a-z0-9-]*$", "x-vertra-pattern-message": "Lowercase letters, digits and hyphens.", "x-vertra-group": "Project" },
        regions: { type: "array", title: "Regions", items: { type: "string" } },
      },
    },
  };

  it("checks what's typed on its field, then runs it with typed values and opens the run", async () => {
    const ran: Record<string, unknown>[] = [];
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, {
      "TemplateService/ListTemplates": { runnables: [TEMPLATE] },
      "TemplateService/RunTemplate": (request: Record<string, unknown>) => {
        ran.push(request);
        return { executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11" };
      },
      "ExecutionService/WatchExecution": [
        { execution: { executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", name: "orders-api run", state: "EXECUTION_STATE_SUCCEEDED", createdAt: "2026-10-21T16:20:00Z", tasks: [] } },
      ],
    });
    expect(await screen.findByRole("heading", { name: "App on Cloud Run" })).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("app-hosting · create")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/project id/i), { target: { value: "Orders_API" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByText("Lowercase letters, digits and hyphens.")).toBeTruthy();
    expect(ran).toEqual([]);

    fireEvent.change(screen.getByLabelText(/project id/i), { target: { value: "orders-api" } });
    fireEvent.change(screen.getByLabelText("Regions, item 1"), { target: { value: "us-central1" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => { expect(ran).toEqual([{ team: "gcp-platform", name: "app-on-cloud-run", parameters: { projectId: "orders-api", regions: ["us-central1"] } }]); });
    expect(await screen.findByRole("heading", { level: 1, name: "orders-api run" })).toBeTruthy();
  });

  it("runs again with changes, filled in from the run, and shows itself as an API call", async () => {
    const run = {
      executionId: "5a1d9c0e-2f4b-4e7a-9c3d-1b2a3c4d5e6f",
      name: "orders-api on Cloud Run",
      state: "EXECUTION_STATE_SUCCEEDED",
      teams: ["gcp-platform"],
      createdAt: "2026-10-21T16:20:00Z",
      tasks: [{ taskId: "project", state: "TASK_STATE_SUCCEEDED", attemptCount: 1, attempts: [{ number: 1, startedAt: "2026-10-21T16:20:01Z", completedAt: "2026-10-21T16:21:00Z" }] }],
      dag: { name: "orders-api on Cloud Run", tasks: [{ id: "project", image: "registry.example/project@sha256:aa", action: "create", team: "gcp-platform" }] },
      template: "gcp-platform/app-on-cloud-run",
      templateParameters: { projectId: "orders-api", regions: ["us-central1"] },
    };
    await renderAt(`/runs/${run.executionId}`, MEMBER, {
      "ExecutionService/WatchExecution": [{ execution: run }],
      "TemplateService/ListTemplates": { runnables: [TEMPLATE] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Run with changes" }));
    expect(await screen.findByText(/filled in from orders-api on cloud run/i)).toBeTruthy();
    expect((screen.getByLabelText(/project id/i) as HTMLInputElement).value).toBe("orders-api");
    expect((screen.getByLabelText("Regions, item 1") as HTMLInputElement).value).toBe("us-central1");

    fireEvent.click(screen.getByRole("button", { name: "Show as an API call" }));
    const call = screen.getByText(/TemplateService\/RunTemplate/).textContent ?? "";
    expect(call).toContain('"projectId": "orders-api"');
    expect(call).toContain("Bearer $VERTRA_TOKEN");
  });

  it("previews what it would do, from each step's plan", async () => {
    const previewed: Record<string, unknown>[] = [];
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, {
      "TemplateService/ListTemplates": { runnables: [{ ...TEMPLATE, previewable: true }] },
      "TemplateService/PreviewTemplate": (request: Record<string, unknown>) => {
        previewed.push(request);
        return { executionId: "7a7a7a7a-0000-4000-8000-000000000007", notPreviewed: [{ step: "deploy", why: "It uses project's output, known only once that runs." }] };
      },
      "ExecutionService/GetExecution": {
        execution: {
          executionId: "7a7a7a7a-0000-4000-8000-000000000007",
          state: "EXECUTION_STATE_SUCCEEDED",
          tasks: [{ taskId: "project", state: "TASK_STATE_SUCCEEDED", outputs: { summary: "Creates one project.", changes: [{ action: "create", type: "gcp/project", id: "orders-api" }] } }],
        },
      },
    });
    fireEvent.change(await screen.findByLabelText(/project id/i), { target: { value: "orders-api" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => { expect(previewed).toEqual([{ team: "gcp-platform", name: "app-on-cloud-run", parameters: { projectId: "orders-api" } }]); });
    expect(await screen.findByText("Creates one project.")).toBeTruthy();
    expect(screen.getByText("gcp/project · orders-api")).toBeTruthy();
    expect(screen.getByText(/not previewed\. It uses project's output/)).toBeTruthy();
  });

  it("schedules it for a team the person maintains, as its bot", async () => {
    const made: Record<string, unknown>[] = [];
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TemplateService/ListTemplates": { runnables: [TEMPLATE] },
      "TokenService/ListBots": { bots: [{ id: "b0b0b0b0-0000-4000-8000-000000000001", email: "payments-nightly@bots.vertra.local" }] },
      "ScheduleService/CreateSchedule": (request: Record<string, unknown>) => {
        made.push(request);
        return { schedule: { id: "s1", team: "payments", name: request["name"] } };
      },
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
    });
    fireEvent.change(await screen.findByLabelText(/project id/i), { target: { value: "orders-api" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule…" }));
    expect(await screen.findByText("payments-nightly@bots.vertra.local")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Schedule it" }));
    await waitFor(() => {
      expect(made).toEqual([
        expect.objectContaining({ team: "payments", name: "app-on-cloud-run", kind: "template", runnableTeam: "gcp-platform", runnableName: "app-on-cloud-run", parameters: { projectId: "orders-api" }, cron: "0 2 * * *", botId: "b0b0b0b0-0000-4000-8000-000000000001" }),
      ]);
    });
  });

  it("fills itself from an example", async () => {
    await renderAt("/catalog/run?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, {
      "TemplateService/ListTemplates": { runnables: [{ ...TEMPLATE, examples: [{ name: "orders api", inputs: { projectId: "orders-api", regions: ["us-central1"] }, outputs: { url: "https://orders" } }] }] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    expect((screen.getByLabelText(/project id/i) as HTMLInputElement).value).toBe("orders-api");
    expect((screen.getByLabelText("Regions, item 1") as HTMLInputElement).value).toBe("us-central1");
  });

  it("opens from an old catalog link", async () => {
    await renderAt("/catalog?template=gcp-platform%2Fapp-on-cloud-run", MEMBER, { "TemplateService/ListTemplates": { runnables: [TEMPLATE] } });
    expect(await screen.findByLabelText(/project id/i)).toBeTruthy();
  });
});

describe("pages that can't be shown", () => {
  it("say an address leads nowhere, inside the console", async () => {
    await renderAt("/no/such/page", MEMBER);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: /main/i })).toBeTruthy();
  });

  it("keep Admin to admins", async () => {
    await renderAt("/admin", MEMBER);
    expect(await screen.findByRole("heading", { name: "Admins only" })).toBeTruthy();
  });
});

describe("a new install", () => {
  it("shows its admin what's left to set up, and what's on", async () => {
    await renderAt("/admin", ADMIN, {
      "AdminService/GetCatalogStatus": { status: { release: "" } },
      "ImageService/GetImagePolicy": { policy: { exists: true, source: "registry.example/", allowed: ["registry.example/"] } },
      "TeamService/ListTeams": { teams: [] },
      "UserService/ListUsers": { users: [{ email: "ana@acme.com", isAdmin: true }] },
      "AdminService/GetInstall": { version: "0.4.0", environmentLabel: "gke-prod", scanning: true, runRetentionDays: 90 },
    });
    expect(await screen.findByRole("heading", { name: "Getting this install ready" })).toBeTruthy();
    expect(screen.getByText("1 of 4 done")).toBeTruthy();
    expect(screen.getByText("Connect the catalog")).toBeTruthy();
    expect(await screen.findByText("0.4.0")).toBeTruthy();
    // Single sign-on: set on the People tab, or with vertra.
    expect(screen.getAllByText(/vertra sso google/, { selector: "span" }).length).toBe(1);
    expect(screen.getByText("Admin, People: Single sign-on")).toBeTruthy();
  });
});

describe("the admins' chat channel", () => {
  it("lets an admin choose the team whose webhook gets admins' alerts", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/admin", ADMIN, {
      "AdminService/GetCatalogStatus": { status: { release: "" } },
      "ImageService/GetImagePolicy": { policy: { exists: true, source: "registry.example/", allowed: ["registry.example/"] } },
      "TeamService/ListTeams": { teams: [{ id: "t1", name: "platform" }, { id: "t2", name: "old", retiredAt: "2026-10-01T00:00:00Z" }] },
      "UserService/ListUsers": { users: [{ email: "ana@acme.com", isAdmin: true }] },
      "NotificationService/GetAdminChannel": { team: "" },
      "NotificationService/SetAdminChannel": (request: Record<string, unknown>) => {
        saved.push(request);
        return { team: request["team"] };
      },
    });
    expect(await screen.findByRole("heading", { name: "Admins' alerts in chat" })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Team" }));
    expect(screen.queryByRole("option", { name: "old" })).toBeNull(); // retired
    fireEvent.click(await screen.findByRole("option", { name: "platform" }));
    const card = screen.getByRole("heading", { name: "Admins' alerts in chat" }).closest("div") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(saved).toEqual([{ team: "platform" }]); });
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

describe("a team's settings", () => {
  it("say a retired team is read-only, and offer an admin to restore it", async () => {
    await renderAt("/teams/old-team?tab=settings", ADMIN, {
      "TeamService/GetTeam": { team: { id: "t1", name: "old-team", retiredAt: "2026-10-21T12:00:00Z", fromCatalog: true } },
    });
    expect(await screen.findByText(/this team is retired: it's read-only/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Restore old-team" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /purge old-team/i })).toHaveProperty("disabled", false);
    expect(screen.getByText("teams/old-team/")).toBeTruthy();
  });

  it("name the members a Google-only rule would lock out, and keep the controls from non-admins", async () => {
    await renderAt("/teams/payments?tab=settings", { ...MEMBER, teamNames: ["payments"] }, {
      "AuthService/GetEnvironment": { label: "test", ssoLabel: "Google" },
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TeamService/ListMembers": {
        members: [
          { id: "u1", email: "ana@acme.com", hasPassword: true, usesSso: true, role: "TEAM_ROLE_MAINTAINER" },
          { id: "u2", email: "lee@acme.com", hasPassword: true, usesSso: false, role: "TEAM_ROLE_MEMBER" },
          { id: "u3", email: "ci@bots.vertra.local", isBot: true, role: "TEAM_ROLE_MEMBER" },
        ],
      },
    });
    expect(await screen.findByText(/1 member signs in with a password only: lee@acme.com/i)).toBeTruthy();
    expect(screen.getByRole("switch", { name: /require google sign-in/i })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /retire payments/i })).toBeNull();
  });

  it("let a maintainer set the team's chat webhook, which is never shown back", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=settings", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "NotificationService/GetTeamWebhook": { webhook: { configured: false }, allowedHosts: ["hooks.slack.com"] },
      "NotificationService/SetTeamWebhook": (request: Record<string, unknown>) => {
        saved.push(request);
        return { webhook: { configured: true, host: "hooks.slack.com", kinds: request["kinds"] } };
      },
    });
    fireEvent.change(await screen.findByLabelText(/webhook url/i), { target: { value: "https://hooks.slack.com/services/T/B/x" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /waits for the team's approval/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(saved).toEqual([{ team: "payments", url: "https://hooks.slack.com/services/T/B/x", kinds: ["run_failed", "product_not_ready", "step_refused"] }]); });
    expect(await screen.findByText("hooks.slack.com")).toBeTruthy();
    expect((screen.getByLabelText(/new webhook url/i) as HTMLInputElement).value).toBe("");
  });
});

describe("email", () => {
  it("lets you choose what's emailed, when the install sends email", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/account", MEMBER, {
      "NotificationService/GetEmailPreferences": { available: true, kinds: ["run_failed"] },
      "NotificationService/SetEmailPreferences": (request: Record<string, unknown>) => {
        saved.push(request);
        return request;
      },
    });
    fireEvent.click(await screen.findByRole("checkbox", { name: "A run of mine finished" }));
    await waitFor(() => { expect(saved).toEqual([{ kinds: ["run_failed", "run_succeeded"] }]); });
  });
});

describe("another team's page", () => {
  it("says where to ask it, and what it offers you", async () => {
    await renderAt("/teams/gcp-platform", MEMBER, {
      "TeamService/GetTeamProfile": { name: "gcp-platform", fromCatalog: true, contact: "#gcp-platform", helpUrl: "https://wiki.example/gcp", people: 4 },
      "TemplateService/ListTemplates": {
        runnables: [
          { kind: "KIND_TEMPLATE", team: "gcp-platform", name: "app-on-cloud-run", displayName: "App on Cloud Run", shared: true, readiness: { state: "ready" } },
          { kind: "KIND_ACTION", team: "gcp-platform", name: "gcp-platform-sql-create", displayName: "Cloud SQL", shared: false, askForAccessUrl: "https://github.com/acme/catalog/issues/new" },
          { kind: "KIND_ACTION", team: "web", name: "web-site-deploy", displayName: "Site", shared: true },
        ],
      },
    });
    expect(await screen.findByText(/4 people, from the catalog\. Contact: #gcp-platform\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: /its help page/i }).getAttribute("href")).toBe("https://wiki.example/gcp");
    expect(await screen.findByText("App on Cloud Run")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("link", { name: /ask for access/i }).getAttribute("href")).toBe("https://github.com/acme/catalog/issues/new");
    expect(screen.queryByText("Site")).toBeNull();
  });
});

describe("keyless bots", () => {
  it("let a maintainer have a bot sign in from a repository's CI jobs, with the job's snippet", async () => {
    const added: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=automation", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "TokenService/ListBots": { bots: [{ id: "b0b0b0b0-0000-4000-8000-000000000001", email: "payments-release@bots.vertra.local" }] },
      "TokenService/ListBotIdentities": { identities: [], issuers: ["https://token.actions.githubusercontent.com"], audience: "https://vertra.acme.dev" },
      "TokenService/AddBotIdentity": (request: Record<string, unknown>) => {
        added.push(request);
        return { identity: {} };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Sign in from CI…" }));
    fireEvent.change(screen.getByLabelText("Repository (owner/name)"), { target: { value: "acme/release" } });
    fireEvent.change(screen.getByLabelText(/only from this branch/i), { target: { value: "refs/heads/main" } });
    expect(screen.getByText(/audience=https:\/\/vertra\.acme\.dev/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => {
      expect(added).toEqual([
        { team: "payments", botId: "b0b0b0b0-0000-4000-8000-000000000001", issuer: "https://token.actions.githubusercontent.com", claims: { repository: "acme/release", ref: "refs/heads/main" } },
      ]);
    });
  });
});

describe("schedules", () => {
  it("are listed on the team's tab, and paused there", async () => {
    const changed: Record<string, unknown>[] = [];
    await renderAt("/teams/payments?tab=schedules", { ...MEMBER, teamNames: ["payments"], maintainerOf: ["payments"] }, {
      "TeamService/GetTeam": { team: { id: "t2", name: "payments" } },
      "ScheduleService/ListSchedules": {
        schedules: [{ id: "s1", team: "payments", name: "nightly", kind: "template", runnableTeam: "gcp-platform", runnableName: "app-on-cloud-run", cron: "0 2 * * *", timeZone: "Europe/Berlin", botEmail: "payments-nightly@bots.vertra.local", enabled: true, nextRunAt: "2026-10-26T01:00:00Z", lastError: "Template gcp-platform/app-on-cloud-run isn't shared with you." }],
      },
      "ScheduleService/UpdateSchedule": (request: Record<string, unknown>) => {
        changed.push(request);
        return { schedule: {} };
      },
    });
    expect(await screen.findByText("Every day at 02:00")).toBeTruthy();
    expect(screen.getByText(/isn't shared with you/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "nightly on" }));
    await waitFor(() => { expect(changed).toEqual([{ id: "s1", enabled: false }]); });
  });
});

describe("a product's readiness", () => {
  it("says what it lacks here, and lets its team check it again", async () => {
    const checked: Record<string, unknown>[] = [];
    await renderAt("/products", { ...MEMBER, teamNames: ["gcp-platform"] }, {
      "ProductService/ListProducts": {
        products: [
          {
            id: "p1",
            name: "gcp-platform-project-create",
            image: "registry.example/gcp-platform/project@sha256:aa",
            action: "create",
            teamName: "gcp-platform",
            releases: [{ image: "registry.example/gcp-platform/project@sha256:aa" }],
            readiness: { state: "not_ready", principal: "project-sa@acme.iam", missing: ["roles/resourcemanager.projectCreator on folder 12"] },
          },
        ],
      },
      "ProductService/CheckProduct": (request: Record<string, unknown>) => {
        checked.push(request);
        return { started: true };
      },
    });
    // Its team's section, then the product.
    fireEvent.click(await screen.findByText("gcp-platform"));
    fireEvent.click(await screen.findByText("Not ready"));
    expect(await screen.findByText("roles/resourcemanager.projectCreator on folder 12")).toBeTruthy();
    expect(screen.getByText("project-sa@acme.iam")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => { expect(checked).toEqual([{ name: "gcp-platform-project-create" }]); });
    expect(await screen.findByText(/checking now/i)).toBeTruthy();
  });
});

describe("notifications", () => {
  it("show how many are unread, and open what one is about", async () => {
    const read: Record<string, unknown>[] = [];
    await renderAt("/", MEMBER, {
      "NotificationService/ListNotifications": {
        notifications: [
          { id: "n1", kind: "run_failed", title: "billing-api staging failed", body: "Step deploy failed: QUOTA.", link: "/runs/0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11", createdAt: "2026-10-21T16:26:00Z", read: false },
          { id: "n2", kind: "run_succeeded", title: "orders finished", link: "/runs/x", createdAt: "2026-10-21T16:00:00Z", read: true },
        ],
        unreadCount: 1,
      },
      "NotificationService/MarkNotificationsRead": (request: Record<string, unknown>) => {
        read.push(request);
        return {};
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    fireEvent.click(await screen.findByText("billing-api staging failed"));
    await waitFor(() => { expect(read).toEqual([{ ids: ["n1"] }]); });
    // On the run's page now.
    expect(await screen.findByLabelText("Loading the run")).toBeTruthy();
  });
});

