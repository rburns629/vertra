// SPDX-License-Identifier: MIT
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import type { OrderOption, OrderProblem } from "../api";

/** Whether two choices are for the same step's input. */
export const sameInput = (a: { step: string; input: string }, b: { step: string; input: string }) => a.step === b.step && a.input === b.input;

/** An option's identity, as a select's value. */
export const optionKey = (o: OrderOption) => (o.resourceId ? `r:${o.resourceId}` : o.addNew ? "new" : `s:${o.fromStep ?? ""}.${o.fromOutput ?? ""}`);

/** A choice an order needs made (OrderService/PreviewOrder): what fills this input. */
export function OrderChoice({ problem, chosen, onChoose }: { problem: OrderProblem; chosen: OrderOption | undefined; onChoose: (o: OrderOption) => void }) {
  return (
    <TextField
      select
      size="small"
      label={problem.input}
      helperText={problem.message}
      value={chosen ? optionKey(chosen) : ""}
      onChange={(e) => {
        const picked = problem.options.find((o) => optionKey(o) === e.target.value);
        if (picked) onChoose(picked);
      }}
      sx={{ minWidth: 280 }}
    >
      {problem.options.map((o) => (
        <MenuItem key={optionKey(o)} value={optionKey(o)}>
          {o.label}
        </MenuItem>
      ))}
    </TextField>
  );
}
