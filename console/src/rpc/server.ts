// SPDX-License-Identifier: MIT
/**
 * The console's Connect services (proto/acyclix/console/v1/), under /api
 * like every other route: /api/acyclix.console.v1.<Service>/<Method>,
 * answering the Connect protocol (JSON or binary, so plain curl works),
 * gRPC-Web, and gRPC where the server speaks HTTP/2.
 *
 * Before each call a hook resolves the bearer credential
 * (auth/plugin.ts's resolveCaller); interceptors.ts then refuses
 * protected methods without one, records changes, and keeps internal
 * errors' details from callers.
 */
import { createContextValues } from "@connectrpc/connect";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import type { FastifyInstance } from "fastify";
import { resolveCaller } from "../auth/plugin.js";
import { AdminService } from "../gen/acyclix/console/v1/admin_pb.js";
import { AuthService } from "../gen/acyclix/console/v1/auth_pb.js";
import { ExecutionService } from "../gen/acyclix/console/v1/execution_pb.js";
import { ImageService } from "../gen/acyclix/console/v1/image_pb.js";
import { ProductService } from "../gen/acyclix/console/v1/product_pb.js";
import { SecretService } from "../gen/acyclix/console/v1/secret_pb.js";
import { TeamService } from "../gen/acyclix/console/v1/team_pb.js";
import { GuideService } from "../gen/acyclix/console/v1/guide_pb.js";
import { TokenService } from "../gen/acyclix/console/v1/token_pb.js";
import { UserService } from "../gen/acyclix/console/v1/user_pb.js";
import { kAuthError, kAuthProblem, kCaller, kClientIp, kLog, kRequestId } from "./context.js";
import { audit, maskErrors, requireCaller } from "./interceptors.js";
import { adminService } from "./services/admin.js";
import { authService } from "./services/auth.js";
import { executionService } from "./services/execution.js";
import { imageService } from "./services/image.js";
import { productService } from "./services/product.js";
import { secretService } from "./services/secret.js";
import { teamService } from "./services/team.js";
import { guideService } from "./services/guide.js";
import { tokenService } from "./services/token.js";
import { userService } from "./services/user.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Why a Connect call has no caller, when it has none. */
    authProblem?: string;
    /** Resolving the credential failed (not merely refused it). */
    authError?: Error;
  }
}

export async function registerRpc(app: FastifyInstance, api: FastifyInstance): Promise<void> {
  await api.register(async (rpc) => {
    rpc.addHook("preHandler", async (request) => {
      if (!request.headers.authorization) {
        request.authProblem = "Missing or invalid token.";
        return;
      }
      // Caught here only to be rethrown inside Connect (interceptors.ts),
      // so the caller gets a Connect error, masked like any other.
      try {
        const resolved = await resolveCaller(request);
        if (resolved.authUser) request.authUser = resolved.authUser;
        else request.authProblem = resolved.problem;
      } catch (error) {
        request.authError = error instanceof Error ? error : new Error(String(error));
      }
    });
    await rpc.register(fastifyConnectPlugin, {
      routes: (router) => {
        router.service(AuthService, authService(app));
        router.service(GuideService, guideService());
        router.service(UserService, userService());
        router.service(TokenService, tokenService());
        router.service(AdminService, adminService());
        router.service(ImageService, imageService());
        router.service(SecretService, secretService());
        router.service(ProductService, productService());
        router.service(TeamService, teamService());
        router.service(ExecutionService, executionService());
      },
      // Outermost first.
      interceptors: [maskErrors, audit, requireCaller],
      // Defaults spelled out (false, 0, [], ""), for callers reading the JSON.
      jsonOptions: { alwaysEmitImplicit: true },
      contextValues: (request) =>
        createContextValues()
          .set(kCaller, request.authUser)
          .set(kAuthProblem, request.authProblem)
          .set(kAuthError, request.authError)
          .set(kClientIp, request.ip)
          .set(kRequestId, request.id)
          .set(kLog, request.log),
    });
  });
}
