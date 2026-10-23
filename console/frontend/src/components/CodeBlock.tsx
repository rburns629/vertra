// SPDX-License-Identifier: MIT
import { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

/** Commands and snippets people copy: dark block, wraps long lines, with a
 * copy button. Falls back to "select it yourself" where the clipboard API
 * isn't available (plain HTTP). */
export function CodeBlock({ code, copyLabel = "Copy" }: { code: string; copyLabel?: string }) {
  const [copied, setCopied] = useState<"yes" | "unavailable" | null>(null);
  return (
    <Stack spacing={1} sx={{ alignItems: "flex-start", minWidth: 0 }}>
      <Box
        component="pre"
        sx={{
          m: 0,
          p: 2,
          width: "100%",
          boxSizing: "border-box",
          bgcolor: "code.background",
          color: "code.text",
          borderRadius: 2,
          fontFamily: "fontFamilyMono",
          fontSize: 12.5,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {code}
      </Box>
      <Button
        size="small"
        variant="outlined"
        startIcon={copied === "yes" ? <CheckIcon /> : <ContentCopyIcon />}
        onClick={() => {
          if (!navigator.clipboard) {
            setCopied("unavailable");
            return;
          }
          navigator.clipboard.writeText(code).then(
            () => {
              setCopied("yes");
            },
            () => {
              setCopied("unavailable");
            },
          );
        }}
      >
        {copied === "yes" ? "Copied" : copyLabel}
      </Button>
      {copied === "unavailable" && (
        <Typography variant="caption" color="text.secondary">
          This browser won't copy from this page; select the text and copy it yourself.
        </Typography>
      )}
    </Stack>
  );
}
