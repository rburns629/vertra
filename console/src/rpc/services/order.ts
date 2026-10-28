// SPDX-License-Identifier: MIT
/** OrderService (proto/vertra/console/v1/order.proto): core/orders.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { MAX_CART, previewOrder, type OrderChoice, type OrderInput } from "../../core/orders.js";
import type { OrderService } from "../../gen/vertra/console/v1/order_pb.js";
import { callerOf } from "../context.js";
import { check } from "../validate.js";

const Name = Type.String({ minLength: 1, maxLength: 253 });

function input(i: OrderInput) {
  switch (i.kind) {
    case "step":
      return { kind: i.kind, step: i.step, output: i.output };
    case "parameter":
      return { kind: i.kind, parameter: i.parameter };
    case "resource":
      return { kind: i.kind, resourceId: i.resourceId, value: i.value };
    default:
      return { kind: i.kind };
  }
}

const choice = (c: OrderChoice) => ({
  step: c.step,
  input: c.input,
  fromStep: c.fromStep ?? "",
  fromOutput: c.fromOutput ?? "",
  resourceId: c.resourceId ?? "",
  addNew: c.addNew ?? false,
  label: c.label ?? "",
});

export function orderService(): ServiceImpl<typeof OrderService> {
  return {
    async previewOrder(req, ctx) {
      const { team, actions } = check(
        { team: Name, actions: Type.Array(Name, { maxItems: MAX_CART }) },
        { team: req.team, actions: req.actions },
      );
      const choices = req.choices.map(
        (c): OrderChoice => ({
          step: c.step,
          input: c.input,
          ...(c.fromStep ? { fromStep: c.fromStep, fromOutput: c.fromOutput } : {}),
          ...(c.resourceId ? { resourceId: c.resourceId } : {}),
          ...(c.addNew ? { addNew: true } : {}),
        }),
      );
      const { steps, problems, suggestions } = await previewOrder(callerOf(ctx), { team, actions, choices });
      return {
        steps: steps.map((s) => ({ ...s, inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, input(v)])) })),
        problems: problems.map((p) => ({ ...p, options: p.options.map(choice) })),
        suggestions: suggestions.map((s) => ({ ...s, provider: s.provider ?? "", existing: s.existing.map(choice) })),
      };
    },
  };
}
