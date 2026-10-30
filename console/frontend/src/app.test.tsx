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
    // A stream that fails says so in its end, as the console's does.
    if (streaming) return streamOf([], { error: { code, message, details } });
    return new Response(JSON.stringify({ code, message, details }), { status, headers: { "content-type": "application/json" } });
  }
  if (!streaming) return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  return streamOf(Array.isArray(value) ? value : [], {});
}

/** A server stream: its messages, then its end. */
function streamOf(messages: unknown[], end: unknown): Response {
  const frame = (flags: number, json: unknown) => {
    const body = new TextEncoder().encode(JSON.stringify(json));
    const envelope = new Uint8Array(5 + body.length);
    envelope[0] = flags;
    new DataView(envelope.buffer).setUint32(1, body.length);
    envelope.set(body, 5);
    return envelope;
  };
  const frames = [...messages.map((m) => frame(0, m)), frame(0b10, end)];
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

    fireEvent.click(screen.getByRole("tab", { name: /to approve/i }));
    expect(await screen.findByRole("link", { name: "orders-api prod database" })).toBeTruthy();
    expect(screen.getByText("sam@acme.com")).toBeTruthy();
  });

  it("counts the week's runs, filters by kind, and says who started each", async () => {
    const DAG = { ...RUN, executionId: "1b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a12", name: "kafka topics backfill", template: "", state: "EXECUTION_STATE_FAILED", submittedBy: "u9" };
    await renderAt("/runs", MEMBER, { "ExecutionService/ListExecutions": { executions: [{ ...RUN, submittedBy: MEMBER.userId }, DAG] } });
    expect(await screen.findByText("kafka topics backfill")).toBeTruthy();
    expect(screen.getByText("someone else")).toBeTruthy();
    expect(screen.getByText("you")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Failed this week 1/ })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Kind" }));
    fireEvent.click(await screen.findByRole("option", { name: "A DAG" }));
    await waitFor(() => { expect(screen.queryByText("orders-api first deploy")).toBeNull(); });
    expect(screen.getByText("kafka topics backfill")).toBeTruthy();
  });

  it("lists every one of your teams' schedules together", async () => {
    const asked: string[] = [];
    await renderAt("/runs?view=schedules", { ...MEMBER, teamNames: ["payments", "ml"] }, {
      "ScheduleService/ListSchedules": (request: Record<string, unknown>) => {
        const team = String(request["team"]);
        asked.push(team);
        return { schedules: [{ id: `s-${team}`, team, name: `${team} nightly`, kind: "action", runnableName: "uptime-check.check", cron: "0 2 * * *", timeZone: "UTC", botEmail: `${team}@bots.vertra.local`, enabled: team === "ml" }] };
      },
    });
    expect(await screen.findByText("payments nightly")).toBeTruthy();
    expect(screen.getByText("ml nightly")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /schedules 2/i, selected: true })).toBeTruthy();
    expect(asked.sort()).toEqual(["ml", "payments"]);
  });
});

