// SPDX-License-Identifier: MIT
import { lazy, Suspense, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import ChatIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import { getChatSettings } from "../api";
import { useAuth } from "../auth/AuthContext";

// Fetched the first time it's opened: markdown rendering isn't every page's.
const ChatPanel = lazy(() => import("../components/ChatPanel").then((m) => ({ default: m.ChatPanel })));

/**
 * Ask (decision 24): in the sidebar beside the navigation on a desktop, in
 * the top bar on a phone, and the chat panel it opens, kept while closed.
 * Without a model it's there but off, saying who turns it on.
 */
export function ChatLauncher({ placement }: { placement: "sidebar" | "toolbar" }) {
  const { user } = useAuth();
  // undefined while asking; null when there's no model.
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    getChatSettings()
      .then((s) => { setModel(s.enabled ? s.model : null); })
      .catch(() => { setModel(null); });
  }, []);

  if (model === undefined) return null;
  const off = model === null;
  const why = user?.isAdmin ? "Not set up: choose its model in Admin, Chat agent" : "Not set up yet: an admin chooses its model";
  const ask = () => {
    setOpen(true);
    setOpened(true);
  };

  const trigger =
    placement === "sidebar" ? (
      <ListItemButton
        disabled={off}
        onClick={ask}
        aria-label="Ask Vertra"
        sx={{
          // Its own height: the sidebar is a column, and ListItemButton grows to fill one.
          flex: "none",
          mx: 1.5,
          borderRadius: 2,
          minHeight: 40,
          border: 1,
          borderColor: "sidebar.border",
          color: "sidebar.text",
          "&:hover": { bgcolor: "sidebar.hoverBg", color: "sidebar.textStrong" },
          "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent },
          "&.Mui-disabled": { opacity: 0.55 },
        }}
      >
        <ListItemIcon sx={{ minWidth: 32, color: off ? "inherit" : "sidebar.accent", "& svg": { fontSize: 19 } }}>
          <ChatIcon />
        </ListItemIcon>
        <ListItemText
          primary="Ask Vertra"
          secondary={off ? "Not set up" : undefined}
          slotProps={{ primary: { sx: { fontSize: 14 } }, secondary: { sx: { fontSize: 12, color: "sidebar.textMuted" } } }}
        />
      </ListItemButton>
    ) : (
      <IconButton aria-label="Ask Vertra" disabled={off} onClick={ask}>
        <ChatIcon fontSize="small" />
      </IconButton>
    );

  return (
    <>
      {/* A disabled control gets no hover: the tooltip sits on what holds it. */}
      {off ? (
        <Tooltip title={why} placement={placement === "sidebar" ? "right" : "bottom"}>
          <Box component="span" sx={{ display: placement === "sidebar" ? "block" : "inline-flex" }}>
            {trigger}
          </Box>
        </Tooltip>
      ) : (
        trigger
      )}
      {!off && (
        <Drawer anchor="right" open={open} onClose={() => { setOpen(false); }} keepMounted={opened}>
          {opened && (
            <Suspense
              fallback={
                <Box sx={{ width: { xs: "100vw", sm: 440 }, display: "flex", justifyContent: "center", py: 6 }}>
                  <CircularProgress size={24} aria-label="Loading" />
                </Box>
              }
            >
              <ChatPanel model={model} onClose={() => { setOpen(false); }} />
            </Suspense>
          )}
        </Drawer>
      )}
    </>
  );
}
