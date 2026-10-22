// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import { useEnvironment } from "../environment";

const draw = keyframes`to { stroke-dashoffset: 0; }`;
const rise = keyframes`from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; }`;

/** Two steps feeding a third, drawn in once: what Vertra runs. */
function Dag() {
  const edge = (delay: string) => ({
    strokeDasharray: 1,
    strokeDashoffset: 1,
    animation: `${draw} 1.4s cubic-bezier(.4,0,.2,1) ${delay} forwards`,
    "@media (prefers-reduced-motion: reduce)": { strokeDashoffset: 0, animation: "none" },
  });
  return (
    <Box component="svg" viewBox="0 0 240 200" sx={{ width: 200, height: "auto", color: "sidebar.accent" }} aria-hidden="true">
      <Box component="path" pathLength={1} d="M40 40 L120 160" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" sx={edge("0.2s")} />
      <Box component="path" pathLength={1} d="M200 40 L120 160" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" sx={edge("0.55s")} />
      {[
        [40, 40],
        [200, 40],
        [120, 160],
      ].map(([cx, cy]) => (
        <circle key={`${String(cx)},${String(cy)}`} cx={cx} cy={cy} r={16} fill="#232833" stroke="currentColor" strokeWidth={3} />
      ))}
    </Box>
  );
}

/**
 * The screens before the console proper (signing in, registering, choosing
 * your own password): what Vertra is on one side, the form on the other.
 * On a phone the panel shrinks to a strip above the form.
 */
export function SignInLayout({ children }: { children: ReactNode }) {
  const environment = useEnvironment();
  const appear = { animation: `${rise} .55s cubic-bezier(.2,.7,.2,1) both`, "@media (prefers-reduced-motion: reduce)": { animation: "none" } };
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", flexDirection: { xs: "column", md: "row" }, bgcolor: "background.default" }}>
      <Box
        component="section"
        aria-label="Vertra"
        sx={{
          flex: { md: "1 1 420px" },
          bgcolor: "sidebar.background",
          color: "sidebar.text",
          px: { xs: 2, md: 6 },
          py: { xs: 1.75, md: 6 },
          display: "flex",
          flexDirection: { xs: "row", md: "column" },
          alignItems: { xs: "center", md: "stretch" },
          justifyContent: "space-between",
          gap: { xs: 2, md: 4 },
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, color: "sidebar.textStrong", fontWeight: 600, fontSize: 18 }}>
          <Box component="svg" viewBox="0 0 24 24" sx={{ width: 22, height: 22, color: "sidebar.accent" }} aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="6" r="2.5" />
              <circle cx="19" cy="6" r="2.5" />
              <circle cx="12" cy="18" r="2.5" />
              <path d="M7 7.5l3.5 8.5M17 7.5l-3.5 8.5" />
            </g>
          </Box>
          Vertra
        </Box>
        <Box sx={{ display: { xs: "none", md: "flex" }, flexDirection: "column", gap: 3, maxWidth: 460, my: "auto" }}>
          <Dag />
          <Typography component="h1" sx={{ fontSize: 32, lineHeight: 1.2, fontWeight: 600, color: "sidebar.textStrong", ...appear }}>
            Run what your platform teams publish, safely.
          </Typography>
          <Typography sx={{ fontSize: 15, lineHeight: 1.6, color: "sidebar.textMuted", ...appear, animationDelay: "120ms" }}>
            Every step runs as its own team&apos;s reviewed product, with its own identity and secrets. You bring the inputs.
          </Typography>
        </Box>
        <Typography sx={{ fontSize: 12, color: "sidebar.textMuted", fontFamily: "fontFamilyMono", minHeight: "1em", overflowWrap: "anywhere" }}>
          {environment?.label}
        </Typography>
      </Box>
      <Box component="main" sx={{ flex: "1 1 420px", display: "flex", alignItems: "center", justifyContent: "center", px: 3, py: { xs: 4, md: 6 } }}>
        <Box
          sx={{
            width: "100%",
            maxWidth: 400,
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 2.5,
            p: 4,
            boxSizing: "border-box",
            ...appear,
            animationDelay: "80ms",
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}
