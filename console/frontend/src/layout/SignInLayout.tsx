// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { keyframes } from "@mui/material/styles";
import { useEnvironment } from "../environment";

// A run, over and over, on one 6 s clock: a step starts running as its line
// sets out (the left one first, then the right), the third as soon as
// either line reaches it, and all three run until the lines fade and it
// starts again. Times in seconds of the cycle.
const CYCLE = 6;
const pct = (seconds: number) => `${String(Math.round((seconds / CYCLE) * 1000) / 10)}%`;
const FADE = { from: 4.8, to: 5.4 };

/** A line drawn from `from` to `to`, held, then faded with the others. */
const drawn = (from: number, to: number) => keyframes`
  0%, ${pct(from)} { stroke-dashoffset: 1; opacity: 1; }
  ${pct(to)}, ${pct(FADE.from)} { stroke-dashoffset: 0; opacity: 1; }
  ${pct(FADE.to)}, 100% { stroke-dashoffset: 0; opacity: 0; }
`;

/** While a step runs (`from` to `to`): it grows, its ring dims to a track, and an arc spins round it. */
function running(from: number, to: number) {
  const ease = 0.15;
  const window = (rest: string, on: string) => keyframes`
    0%, ${pct(from)} { ${rest} }
    ${pct(from + ease)}, ${pct(to - ease)} { ${on} }
    ${pct(to)}, 100% { ${rest} }
  `;
  return {
    grow: window("transform: scale(1);", "transform: scale(1.25);"),
    track: window("stroke-opacity: 1;", "stroke-opacity: 0.3;"),
    arc: window("opacity: 0;", "opacity: 1;"),
  };
}

const spin = keyframes`to { transform: rotate(360deg); }`;
const rise = keyframes`from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; }`;

const LINES = { left: drawn(0.3, 1.5), right: drawn(0.9, 2.1) };
// Each runs from its line setting out (the last, from the first line arriving) until the lines have faded.
const STOP = (FADE.from + FADE.to) / 2;
const RUNS = { left: running(0.3, STOP), right: running(0.9, STOP), last: running(1.5, STOP) };

const still = { "@media (prefers-reduced-motion: reduce)": { animation: "none" } };
const loop = (frames: string) => `${frames} ${String(CYCLE)}s cubic-bezier(.4,0,.2,1) infinite`;

/** A step: a ring that, while it runs, grows into a spinning status wheel. */
function Step({ cx, cy, run }: { cx: number; cy: number; run: ReturnType<typeof running> }) {
  return (
    <Box component="g" sx={{ transformBox: "fill-box", transformOrigin: "center", animation: loop(run.grow), ...still }}>
      <Box component="circle" cx={cx} cy={cy} r={16} fill="#232833" stroke="currentColor" strokeWidth={3} sx={{ animation: loop(run.track), ...still }} />
      <Box component="g" sx={{ opacity: 0, animation: loop(run.arc), ...still }}>
        <Box
          component="circle"
          cx={cx}
          cy={cy}
          r={16}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="0.28 0.72"
          sx={{ transformBox: "fill-box", transformOrigin: "center", animation: `${spin} 0.9s linear infinite`, ...still }}
        />
      </Box>
    </Box>
  );
}

/** Two steps feeding a third, run over and over as a DAG runs. Still for reduced motion. */
function Dag() {
  const edge = (frames: string) => ({
    strokeDasharray: 1,
    strokeDashoffset: 1,
    animation: loop(frames),
    "@media (prefers-reduced-motion: reduce)": { strokeDashoffset: 0, animation: "none" },
  });
  return (
    <Box component="svg" viewBox="0 0 240 200" sx={{ width: 200, height: "auto", color: "sidebar.accent", overflow: "visible" }} aria-hidden="true">
      <Box component="path" pathLength={1} d="M40 40 L120 160" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" sx={edge(LINES.left)} />
      <Box component="path" pathLength={1} d="M200 40 L120 160" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" sx={edge(LINES.right)} />
      <Step cx={40} cy={40} run={RUNS.left} />
      <Step cx={200} cy={40} run={RUNS.right} />
      <Step cx={120} cy={160} run={RUNS.last} />
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
