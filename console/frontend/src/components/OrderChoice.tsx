// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { OrderOption, OrderProblem } from "../api";

/** Whether two choices are for the same step's input. */
export const sameInput = (a: { step: string; input: string }, b: { step: string; input: string }) => a.step === b.step && a.input === b.input;

/** An option's identity, as a radio's value. */
export const optionKey = (o: OrderOption) => (o.resourceId ? `r:${o.resourceId}` : o.addNew ? "new" : `s:${o.fromStep ?? ""}.${o.fromOutput ?? ""}`);

/** What choosing it means, in a line. */
function meaning(o: OrderOption): string {
  if (o.addNew) return "Adds what makes one to the order, before this step.";
  if (o.resourceId) return "Something your team already has.";
  return `From ${o.fromStep ?? ""}'s ${o.fromOutput ?? ""}.`;
}

/**
 * A choice an order needs made (OrderService/PreviewOrder): what fills this
 * input, as a card per option to pick, three across (one on a phone).
 * `label` names the input in the legend; the problem's message says why
 * it's asked.
 */
export function OrderChoice({
  problem,
  chosen,
  onChoose,
  label,
}: {
  problem: OrderProblem;
  chosen: OrderOption | undefined;
  onChoose: (o: OrderOption) => void;
  label?: ReactNode;
}) {
  const name = `choice-${problem.step}-${problem.input}`;
  return (
    <Box component="fieldset" sx={{ border: 0, m: 0, p: 0, minWidth: 0, display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Box component="legend" sx={{ p: 0, mb: 0.5, fontSize: 13, fontWeight: 600 }}>
        {label ?? (
          <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontWeight: 500 }}>
            {problem.input}
          </Box>
        )}
      </Box>
      <Typography variant="body2" sx={{ fontSize: 13 }}>
        {problem.message}
      </Typography>
      <Box sx={{ display: "grid", gap: 1.25, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(3, minmax(0, 1fr))" } }}>
        {problem.options.map((o) => {
          const on = chosen !== undefined && optionKey(chosen) === optionKey(o);
          return (
            <Box
              key={optionKey(o)}
              component="label"
              sx={{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                gap: 0.5,
                minHeight: 44,
                p: "12px 14px 12px 40px",
                border: 1,
                borderColor: on ? "primary.main" : "tint.field",
                borderRadius: "10px",
                bgcolor: on ? "tint.infoSurface" : "background.paper",
                boxShadow: on ? (t) => `0 0 0 3px ${t.palette.info.light}` : "none",
                cursor: "pointer",
                fontSize: 13,
                lineHeight: 1.4,
                "&:focus-within": { outline: (t) => `2px solid ${t.palette.primary.main}`, outlineOffset: 2 },
              }}
            >
              <Box
                component="input"
                type="radio"
                name={name}
                value={optionKey(o)}
                checked={on}
                onChange={() => { onChoose(o); }}
                sx={{ position: "absolute", left: 14, top: 14, width: 18, height: 18, m: 0, accentColor: (t) => t.palette.primary.main }}
              />
              <Box component="span" sx={{ fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>
                {o.label}
              </Box>
              <Box component="span" sx={{ color: "text.secondary" }}>
                {meaning(o)}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