describe("what runs made", () => {
  const made = (id: string, name: string, state = "exists") => ({
    id,
    type: "gcp/project",
    externalId: `${name}-7f3`,
    name,
    product: "gcp-platform-project",
    productTeam: "gcp-platform",
    ownerTeam: "azure-apps",
    executionId: "0b6f6a1e-6c64-4d39-9a0d-7d4c1f6c2a11",
    taskId: "project",
    firstReportedAt: "2026-10-21T16:21:00Z",
    state,
    canDelete: true,
  });

  it("counts by state, and deletes the ones picked in one cleanup run", async () => {
    const asked: Record<string, unknown>[] = [];
    await renderAt("/runs/made", MEMBER, {
      "ResourceService/ListResources": {
        resources: [
          made("a1b2c3d4-0000-4000-8000-000000000001", "payments-dev"),
          made("a1b2c3d4-0000-4000-8000-000000000002", "orders-api-dev"),
          made("a1b2c3d4-0000-4000-8000-000000000003", "scratch-bucket", "delete_failed"),
          made("a1b2c3d4-0000-4000-8000-000000000004", "old-bucket", "deleted"),
        ],
      },
      "ResourceService/DeleteResources": (request: Record<string, unknown>) => {
        asked.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    expect(await screen.findByRole("button", { name: /^Made 2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Deleted 1/ })).toBeTruthy();
    // Deleted ones show only when asked for.
    expect(screen.queryByText("old-bucket")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select payments-dev" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select orders-api-dev" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete 2…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(asked).toEqual([{ resourceIds: ["a1b2c3d4-0000-4000-8000-000000000001", "a1b2c3d4-0000-4000-8000-000000000002"] }]);
    });
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
    expect(await screen.findByRole("heading", { name: /step 2, deploy: the region is out of quota/i })).toBeTruthy();
    expect(screen.getByText(/failed at step 2 of 2/i)).toBeTruthy();
    expect(screen.getAllByText("REGION_QUOTA_EXCEEDED").length).toBeGreaterThan(0);
    expect(screen.getByText(/run again in europe-west1/i)).toBeTruthy();
    // The failed step is the one shown below the timeline.
    expect(screen.getByRole("button", { name: /deploy/i, pressed: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry deploy" }));
    await waitFor(() => { expect(retried).toEqual([{ executionId: FAILED_RUN.executionId, taskId: "deploy" }]); });
  });

  it("shows what uses what, and lets an admin approve a delete that others depended on", async () => {
    const project = { id: "a1b2c3d4-0000-4000-8000-0000000000a1", type: "gcp/project", externalId: "web-prod", executionId: FAILED_RUN.executionId, input: "" };
    const service = { id: "a1b2c3d4-0000-4000-8000-0000000000a2", type: "gcp/cloud-run-service", externalId: "shop-api", executionId: FAILED_RUN.executionId, input: "projectId" };
    const decided: Record<string, unknown>[] = [];
    await renderAt("/runs/made", ADMIN, {
      "ResourceService/ListResources": {
        resources: [
          { ...project, name: "", product: "gcp-project-create", productTeam: "gcp", ownerTeam: "azure-apps", taskId: "project", firstReportedAt: "2026-10-21T16:21:00Z", state: "exists", canDelete: true, dependents: [service] },
        ],
      },
      "ResourceService/ListDeleteRequests": {
        requests: [{ id: "d1d1d1d1-0000-4000-8000-000000000001", resources: [project], dependents: [service], requestedBy: "bo@acme.com", createdAt: "2026-10-27T10:00:00Z" }],
      },
      "ResourceService/DecideDeleteRequest": (request: Record<string, unknown>) => {
        decided.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    // In the table, and on the request.
    expect(await screen.findByText("Used by shop-api")).toBeTruthy();
    expect(screen.getAllByText("shop-api").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /^Waiting for an admin/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and delete" }));
    await waitFor(() => { expect(decided).toEqual([{ id: "d1d1d1d1-0000-4000-8000-000000000001", approve: true }]); });
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
    expect(await screen.findByRole("heading", { name: "What it made before failing" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /billing-db/ }).getAttribute("href")).toBe("https://console.cloud.google.com/home?project=x");
    fireEvent.click(screen.getByRole("button", { name: "Delete all 2…" }));
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

describe("the docs", () => {
  it("lists the platform's docs as the reference, and finds a section by search", async () => {
    await renderAt("/docs/01-getting-started", MEMBER, {
      "GuideService/ListGuides": {
        guides: [
          { id: "01-getting-started", title: "Getting started", section: "guides" },
          { id: "reference-operations", title: "Operations", section: "reference" },
        ],
      },
      "GuideService/GetGuide": { markdown: "# Getting started\n\nHello." },
      "GuideService/SearchGuides": { hits: [{ guide: "reference-operations", title: "Operations", heading: "Databases > Backups", excerpt: "Back up both databases nightly." }] },
    });
    expect(await screen.findByText("Reference")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search the docs"), { target: { value: "back up" } });
    const hit = await screen.findByRole("link", { name: /Operations · Databases > Backups/ });
    expect(hit.getAttribute("href")).toBe("/docs/reference-operations#backups");
  });

  const DOCS = {
    "GuideService/ListGuides": {
      guides: [
        { id: "01-getting-started", title: "Try Vertra end to end", section: "guides", kind: "guide" },
        { id: "03-what-is-a-dag", title: "What's a DAG", section: "guides", kind: "guide" },
        { id: "reference-setup", title: "Setting up Vertra", section: "reference", kind: "operating" },
        {
          id: "reference-operations",
          title: "Operations",
          section: "reference",
          kind: "operating",
          sections: [
            { title: "Upgrading", anchor: "upgrading" },
            { title: "Backups", anchor: "backups" },
          ],
        },
        { id: "09-something-new", title: "Something new", section: "guides", kind: "guide" },
      ],
    },
    "GuideService/GetGuide": {
      markdown: "# Operations\n\nRunning it.\n\n## Upgrading\n\nUp.\n\n### Reused tags\n\nTags.\n\n```\n## not a section\n```\n\n### Rolling back\n\nBack.\n\n## Backups\n\nNightly.",
    },
  };

  it("opens on a home with where to start and every category, a new doc under More", async () => {
    await renderAt("/docs", MEMBER, DOCS);
    const start = await screen.findByRole("region", { name: "Start here" });
    expect(within(start).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/docs/01-getting-started", "/docs/03-what-is-a-dag"]);
    expect(screen.getByRole("heading", { name: "Install and operate" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "More" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Something new" }).getAttribute("href")).toBe("/docs/09-something-new");
  });

  it("shows a long doc a section to a page, nested under it, with the pages before and after", async () => {
    await renderAt("/docs/reference-operations/upgrading", MEMBER, DOCS);
    const trail = await screen.findByRole("navigation", { name: "Where this is" });
    expect(await within(trail).findByText("Install and operate")).toBeTruthy();
    expect(within(trail).getByRole("link", { name: "Operations" }).getAttribute("href")).toBe("/docs/reference-operations");
    expect(within(trail).getByText("Run it")).toBeTruthy();
    // Only this section, its headings a level up.
    expect(await screen.findByRole("heading", { level: 1, name: "Upgrading" })).toBeTruthy();
    expect(screen.queryByText("Nightly.")).toBeNull();
    const contents = screen.getByRole("navigation", { name: "Docs contents" });
    for (const open of ["Install and operate", "Operations", "Run it"]) {
      expect(within(contents).getByRole("button", { name: open }).getAttribute("aria-expanded")).toBe("true");
    }
    expect(within(contents).getByRole("button", { name: "Get started" }).getAttribute("aria-expanded")).toBe("false");
    expect(within(contents).getByRole("link", { name: "Upgrading" }).getAttribute("aria-current")).toBe("page");
    const sections = screen.getByRole("navigation", { name: "On this page" });
    expect(within(sections).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["#reused-tags", "#rolling-back"]);
    const onward = screen.getByRole("navigation", { name: "Previous and next" });
    expect(within(onward).getByRole("link", { name: /Previous · Install and operate\s*Operations/ }).getAttribute("href")).toBe("/docs/reference-operations");
    expect(within(onward).getByRole("link", { name: /Next · Install and operate › Operations\s*Backups/ }).getAttribute("href")).toBe("/docs/reference-operations/backups");
  });

  it("draws a doc's figure, and opens it and a linked one at full size", async () => {
    const asked: string[] = [];
    await renderAt("/docs/reference-architecture", MEMBER, {
      "GuideService/ListGuides": { guides: [{ id: "reference-architecture", title: "Architecture", section: "reference", kind: "current" }] },
      "GuideService/GetGuide": { markdown: "# Architecture\n\n![The pieces: what runs where](architecture/6-the-pieces.svg)\n\nIn full: [the system diagram](architecture/1-system.svg)." },
      "GuideService/GetGuideImage": (body: Record<string, unknown>) => {
        asked.push(String(body["path"]));
        return { svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" };
      },
    });
    const figure = await screen.findByRole("img", { name: /The pieces: what runs where/ });
    await waitFor(() => { expect(figure.getAttribute("src")).toMatch(/^data:image\/svg\+xml/); });
    expect(figure.closest("p")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "the system diagram" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("img", { name: "The system diagram" })).toBeTruthy();
    expect(asked).toEqual(["architecture/6-the-pieces.svg", "architecture/1-system.svg"]);
  });

  it("opens a link to a heading in a long doc on the page that heading is on", async () => {
    await renderAt("/docs/reference-operations#reused-tags", MEMBER, DOCS);
    expect(await screen.findByRole("heading", { level: 1, name: "Upgrading" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Reused tags" })).toBeTruthy();
  });
});

describe("the chat panel", () => {
  it("isn't there without a model, and answers with its sources and a cart to open", async () => {
    const asked: Record<string, unknown>[] = [];
    const rated: Record<string, unknown>[] = [];
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "qwen3.8-27b" },
      "ChatService/AskStream": (request: Record<string, unknown>) => {
        asked.push(request);
        const answer = {
          text: "Back up both databases nightly [S1]. Here's a cart for a bucket.",
          citations: [
            { id: "S1", guide: "reference-operations", title: "Operations", heading: "Backups", kind: "operating", link: "/docs/reference-operations#backups" },
            { id: "S2", guide: "reference-assessment", title: "Assessment", heading: "17. Decisions", kind: "history", link: "/docs/reference-assessment#17-decisions" },
          ],
          cart: {
            team: "azure-apps",
            actions: ["azure-apps-bucket-create"],
            choices: [{ step: "bucket", input: "account", resourceId: "r-1", label: "shop (storage)" }],
            values: { bucket: { name: "shop-assets" } },
          },
          steps: [{ tool: "search_docs", ok: true }, { tool: "propose_cart", ok: true }],
        };
        // Its steps as it takes them, then the answer.
        return [{ step: { tool: "search_docs", ok: true } }, { step: { tool: "propose_cart", ok: true } }, { answer }];
      },
      "ChatService/RateAnswer": (request: Record<string, unknown>) => {
        rated.push(request);
        return {};
      },
      "TemplateService/ListTemplates": { runnables: [] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Vertra" }));
    fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: "How do I back up?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("link", { name: "[S1] Operations · Backups" })).getAttribute("href")).toBe("/docs/reference-operations#backups");
    expect(screen.getByText(/design history: why, not how it works now/)).toBeTruthy();
    expect(screen.getByText(/searched the docs, filled a cart/)).toBeTruthy();
    expect(asked).toMatchObject([{ team: "azure-apps", messages: [{ role: "user", content: "How do I back up?" }] }]);
    // A wrong answer goes to the admins with its question, and what was wrong.
    fireEvent.click(screen.getByRole("button", { name: "Wrong answer" }));
    fireEvent.change(await screen.findByLabelText("What was wrong?"), { target: { value: "Only the kernel's is nightly" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send" })[0]!);
    expect(await screen.findByText(/sent to your admins, to fix/)).toBeTruthy();
    expect(rated).toMatchObject([
      {
        rating: "down",
        team: "azure-apps",
        question: "How do I back up?",
        answer: "Back up both databases nightly [S1]. Here's a cart for a bucket.",
        steps: ["search_docs", "propose_cart"],
        model: "qwen3.8-27b",
        comment: "Only the kernel's is nightly",
      },
    ]);
    expect(rated[0]?.citations).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Open in cart" }));
    expect(await screen.findByRole("heading", { name: "Cart" })).toBeTruthy();
    // With what the answer filled in, for the cart page to start from.
    expect(JSON.parse(localStorage.getItem("vertra.cart") ?? "{}")).toMatchObject({
      team: "azure-apps",
      actions: ["azure-apps-bucket-create"],
      choices: [{ step: "bucket", input: "account", resourceId: "r-1" }],
      values: { bucket: { name: "shop-assets" } },
    });
    const { cart } = await import("./cart");
    cart.clear();
  });

  it("says when a conversation is filling the model's window, and starts a new one when it's too long", async () => {
    let asked = 0;
    await renderAt("/", MEMBER, {
      "ChatService/GetChatSettings": { enabled: true, model: "claude-haiku-5-5" },
      "ChatService/AskStream": () => {
        asked++;
        return asked === 1
          ? [{ answer: { text: "The docs don't cover that.", contextPercent: 80 } }]
          : refused(429, "resource_exhausted", "This conversation is too long for the chat model: start a new one.", "CONVERSATION_TOO_LONG");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ask Vertra" }));
    fireEvent.change(await screen.findByLabelText("Your question"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/80% of what the model can take/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/too long for the chat model/)).toBeTruthy();
    // The question waits in the box, to ask in a new conversation.
    expect((screen.getByLabelText("Your question") as HTMLTextAreaElement).value).toBe("second");
    fireEvent.click(screen.getAllByRole("button", { name: "New conversation" })[0]!);
    await waitFor(() => { expect(screen.queryByText("first")).toBeNull(); });
    expect(screen.queryByText(/too long for the chat model/)).toBeNull();
  });

  it("is there but off when no model is set, saying who sets one", async () => {
    await renderAt("/", MEMBER, { "ChatService/GetChatSettings": { enabled: false } });
    const ask = await screen.findByRole("button", { name: "Ask Vertra" });
    expect(ask.hasAttribute("disabled") || ask.getAttribute("aria-disabled") === "true").toBe(true);
    expect(screen.getByLabelText("Not set up yet: an admin chooses its model")).toBeTruthy();
  });
});

describe("the cart", () => {
  it("plans the cart for your team, offers what's there, and places it with what you fill in", async () => {
    const { cart } = await import("./cart");
    cart.add("gcp-app-hosting-create");
    const placed: Record<string, unknown>[] = [];
    const step = (projectId: Record<string, unknown>) => ({
      id: "app-hosting",
      product: "gcp-app-hosting-create",
      inputs: { serviceName: { kind: "unset" }, region: { kind: "parameter", parameter: "gcp.region" }, projectId },
    });
    const options = [
      { step: "app-hosting", input: "projectId", resourceId: "r1", label: "web-prod (gcp/project)" },
      { step: "app-hosting", input: "projectId", addNew: true, label: "A new one (gcp-project-create)" },
    ];
    await renderAt("/catalog/cart", MEMBER, {
      "TemplateService/ListTemplates": {
        runnables: [
          {
            kind: "KIND_ACTION",
            team: "gcp",
            name: "gcp-app-hosting-create",
            displayName: "App hosting",
            parameters: { type: "object", required: ["serviceName"], properties: { serviceName: { type: "string", title: "Service name" }, projectId: { type: "string" }, region: { type: "string" } } },
            actions: ["gcp/app-hosting.create"],
            shared: true,
          },
        ],
      },
      "OrderService/PreviewOrder": (request: Record<string, unknown>) =>
        Array.isArray(request["choices"]) && request["choices"].length > 0
          ? { steps: [step({ kind: "resource", resourceId: "r1", value: "web-prod" })] }
          : { steps: [step({ kind: "unset" })], problems: [{ code: "CHOOSE_EXISTING", step: "app-hosting", input: "projectId", message: "Use one you already have, or add a new one.", options }] },
      "OrderService/PlaceOrder": (request: Record<string, unknown>) => {
        placed.push(request);
        return { executionId: "9c9c9c9c-0000-4000-8000-000000000009" };
      },
    });
    expect(await screen.findByRole("heading", { name: "App hosting" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Place order" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "projectId" }));
    fireEvent.click(await screen.findByRole("option", { name: "web-prod (gcp/project)" }));
    expect(await screen.findByText("Uses web-prod (gcp/project)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Service name/), { target: { value: "shop-api" } });
    fireEvent.change(screen.getByLabelText(/gcp\.region/), { target: { value: "us-central1" } });
    fireEvent.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => {
      expect(placed).toMatchObject([
        {
          team: "azure-apps",
          actions: ["gcp-app-hosting-create"],
          choices: [{ step: "app-hosting", input: "projectId", resourceId: "r1" }],
          values: { "app-hosting": { serviceName: "shop-api" } },
          parameters: { "gcp.region": "us-central1" },
        },
      ]);
    });
    cart.clear();
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

  it("lists how people rated the chat's answers, the wrong ones first", async () => {
    await renderAt("/admin?tab=chat", ADMIN, {
      "ChatService/ListChatFeedback": {
        ratings: [
          { id: "1", rating: "up", question: "How do I add a secret?", answer: "Register it.", model: "claude-haiku-5-5", email: "lee@acme.com", createdAt: "2026-10-28T10:00:00Z" },
          {
            id: "2",
            rating: "down",
            team: "payments",
            question: "How do I back up?",
            answer: "Nightly.",
            comment: "Only the kernel's",
            citations: [{ id: "S1", guide: "reference-operations", title: "Operations", heading: "Backups", kind: "operating", link: "/docs/reference-operations#backups" }],
            steps: ["search_docs"],
            model: "claude-haiku-5-5",
            email: "kim@acme.com",
            createdAt: "2026-10-28T11:00:00Z",
          },
        ],
      },
    });
    expect(await screen.findByText("How do I back up?")).toBeTruthy();
    expect(screen.getByText(/Only the kernel's/)).toBeTruthy();
    expect(screen.queryByText("How do I add a secret?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All 2" }));
    expect(await screen.findByText("How do I add a secret?")).toBeTruthy();
  });

  it("opens a section from the address, and from an old tab's", async () => {
    await renderAt("/admin?tab=gateway", ADMIN, { "ApiService/GetGateway": { enabled: true, url: "http://gateway:8080" } });
    expect(await screen.findByRole("button", { name: "Close the gateway" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getByRole("link", { name: "API gateway" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: "Chat agent" }).getAttribute("href")).toBe("/admin/chat");
  });

  it("says where each section is set, and gives image sources and the audit copy sections of their own", async () => {
    await renderAt("/admin/images", ADMIN, { "ImageService/GetImagePolicy": { policy: { exists: true, source: "registry.example/", allowed: ["registry.example/"] } } });
    expect(await screen.findByRole("heading", { name: "Image sources" })).toBeTruthy();
    expect(screen.getByText("Install and here")).toBeTruthy();
    expect(screen.getByRole("link", { name: "About Image sources" }).getAttribute("href")).toBe("/docs/16-admin-settings#image-sources");
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    expect(within(nav).getByRole("link", { name: "Audit log copy" }).getAttribute("href")).toBe("/admin/audit");
    expect(within(nav).getByRole("link", { name: "Single sign-on and groups" }).getAttribute("href")).toBe("/admin/sign-in");
  });

  it("sets the chat agent's model in place of the install's, keeps its key unshown, and tries it first", async () => {
    const saved: Record<string, unknown>[] = [];
    const tried: Record<string, unknown>[] = [];
    await renderAt("/admin/chat", ADMIN, {
      "ChatService/GetChatConfig": {
        config: { source: "install", enabled: true, provider: "vertex", model: "google/gemini-3.5-flash", vertexProject: "acme-prod", vertexLocation: "global", installProvider: "vertex", installModel: "google/gemini-3.5-flash" },
      },
      "ChatService/TestChatConfig": (request: Record<string, unknown>) => {
        tried.push(request);
        return { ok: true, seconds: 3.2, model: "claude-haiku-5-5", answer: "Back up nightly [S1].", citations: 1 };
      },
      "ChatService/SetChatConfig": (request: Record<string, unknown>) => {
        saved.push(request);
        return { config: { source: "admins", enabled: true, provider: "anthropic", model: "claude-haiku-5-5", keySet: true, updatedBy: "ana@acme.com", installProvider: "vertex", installModel: "google/gemini-3.5-flash" } };
      },
      "ChatService/ListChatFeedback": { ratings: [] },
    });
    expect(await screen.findByText(/These are the install's settings \(Gemini on Vertex AI/)).toBeTruthy();
    expect((screen.getByLabelText("Google Cloud project") as HTMLInputElement).value).toBe("acme-prod");
    // No key on Vertex: it signs in as the console.
    expect(screen.queryByLabelText(/API key/)).toBeNull();

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Provider" }));
    fireEvent.click(await screen.findByRole("option", { name: "Claude through Anthropic's API" }));
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-haiku-5-5" } });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/claude-haiku-5-5 answered in 3.2 s, citing 1 section/)).toBeTruthy();
    expect(tried[0]?.["config"]).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-typed" });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/Saved: in effect within seconds/)).toBeTruthy();
    expect(saved[0]?.["config"]).toMatchObject({ enabled: true, provider: "anthropic", model: "claude-haiku-5-5", apiKey: "sk-ant-typed" });
    // Saved, the key is never shown again: kept, and the field empty.
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/One is kept \(encrypted, never shown\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the install's" })).toBeTruthy();
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
    // Single sign-on: set in Single sign-on and groups, or with vertra; each part leads to its section.
    expect(screen.getAllByText(/vertra sso google/, { selector: "span" }).length).toBe(1);
    expect(screen.getByText("Set up in Single sign-on and groups")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Signing in with single sign-on" }).getAttribute("href")).toBe("/admin/sign-in");
    expect(screen.getByRole("link", { name: "The chat agent" }).getAttribute("href")).toBe("/admin/chat");
  });
});

describe("the admins' chat channel", () => {
  it("lets an admin choose the team whose webhook gets admins' alerts", async () => {
    const saved: Record<string, unknown>[] = [];
    await renderAt("/admin/alerts", ADMIN, {
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

describe("Compose's cart", () => {
  it("asks which of several fills an input, in its card, and wires them again with the choice", async () => {
    const previews: Record<string, unknown>[] = [];
    const product = (name: string) => ({ id: name, name, image: `registry.example/apps/${name}@sha256:aa`, action: "create", teamName: "azure-apps", inputSchema: { type: "object" } });
    const step = (id: string, inputs: Record<string, unknown> = {}) => ({ id, product: id, inputs });
    const options = [
      { step: "deploy", input: "projectId", fromStep: "dev-project", fromOutput: "projectId", label: "dev-project's projectId" },
      { step: "deploy", input: "projectId", fromStep: "prod-project", fromOutput: "projectId", label: "prod-project's projectId" },
    ];
    await renderAt("/catalog/compose", MEMBER, {
      "ProductService/ListProducts": { products: ["deploy", "dev-project", "prod-project"].map(product) },
      "TemplateService/ListTemplates": {
        runnables: ["deploy", "dev-project", "prod-project"].map((name) => ({ kind: "KIND_ACTION", team: "azure-apps", name, actions: [`azure-apps/${name}.create`], shared: true })),
      },
      "OrderService/PreviewOrder": (request: Record<string, unknown>) => {
        previews.push(request);
        const chosen = Array.isArray(request["choices"]) && request["choices"].length > 0;
        const wired = { kind: "step", step: chosen ? "prod-project" : "dev-project", output: "projectId" };
        return chosen
          ? { steps: [step("dev-project"), step("prod-project"), step("deploy", { projectId: wired })] }
          : {
              steps: [step("dev-project"), step("prod-project"), step("deploy", { projectId: { kind: "unset" } })],
              problems: [{ code: "AMBIGUOUS", step: "deploy", input: "projectId", message: "Two steps provide a project: choose one.", options }],
            };
      },
    });
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("option", { name: /^deploy/ }));
    fireEvent.click(screen.getByRole("button", { name: "Wire them" }));
    fireEvent.mouseDown(await screen.findByRole("combobox", { name: "deploy's projectId" }));
    fireEvent.click(await screen.findByRole("option", { name: "prod-project's projectId" }));
    await waitFor(() => {
      expect(previews).toHaveLength(2);
    });
    expect(previews[1]).toMatchObject({ choices: [{ step: "deploy", input: "projectId", fromStep: "prod-project", fromOutput: "projectId" }] });
    // The choice stays shown, to change.
    expect(await screen.findByText("prod-project's projectId")).toBeTruthy();
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

