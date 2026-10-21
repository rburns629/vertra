// SPDX-License-Identifier: MIT
/** TemplateService (proto/vertra/console/v1/template.proto): core/templates.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import type { JsonObject } from "@bufbuild/protobuf";
import { Type } from "@sinclair/typebox";
import { runAction, runnables, runTemplate } from "../../core/templates.js";
import { Runnable_Kind, type TemplateService } from "../../gen/vertra/console/v1/template_pb.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";
import { executionState, viaKernel } from "./execution.js";

const Name = Type.String({ minLength: 1, maxLength: 253 });
const OptionalText = Type.Optional(Type.String({ minLength: 1, maxLength: 253 }));

export function templateService(): ServiceImpl<typeof TemplateService> {
  return {
    async listTemplates(_req, ctx) {
      return {
        runnables: (await runnables(callerOf(ctx))).map((r) => ({
          kind: r.kind === "template" ? Runnable_Kind.TEMPLATE : Runnable_Kind.ACTION,
          team: r.team,
          name: r.name,
          displayName: r.displayName,
          description: r.description,
          parameters: (r.parameters ?? {}) as JsonObject,
          actions: r.actions,
          deprecated: r.deprecated ?? "",
          onBehalfOf: r.onBehalfOf,
          onBehalfOfRequired: r.onBehalfOfRequired,
        })),
      };
    },

    async runTemplate(req, ctx) {
      const { team, name, onBehalfOf, requestId } = check(
        { team: Name, name: Name, onBehalfOf: OptionalText, requestId: OptionalText },
        { team: req.team, name: req.name, onBehalfOf: req.onBehalfOf, requestId: req.requestId },
      );
      const result = await viaKernel(ctx, () =>
        runTemplate(callerOf(ctx), team, name, { parameters: req.parameters ?? {}, onBehalfOf, requestId }, logOf(ctx)),
      );
      return { executionId: result.executionId, state: executionState(result.state) };
    },

    async runAction(req, ctx) {
      const { product, onBehalfOf, requestId } = check(
        { product: Name, onBehalfOf: OptionalText, requestId: OptionalText },
        { product: req.product, onBehalfOf: req.onBehalfOf, requestId: req.requestId },
      );
      const result = await viaKernel(ctx, () =>
        runAction(callerOf(ctx), product, { parameters: req.inputs ?? {}, onBehalfOf, requestId }, logOf(ctx)),
      );
      return { executionId: result.executionId, state: executionState(result.state) };
    },
  };
}
