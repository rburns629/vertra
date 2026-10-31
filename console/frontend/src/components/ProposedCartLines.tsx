// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import { listRunnables, type ProposedCart, type Runnable } from "../api";
import { useOrderPlan } from "../cart";

/** "team/product.action" → its parts. */
function parts(ref: string): { product: string; verb: string } {
  const dot = ref.lastIndexOf(".");
  return dot > 0 ? { product: ref.slice(0, dot), verb: ref.slice(dot + 1) } : { product: ref, verb: "" };
}

/**
 * A proposed cart's lines as the order would run them: each step's
 * <team>/<product> and verb, what it takes from an earlier step, and what
 * the plan adds. Until the plan is in (or if it can't be made), the cart's
 * actions as named.
 */
export function ProposedCartLines({ cart }: { cart: ProposedCart }) {
  const { plan } = useOrderPlan(cart.team, cart.actions, cart.choices);
  const [actions, setActions] = useState<Map<string, Runnable> | null>(null);
  useEffect(() => {
    listRunnables()
      .then((all) => { setActions(new Map(all.filter((r) => r.kind === "action").map((r) => [r.name, r]))); })
      .catch(() => { setActions(new Map()); });
  }, []);

  const steps = plan?.steps;
  return (
    <Box component="ol" sx={{ m: 0, pl: 2.5, fontSize: 13, display: "flex", flexDirection: "column", gap: 0.5 }}>
      {steps && actions
        ? steps.map((step, i) => {
            const ref = actions.get(step.product)?.actions[0];
            const { product, verb } = ref ? parts(ref) : { product: step.product, verb: "" };
            const wired = Object.entries(step.inputs).flatMap(([input, from]) => {
              const at = from.kind === "step" ? steps.findIndex((s) => s.id === from.step) : -1;
              return at >= 0 ? [`its ${input} from step ${String(at + 1)}`] : [];
            });
            return (
              <li key={`${step.id}-${String(i)}`}>
                <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
                  {product}
                </Box>
                {[verb, ...wired].filter(Boolean).length > 0 && ` · ${[verb, ...wired].filter(Boolean).join(", ")}`}
                {step.added && " (added: another step needs what it makes)"}
              </li>
            );
          })
        : cart.actions.map((a, i) => (
            <li key={`${a}-${String(i)}`}>
              <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: 12 }}>
                {a}
              </Box>
            </li>
          ))}
    </Box>
  );
}
