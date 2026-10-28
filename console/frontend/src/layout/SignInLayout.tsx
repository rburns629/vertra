// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import { useEnvironment } from "../environment";

// Drawn in, held, faded, and again: a run that keeps running.
const draw = keyframes`
  0% { stroke-dashoffset: 1; opacity: 1; }
  35% { stroke-dashoffset: 0; opacity: 1; }
  85% { stroke-dashoffset: 0; opacity: 1; }
  100% { stroke-dashoffset: 0; opacity: 0; }
`;
// While its line is connected (35% to 85% of the line's cycle), a step
// grows and runs: its ring dims to a track, and a thick arc spins round it.
const grow = keyframes`
  0%, 30% { transform: scale(1); }
  38%, 82% { transform: scale(1.3); }
  90%, 100% { transform: scale(1); }
`;
const track = keyframes`
  0%, 30% { stroke-opacity: 1; }
  38%, 82% { stroke-opacity: 0.3; }
  90%, 100% { stroke-opacity: 1; }
`;
const running = keyframes`
  0%, 32% { opacity: 0; }
  38%, 82% { opacity: 1; }
  88%, 100% { opacity: 0; }
`;
const spin = keyframes`to { transform: rotate(360deg); }`;
const rise = keyframes`from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; }`;

const CYCLE = "4s";
const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };

/** A step: a ring that, while its line is connected, grows into a spinning status wheel. */
function Step({ cx, cy, delay }: { cx: number; cy: number; delay: string }) {
  const phase = (name: string, timing = "cubic-bezier(.4,0,.2,1)") => `${name} ${CYCLE} ${timing} ${delay} infinite`;
  return (
    <Box component="g" sx={{ transformBox: "fill-box", transformOrigin: "center", animation: phase(grow), ...still }}>
      <Box component="circle" cx={cx} cy={cy} r={16} fill="#232833" stroke="currentColor" strokeWidth={3} sx={{ animation: phase(track), ...still }} />
      <Box component="g" sx={{ opacity: 0, animation: phase(running), ...still }}>
        <Box
          component="circle"
          cx={cx}
          cy={cy}
          r={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={5}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="0.28 0.72"
          sx={{ transformBox: "fill-box", transformOrigin: "center", animation: `${spin} 0.9s linear infinite`, ...still }}
        />
      </Box>
    </Box>
  );
}

/** Two steps feeding a third, over and over: each runs while it's connected. Still for reduced motion. */
function Dag() {
  const edge = (delay: string) => ({
    strokeDasharray: 1,
    strokeDashoffset: 1,
    animation: `${draw} ${CYCLE} cubic-bezier(.4,0,.2,1) ${delay} infinite`,
    "@media (prefers-reduced-motion: reduce)": { strokeDashoffset: 0, animation: "none" },
  });
  return (
    <Box component="svg" viewBox="0 0 240 200" sx={{ width: 200, height: "auto", color: "sidebar.accent", overflow: "visible" }} aria-hidden="true">
      <Box component="path" pathLength={1} d="M40 40 L120 160" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" sx={edge("0.2s")} />
      <Box component="path" pathLength={1} d="M200 40 L120 160" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" sx={edge("0.55s")} />
      <Step cx={40} cy={40} delay="0.2s" />
      <Step cx={200} cy={40} delay="0.55s" />
      {/* The third runs once both its inputs are connected: with the second line. */}
      <Step cx={120} cy={160} delay="0.55s" />
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
