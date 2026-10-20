// SPDX-License-Identifier: MIT
import { alpha, createTheme } from "@mui/material/styles";

// Vertra's design tokens. Everything the console colors or sets in mono
// comes from here; a page reaches these through sx by name
// (bgcolor: "code.background", fontFamily: "fontFamilyMono").

/** Two dark surfaces with different jobs: the sidebar is navigation
 * chrome, `code` is where machine output is read (logs, code samples). */
interface DarkSurface {
  background: string;
  text: string;
  textMuted: string;
  /** Highlights on this surface; the light-theme primary is too dark here. */
  accent: string;
}
interface SidebarPalette extends DarkSurface {
  border: string;
  textStrong: string;
  activeBg: string;
  activeText: string;
  hoverBg: string;
}
declare module "@mui/material/styles" {
  interface Palette {
    sidebar: SidebarPalette;
    code: DarkSurface;
  }
  interface PaletteOptions {
    sidebar?: SidebarPalette;
    code?: DarkSurface;
  }
  interface TypographyVariants {
    fontFamilyMono: string;
  }
  interface TypographyVariantsOptions {
    fontFamilyMono?: string;
  }
}

const PRIMARY = "#4338ca";
// Indigo 300: the primary's hue, light enough for both dark surfaces
// (7.9:1 on the code surface, 8.6:1 on the sidebar).
const PRIMARY_ON_DARK = "#a5b4fc";

// One keyboard focus ring for everything focusable, instead of MUI's
// per-component defaults (a faint background shift on list items and
// buttons, nothing at all on links and scroll regions). The 2px offset keeps
// it clear of the control's own border.
const FOCUS_RING = { outline: `2px solid ${PRIMARY}`, outlineOffset: 2 };

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: PRIMARY },
    // MUI's default warning (#ed6c02) and info (#0288d1) fail WCAG AA under
    // white text (3.1:1 and 4.0:1), and filled chips (the environment badge,
    // Running/Pending statuses, PUT/PATCH) put white text on them. Same hues,
    // deep enough to pass: white on these is 5.0:1 and 5.9:1, and as text on
    // the page background (outlined buttons) 4.7:1 and 5.6:1.
    warning: { main: "#b45309" },
    info: { main: "#0369a1" },
    background: { default: "#f7f7fb" },
    sidebar: {
      background: "#111827",
      border: "rgba(255,255,255,0.08)",
      text: "#cbd5e1",
      textMuted: "#7c8aa5",
      textStrong: "#ffffff",
      accent: PRIMARY_ON_DARK,
      activeBg: "rgba(99,102,241,0.18)",
      activeText: "#c7d2fe",
      hoverBg: "rgba(255,255,255,0.06)",
    },
    // One surface for every block of machine output. The success.light and
    // error.light event colors in the log feed pass on it (5.6:1, 4.7:1).
    code: {
      background: "#1d1f24",
      text: "#e8e8e3",
      textMuted: "#9e9e9e",
      accent: PRIMARY_ON_DARK,
    },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"].join(","),
    fontFamilyMono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"].join(","),
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        "::selection": { backgroundColor: alpha(PRIMARY, 0.18) },
        // Native focusables MUI doesn't style: links in rendered docs, the
        // focusable scroll regions (logs, code blocks, wide tables).
        "a:focus-visible, [tabindex='0']:focus-visible": { ...FOCUS_RING, borderRadius: 2 },
        // Counts, durations and timestamps line up column to column.
        "td, th": { fontVariantNumeric: "tabular-nums" },
        // Respect the OS setting: no slides, fades or ripples. The loading
        // spinner keeps turning, since a frozen one reads as a hang.
        "@media (prefers-reduced-motion: reduce)": {
          "*:not(.MuiCircularProgress-root):not(.MuiCircularProgress-svg):not(.MuiCircularProgress-circle), *::before, *::after": {
            animationDuration: "0.01ms !important",
            animationIterationCount: "1 !important",
            transitionDuration: "0.01ms !important",
            scrollBehavior: "auto !important",
          },
        },
      },
    },
    MuiButtonBase: {
      styleOverrides: { root: { "&.Mui-focusVisible": FOCUS_RING } },
    },
    MuiAppBar: {
      defaultProps: { color: "inherit", elevation: 0 },
      styleOverrides: { root: { borderBottom: "1px solid rgba(0,0,0,0.08)" } },
    },
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: "none" } },
    },
    // Unselected toggle buttons default to action.active (54% black), which
    // lands at 4.49:1 on the page background: just under AA.
    MuiToggleButton: {
      styleOverrides: { root: ({ theme }) => ({ color: theme.palette.text.secondary }) },
    },
  },
});
