// SPDX-License-Identifier: MIT
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";

/** How long a new token lasts, in days (0: until revoked). The API's default is 90. */
export const DEFAULT_TOKEN_DAYS = 90;

const CHOICES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: 730, label: "2 years" },
  { days: 0, label: "Until revoked" },
];

/** The lifetime picker for a new bot or automation token. */
export function TokenLifetime({ days, onChange }: { days: number; onChange: (days: number) => void }) {
  return (
    <TextField
      select
      label="Expires after"
      size="small"
      value={days}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
      helperText="Issue a new token before it expires; the bot keeps its other tokens."
      sx={{ maxWidth: 260 }}
    >
      {CHOICES.map((c) => (
        <MenuItem key={c.days} value={c.days}>
          {c.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** "expires Mar 3, 2027", "expired", or "never expires". */
export function expiryText(expiresAt: string | null): string {
  if (!expiresAt) return "never expires";
  const at = new Date(expiresAt);
  if (at.getTime() <= Date.now()) return "expired";
  return `expires ${at.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
}
