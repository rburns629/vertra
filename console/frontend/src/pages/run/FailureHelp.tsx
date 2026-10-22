// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { FailureHelp as Help } from "../../api";

const RETRY: Record<string, string> = {
  safe: "Yes: its product finds what an earlier attempt made instead of making it twice.",
  unsafe: "With care: its product doesn't say it's safe to run twice. Check what the failed attempt made first.",
};

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 600, color: "text.secondary" }}>{label}</Typography>
      <Typography component="div" sx={{ fontSize: 14, lineHeight: 1.5 }}>
        {children}
      </Typography>
    </Box>
  );
}

/** What a failure means, what to do, whether retrying is safe, and whom to ask. */
export function FailureHelp({ help }: { help: Help }) {
  const ask = [help.chat, help.contact].filter(Boolean).join(" · ");
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {help.means && <Item label="What it means">{help.means}</Item>}
      {help.whatToDo && <Item label="What to do">{help.whatToDo}</Item>}
      {RETRY[help.retry] && (
        <Item label="Safe to retry?">
          <Box component="span" sx={{ color: help.retry === "safe" ? "success.dark" : "warning.dark" }}>
            {RETRY[help.retry]}
          </Box>
        </Item>
      )}
      {(ask || help.url) && (
        <Item label={`Ask ${help.team}`}>
          {ask}
          {help.url && (
            <>
              {ask ? " · " : ""}
              <Link href={help.url} target="_blank" rel="noopener noreferrer">
                Runbooks
              </Link>
            </>
          )}
        </Item>
      )}
      <Typography variant="caption" color="text.secondary">
        {help.fromOwner ? `Explanation written by ${help.team} for this error code.` : "Explanation from Vertra."}
      </Typography>
    </Box>
  );
}
