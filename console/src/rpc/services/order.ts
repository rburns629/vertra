// SPDX-License-Identifier: MIT
/** OrderService (proto/vertra/console/v1/order.proto): core/orders.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { MAX_CART, previewOrder, type OrderInput } from "../../core/orders.js";
import type { OrderService } from "../../gen/vertra/console/v1/order_pb.js";
import { callerOf } from "../context.js";
import { check } from "../validate.js";

const Name = Type.String({ minLength: 1, maxLength: 253 });

const input = (i: OrderInput) =>
  i.kind === "step" ? { kind: i.kind, step: i.step, output: i.output } : i.kind === "parameter" ? { kind: i.kind, parameter: i.parameter } : { kind: i.kind };

export function orderService(): ServiceImpl<typeof OrderService> {
  return {
    async previewOrder(req, ctx) {
      const { team, actions } = check(
        { team: Name, actions: Type.Array(Name, { maxItems: MAX_CART }) },
        { team: req.team, actions: req.actions },
      );
      const choices = req.choices.map((c) => ({ step: c.step, input: c.input, fromStep: c.fromStep, fromOutput: c.fromOutput }));
      const { steps, problems } = await previewOrder(callerOf(ctx), { team, actions, choices });
      return {
        steps: steps.map((s) => ({ ...s, inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, input(v)])) })),
        problems,
      };
    },
  };
}
