// SPDX-License-Identifier: MIT
import { lazy, Suspense, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import Fab from "@mui/material/Fab";
import ChatIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import { getChatSettings } from "../api";

// Fetched the first time it's opened: markdown rendering isn't every page's.
const ChatPanel = lazy(() => import("../components/ChatPanel").then((m) => ({ default: m.ChatPanel })));

/** Ask, on every page, when the install has a chat model (decision 24): the chat panel, kept while closed. */
export function ChatLauncher() {
  const [model, setModel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    getChatSettings()
      .then((s) => { setModel(s.enabled ? s.model : null); })
      .catch(() => { setModel(null); });
  }, []);

  if (!model) return null;
  return (
    <>
      {!open && (
        <Fab
          variant="extended"
          color="primary"
          aria-label="Ask Vertra"
          onClick={() => { setOpen(true); setOpened(true); }}
          sx={{ position: "fixed", right: { xs: 16, md: 24 }, bottom: { xs: 16, md: 24 }, zIndex: (t) => t.zIndex.drawer - 1 }}
        >
          <ChatIcon sx={{ mr: 1 }} fontSize="small" />
          Ask
        </Fab>
      )}
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
    </>
  );
}
