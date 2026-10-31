// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { listResources, type ExecutionDetail, type MadeResource } from "../../api";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";
import { when } from "../../time";

/** What an order's run kept of its cart (core/orders.ts's placeOrder). */
interface Cart {
  actions: string[];
  choices: { step: string; input: string; fromStep?: string; fromOutput?: string; resourceId?: string; addNew?: boolean; label?: string }[];
  values: Record<string, Record<string, unknown>>;
  /** Each planned step; orders placed before it was kept have none. */
  steps?: { id: string; product: string; added: boolean }[];
}

function cartOf(parameters: Record<string, unknown> | null): Cart | null {
  if (!parameters || !Array.isArray(parameters["actions"])) return null;
  return {
    actions: parameters["actions"] as string[],
    choices: Array.isArray(parameters["choices"]) ? (parameters["choices"] as Cart["choices"]) : [],
    values: (parameters["values"] as Cart["values"] | undefined) ?? {},
    steps: Array.isArray(parameters["steps"]) ? (parameters["steps"] as Cart["steps"]) : undefined,
  };
}

/** A step's own inputs, as "name value" pairs: the first two. */
const filledIn = (values: Record<string, unknown> | undefined) =>
  Object.entries(values ?? {})
    .slice(0, 2)
    .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");

/**
 * An order's run: what its cart held as it was placed (each action, its own
 * inputs, and what the plan added), and the choices made where two could
 * fill an input, with the resource each chose.
 */
export function OrderCart({ execution }: { execution: ExecutionDetail }) {
  const cart = execution.template === "order" ? cartOf(execution.templateParameters) : null;
  const chosenIds = (cart?.choices ?? []).flatMap((c) => (c.resourceId ? [c.resourceId] : []));
  const [chosen, setChosen] = useState<Map<string, MadeResource>>(new Map());
  const wanted = chosenIds.join(",");

  useEffect(() => {
    if (!wanted) return;
    listResources({ ids: wanted.split(","), includeDeleted: true })
      .then((found) => { setChosen(new Map(found.map((r) => [r.id, r]))); })
      .catch(() => { setChosen(new Map()); });
  }, [wanted]);

  if (!cart) return null;
  const tasks = new Map((execution.payload?.tasks ?? []).map((t) => [t.id, t]));
  const lines = cart.steps ?? cart.actions.map((product) => ({ id: "", product, added: false }));
  return (
    <Card component="section" aria-labelledby="cart-h" sx={{ px: 3, py: 2.25, display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Typography id="cart-h" variant="h6" component="h2">
          Ordered from the cart{execution.onBehalfOf && `, for ${execution.onBehalfOf}`}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          As it was when it was placed.
        </Typography>
      </Box>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 1.25, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {lines.map((line) => {
          const task = line.id ? tasks.get(line.id) : undefined;
          const inputs = line.id ? filledIn(cart.values[line.id]) : "";
          return (
            <Box
              component="li"
              key={line.id || line.product}
              sx={{ display: "flex", flexDirection: "column", gap: 0.25, px: 1.5, py: 1.25, borderRadius: 2, bgcolor: line.added ? "info.light" : "background.default", fontSize: 13 }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
                <Typography component="span" sx={{ fontWeight: 500, fontSize: 13 }}>
                  {task ? `${line.id} · ${task.action}` : line.product}
                </Typography>
                {line.added && <Pill tone="info">Added</Pill>}
              </Box>
              <Typography component="span" color="text.secondary" sx={{ fontSize: 13, overflowWrap: "anywhere" }}>
                {[task?.team, line.added ? "the plan added it: another step needs what it makes, and nothing in the cart made it" : inputs].filter(Boolean).join(" · ")}
              </Typography>
            </Box>
          );
        })}
      </Box>
      {cart.choices.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, borderTop: 1, borderColor: "divider", pt: 1.25 }}>
          <Typography variant="body2" color="text.secondary">
            What was chosen where two could fill an input
          </Typography>
          {cart.choices.map((c) => {
            const resource = c.resourceId ? chosen.get(c.resourceId) : undefined;
            return (
              <Box key={`${c.step}/${c.input}`} sx={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "baseline", fontSize: 13 }}>
                <Mono sx={{ fontSize: 12 }}>
                  {c.step} · {c.input}
                </Mono>
                <span aria-hidden="true">→</span>
                {resource ? (
                  <>
                    <Link component={RouterLink} to={`/runs/${resource.executionId}`}>
                      {resource.name ?? resource.externalId}
                    </Link>
                    <Typography component="span" color="text.secondary" sx={{ fontSize: 13 }}>
                      {resource.type}, made {when(resource.firstReportedAt)}
                      {resource.ownerTeam && ` for ${resource.ownerTeam}`}
                    </Typography>
                  </>
                ) : c.fromStep ? (
                  <span>
                    {c.fromStep}&apos;s {c.fromOutput}, in this order
                  </span>
                ) : c.addNew ? (
                  <span>a new one, made by this order</span>
                ) : (
                  <span>{c.label || "something you can no longer see"}</span>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Card>
  );
}
