// SPDX-License-Identifier: MIT
import path from "node:path";
import Fastify, { type FastifyError } from "fastify";
import { pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import authPlugin from "./auth/plugin.js";
import authRoutes from "./routes/auth.js";
import teamsRoutes from "./routes/teams.js";
import secretsRoutes from "./routes/secrets.js";
import meRoutes from "./routes/me.js";
import usersRoutes from "./routes/users.js";
import botsRoutes from "./routes/bots.js";
import automationRoutes from "./routes/automation.js";
import productsRoutes from "./routes/products.js";
import executionsRoutes from "./routes/executions.js";
import statsRoutes from "./routes/stats.js";
import podsRoutes from "./routes/pods.js";
import docsRoutes from "./routes/docs.js";
import { registerOpenApi } from "./openapi.js";
import imagePolicyRoutes from "./routes/imagePolicy.js";
import imageScansRoutes from "./routes/imageScans.js";
import auditRoutes from "./routes/audit.js";
import { registerActivity } from "./activity.js";
import { registerAudit } from "./audit.js";
import { reconcileScans } from "./scanning.js";
import { startPolicySync } from "./policySync.js";
import { startRetention } from "./retention.js";
import policySyncRoutes from "./routes/policySync.js";
import wiringTypesRoutes from "./routes/wiringTypes.js";
import { sql } from "drizzle-orm";
import { config } from "./config.js";
import { claimRegisteredImageRepositories, listAllSecretGrants } from "./db/queries.js";
import { deleteLegacySecretRole } from "./k8s.js";
import { db } from "./db/client.js";

// Built by ../frontend's own `npm run build`, copied to ../frontend/dist
// alongside this service's own compiled dist/ in the Docker image (see
// ../Dockerfile) -- one image, one process, one origin for both the API
// and the UI, so the browser never needs CORS to talk to either.
const FRONTEND_DIST = path.join(import.meta.dirname, "..", "frontend", "dist");

export async function buildApp() {
  const app = Fastify({
    logger: true,
    // By address only: none listed, and request.ip is the connection's.
    trustProxy: config.trustProxy.length > 0 ? config.trustProxy.join(",") : false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Fastify's default error handler puts any uncaught error's message (and
  // its .headers) in the response. @kubernetes/client-node's errors carry
  // the cluster's response body and headers, so those would reach the
  // caller. Schema-validation failures and errors a route gave a 4xx
  // statusCode are returned as they are; anything else is logged in full
  // and answered with a generic message. One place for this, not a
  // per-route try/catch.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      reply.code(error.statusCode ?? 400).send({ error: "BAD_REQUEST", message: error.message });
      return;
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      // FastifyError types `code` as always set, but a plain Error thrown
      // with a statusCode has none.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      reply.code(statusCode).send({ error: error.code ?? "ERROR", message: error.message });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: "INTERNAL_ERROR", message: "Internal server error." });
  });

  // Liveness never touches the database (a slow/down database shouldn't
  // get the process killed by an orchestrator's liveness probe); readiness
  // does, since a process that can't reach Postgres genuinely isn't ready
  // to serve traffic -- same split as kernel/app/api/routes/health.py.
  app.get("/health/live", () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      reply.code(503).send({ status: "unavailable" });
      return;
    }
    reply.send({ status: "ok" });
  });

  // authPlugin only decorates app.authenticate/request.authUser -- it
  // registers no routes of its own, so it stays outside the /api prefix
  // below (the decorators need to exist on the parent app either way).
  await app.register(authPlugin);
  registerAudit(app);
  registerActivity(app);

  // Browser security headers on every response. The session token lives in
  // localStorage, so the Content-Security-Policy is what keeps an injected
  // script from running at all: scripts only from this origin. Styles allow
  // inline because MUI (emotion) injects them at runtime. Spelled out rather
  // than helmet's defaults, which add upgrade-insecure-requests: that breaks
  // a console served over plain HTTP (kind, or before TLS is set up).
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  // Before any route: it documents each one as it's registered.
  await registerOpenApi(app);

  // Opt-in per route (global: false) via `config.rateLimit` -- see
  // routes/auth.ts and routes/me.ts. Registered before the routes because
  // it attaches itself through an onRoute hook. Rejections go through the
  // error handler above as an ordinary 429 {error, message}.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Too many attempts. Try again in ${context.after}.`), {
        statusCode: context.statusCode,
        code: "RATE_LIMITED",
      }),
  });

  // Every API route lives under /api, so none can share a URL with a page
  // of the app: Fastify can't tell a fetch() from a browser navigation, and
  // a route would win, answering a page reload with JSON (or a 401).
  await app.register(
    async (api) => {
      // Reachable pre-login, same as the health checks above -- see
      // config.ts's environmentLabel comment.
      api.get("/environment", () => ({
        label: config.environmentLabel,
        // So the login page only offers registration when it's open.
        selfRegistration: config.allowSelfRegistration,
      }));
      // Signed-in only, like the guides that render it.
      api.get("/openapi.json", { preHandler: app.authenticate }, () => app.swagger());
      // Signed-in only: deployment facts for the "Connect a source" wizard.
      api.get("/platform", { preHandler: app.authenticate }, () => ({
        secretSources: config.secretSources,
      }));
      await api.register(authRoutes);
      await api.register(teamsRoutes);
      await api.register(secretsRoutes);
      await api.register(meRoutes);
      await api.register(usersRoutes);
      await api.register(botsRoutes);
      await api.register(automationRoutes);
      await api.register(productsRoutes);
      await api.register(executionsRoutes);
      await api.register(statsRoutes);
      await api.register(podsRoutes);
      await api.register(docsRoutes);
      await api.register(imagePolicyRoutes);
      await api.register(imageScansRoutes);
      await api.register(auditRoutes);
      await api.register(policySyncRoutes);
      await api.register(wiringTypesRoutes);
    },
    { prefix: "/api" },
  );

  await app.register(fastifyStatic, { root: FRONTEND_DIST });
  // Anything GET that isn't under /api or a real static asset is a
  // client-side route (e.g. /teams/gcp) -- React Router owns those, so
  // the SPA shell is what belongs there, not a 404. A non-GET request to
  // an unmatched path is almost certainly a bad API call, not
  // navigation, so that stays a real JSON 404.
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET") {
      reply.sendFile("index.html", FRONTEND_DIST);
      return;
    }
    reply.code(404).send({ error: "NOT_FOUND", message: `No route: ${request.method} ${request.url}` });
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  // Products registered before image repositories had owners get theirs.
  await claimRegisteredImageRepositories();
  // The cluster's copies of the console's lists (the identity and scan
  // policies): now, since things may have changed while no console ran, and
  // every few minutes after, so a failed write or a hand edit doesn't last.
  // A failure is logged and shown to admins (GET /policy-sync), not fatal:
  // the console still enforces the rules itself.
  startPolicySync(app.log, config.policySyncIntervalSeconds * 1000);
  startRetention(app.log);
  // Image scans (scanning.ts): the cluster's list of failed digests now,
  // then finished scans read, and due rescans started, every 15 seconds.
  // A failure is logged and tried again on the next round.
  if (config.scanning.enabled) {
    setInterval(() => {
      reconcileScans().catch((error: unknown) => {
        app.log.error({ err: error }, "could not reconcile image scans");
      });
    }, 15_000).unref();
  }
  // Secrets used to be granted to one ServiceAccount each, through a Role
  // per secret; now they're the team's. Removes those Roles from installs
  // that have them (nothing to do once they're gone, a few 404s).
  try {
    for (const { teamName, secretName } of await listAllSecretGrants()) {
      await deleteLegacySecretRole(teamName, secretName);
    }
  } catch (error) {
    app.log.error({ err: error }, "could not remove the per-secret Roles secrets no longer use");
  }
  await app.listen({ host: "0.0.0.0", port: config.port });
}

// Only start listening when run as the entry point (`node dist/index.js`,
// `tsx src/index.ts`) -- not when a test imports buildApp().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
