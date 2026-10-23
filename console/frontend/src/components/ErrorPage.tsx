// SPDX-License-Identifier: MIT
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

/** A page that can't be shown, and why: not found, not allowed, or broken. */
export function ErrorPage({ title, message, children }: { title: string; message: ReactNode; children?: ReactNode }) {
  return (
    <Box sx={{ maxWidth: 560, mx: "auto", mt: { xs: 4, md: 10 }, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
      <Typography variant="h4" component="h1">
        {title}
      </Typography>
      <Typography color="text.secondary" sx={{ lineHeight: 1.6 }}>
        {message}
      </Typography>
      <Box sx={{ display: "flex", gap: 1, mt: 1, flexWrap: "wrap", justifyContent: "center" }}>
        {children ?? (
          <Button variant="contained" component={RouterLink} to="/">
            Go home
          </Button>
        )}
      </Box>
    </Box>
  );
}

/** An address the console has no page for. */
export function NotFoundPage() {
  return <ErrorPage title="Page not found" message="Nothing is at this address. It may have moved, or the link may be wrong." />;
}

/**
 * A page that broke while rendering: its error said instead of a blank
 * screen, the rest of the console still working. Reset by its key (the
 * page's address), so moving on clears it.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A page failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorPage title="Something went wrong" message="This page hit an error it couldn't recover from. Reloading usually fixes it; if it doesn't, tell your admin what you were doing.">
        <Button variant="contained" onClick={() => { window.location.reload(); }}>
          Reload
        </Button>
        <Button component={RouterLink} to="/">
          Go home
        </Button>
      </ErrorPage>
    );
  }
}
