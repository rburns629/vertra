// SPDX-License-Identifier: MIT
/** ResourceService (proto/vertra/console/v1/resource.proto): core/resources.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { deleteResources, deleteRunResources, listResources } from "../../core/resources.js";
import type { ResourceService } from "../../gen/vertra/console/v1/resource_pb.js";
import { callerOf, logOf } from "../context.js";
import { timestamp, unsetIfEmpty } from "../convert.js";
import { check } from "../validate.js";
import { viaKernel } from "./execution.js";

const Uuid = Type.String({ format: "uuid" });

export function resourceService(): ServiceImpl<typeof ResourceService> {
  return {
    async listResources(req, ctx) {
      const { query, executionId } = check(
        { query: Type.String({ maxLength: 200 }), executionId: Type.Union([Type.Literal(""), Uuid]) },
        { query: req.query, executionId: req.executionId },
      );
      const found = await listResources(callerOf(ctx), {
        executionId: unsetIfEmpty(executionId),
        team: unsetIfEmpty(req.team),
        query,
        includeDeleted: req.includeDeleted,
      });
      return {
        resources: found.map((r) => ({
          id: r.id,
          type: r.type,
          externalId: r.externalId,
          name: r.name ?? "",
          link: r.link ?? "",
          product: r.product,
          productTeam: r.productTeam,
          ownerTeam: r.ownerTeam ?? "",
          ownerEmail: r.ownerEmail ?? "",
          executionId: r.executionId,
          taskId: r.taskId,
          firstReportedAt: timestamp(r.firstReportedAt),
          reportedAt: timestamp(r.reportedAt),
          state: r.state,
          deletingExecutionId: r.deletingExecutionId ?? "",
          deletedAt: timestamp(r.deletedAt),
          canDelete: r.canDelete,
        })),
      };
    },

    async deleteResources(req, ctx) {
      const { resourceIds } = check({ resourceIds: Type.Array(Uuid, { minItems: 1, maxItems: 50 }) }, { resourceIds: req.resourceIds });
      return viaKernel(ctx, () => deleteResources(callerOf(ctx), resourceIds, logOf(ctx)));
    },

    async deleteRunResources(req, ctx) {
      const { executionId } = check({ executionId: Uuid }, req);
      return viaKernel(ctx, () => deleteRunResources(callerOf(ctx), executionId, logOf(ctx)));
    },
  };
}
