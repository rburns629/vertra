// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import { getDocImage } from "../../api";

/** A figure's path from the docs (architecture/6-the-pieces.svg), from a link or image written relative to the doc; null for anything else. */
export function figurePath(src: string | undefined): string | null {
  if (!src || /^[a-z]+:/i.test(src) || src.startsWith("/")) return null;
  const path = src.replace(/^(\.\.?\/)+/, "").replace(/^docs\//, "");
  return /^[a-z0-9-]+\/[a-z0-9-]+\.svg$/.test(path) ? path : null;
}

// Each figure is fetched once a visit, however many pages show it.
const loaded = new Map<string, Promise<string>>();
function useFigure(path: string, wanted = true): string | null | undefined {
  // undefined while loading; null when it couldn't be.
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    let pending = loaded.get(path);
    if (!pending) {
      pending = getDocImage(path);
      loaded.set(path, pending);
      pending.catch(() => loaded.delete(path));
    }
    pending.then((u) => { if (current) setUrl(u); }, () => { if (current) setUrl(null); });
    return () => {
      current = false;
    };
  }, [path, wanted]);
  return url;
}

/** The figure at its own size, scrolling both ways when it's bigger than the screen. */
function FullSize({ path, title, open, onClose }: { path: string; title: string; open: boolean; onClose: () => void }) {
  const url = useFigure(path, open);
  return (
    <Dialog open={open} onClose={onClose} maxWidth={false} fullWidth slotProps={{ paper: { sx: { height: "92vh" } } }}>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1, pr: 1 }}>
        <Typography component="span" sx={{ flex: 1, fontWeight: 600 }}>
          {title}
        </Typography>
        <IconButton aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0, overflow: "auto", bgcolor: "#fff" }} tabIndex={0}>
        {url === undefined && <Typography sx={{ p: 2 }} color="text.secondary">Loading…</Typography>}
        {url === null && <Typography sx={{ p: 2 }} color="error">Couldn&apos;t load this figure.</Typography>}
        {url && <Box component="img" src={url} alt={title} sx={{ display: "block", maxWidth: "none", m: 2 }} />}
      </DialogContent>
    </Dialog>
  );
}

/** A figure in a doc (![what it shows](architecture/….svg)): shown to fit, and opened at full size. */
export function DocFigure({ path, alt }: { path: string; alt: string }) {
  const url = useFigure(path);
  const [open, setOpen] = useState(false);
  if (url === null) return <Typography color="text.secondary">[Figure: {alt}]</Typography>;
  return (
    <Box component="figure" sx={{ m: 0, my: 3 }}>
      <ButtonBase
        onClick={() => { setOpen(true); }}
        aria-label="Open the figure at full size"
        sx={{ display: "block", width: "100%", border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, bgcolor: "#fff", textAlign: "left", "&:hover": { borderColor: "primary.main" } }}
      >
        {url ? <Box component="img" src={url} alt={alt} sx={{ display: "block", maxWidth: "100%", height: "auto", mx: "auto" }} /> : <Box sx={{ height: 240 }} />}
      </ButtonBase>
      <Typography component="figcaption" variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.75 }}>
        <ZoomInIcon sx={{ fontSize: 16 }} /> Select the figure to see it at full size.
      </Typography>
      <FullSize path={path} title={alt.split(":")[0] ?? alt} open={open} onClose={() => { setOpen(false); }} />
    </Box>
  );
}

/** A link to a figure ([the system diagram](architecture/1-system.svg)): opens it at full size, here. */
export function FigureLink({ path, children }: { path: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href={`#figure-${path}`}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      <FullSize path={path} title={typeof children === "string" ? children.charAt(0).toUpperCase() + children.slice(1) : path} open={open} onClose={() => { setOpen(false); }} />
    </>
  );
}
