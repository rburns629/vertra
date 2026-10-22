// SPDX-License-Identifier: MIT
/** ApiService (proto/vertra/console/v1/api.proto): core/apis.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { getApi, listApis, pauseApi, type ApiView } from "../../core/apis.js";
import { ApiState, type ApiService } from "../../gen/vertra/console/v1/api_pb.js";
import { callerOf } from "../context.js";
import { check } from "../validate.js";

const Name = Type.String({ minLength: 1, maxLength: 63 });

const STATE = { live: ApiState.LIVE, held: ApiState.HELD, paused: ApiState.PAUSED } as const;

function product(a: ApiView) {
  return { ...a, state: STATE[a.state] };
}

export function apiService(): ServiceImpl<typeof ApiService> {
  return {
    async listApis(_req, ctx) {
      return { apis: (await listApis(callerOf(ctx))).map(product) };
    },

    async getApi(req, ctx) {
      const { team, name } = check({ team: Name, name: Name }, req);
      const { api, openapi } = await getApi(callerOf(ctx), team, name);
      return { api: product(api), openapi };
    },

    async pauseApi(req, ctx) {
      const { team, name, message } = check({ team: Name, name: Name, message: Type.String({ maxLength: 500 }) }, req);
      await pauseApi(callerOf(ctx), team, name, message);
      return {};
    },

    async resumeApi(req, ctx) {
      const { team, name } = check({ team: Name, name: Name }, req);
      await pauseApi(callerOf(ctx), team, name, null);
      return {};
    },
  };
}
