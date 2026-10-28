// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { Link as RouterLink, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import { useAuth } from "../auth/AuthContext";
import { ErrorPage } from "../components/ErrorPage";
import { PageHeader } from "../components/PageHeader";
import { AdminChannelCard } from "./admin/AdminChannelCard";
import { AutomationTokensCard } from "./admin/AutomationTokensCard";
import { ChatSettingsCard } from "./admin/ChatSettingsCard";
import { ChatTab } from "./admin/ChatTab";
import { GatewayTab } from "./admin/GatewayTab";
import { ImageScansTab } from "./admin/ImageScansTab";
import { CatalogSection, OverviewTab, PoliciesSection } from "./admin/OverviewTab";
import { PeopleTab } from "./admin/PeopleTab";
import { SsoCard } from "./admin/SsoCard";

interface Section {
  id: string;
  label: string;
  content: ReactNode;
}

/** The sections, grouped: each its own page, /admin/<id>. */
const GROUPS: { name: string; sections: Section[] }[] = [
  { name: "Install", sections: [{ id: "overview", label: "Overview", content: <OverviewTab /> }] },
  {
    name: "Access",
    sections: [
      { id: "people", label: "People", content: <PeopleTab /> },
      { id: "sign-in", label: "Sign-in & groups", content: <SsoCard /> },
      { id: "tokens", label: "Automation tokens", content: <AutomationTokensCard /> },
    ],
  },
  {
    name: "Integrations",
    sections: [
      {
        id: "chat",
        label: "Chat agent",
        content: (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <ChatSettingsCard />
            <ChatTab />
          </Box>
        ),
      },
      { id: "catalog", label: "Catalog & images", content: <CatalogSection /> },
      { id: "gateway", label: "API gateway", content: <GatewayTab /> },
      { id: "alerts", label: "Admins' alerts", content: <AdminChannelCard /> },
    ],
  },
  {
    name: "Security",
    sections: [
      { id: "scans", label: "Image scans", content: <ImageScansTab /> },
      { id: "policies", label: "Policies & audit", content: <PoliciesSection /> },
    ],
  },
];
const SECTIONS = GROUPS.flatMap((g) => g.sections);

// A group's name heads its sections: bold and darker than they are, not one of them.
const GROUP_HEADER = { lineHeight: "32px", bgcolor: "transparent", px: 1.5, fontWeight: 700, color: "text.primary" } as const;

/**
 * This install's settings, for admins, in sections down the side: the
 * install, who has access and how they sign in, what it's connected to
 * (the chat agent's model, the catalog, the gateway, alerts) and what keeps
 * it safe. Each section is in the address (/admin/chat); the old tabs'
 * addresses (?tab=people) still lead to theirs.
 */
export function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { section: id } = useParams();
  const [params] = useSearchParams();

  if (!user?.isAdmin) {
    return <ErrorPage title="Admins only" message="This page holds the install's settings, for its admins. Ask one if you need something changed." />;
  }
  const tab = params.get("tab");
  if (!id && tab && SECTIONS.some((s) => s.id === tab)) return <Navigate to={`/admin/${tab}`} replace />;
  const section = SECTIONS.find((s) => s.id === (id ?? "overview"));
  if (!section) return <Navigate to="/admin" replace />;

  return (
    <Box>
      <PageHeader
        title="Admin"
        subtitle="Settings for this install. Teams, products and templates come from the catalog; runs and their state are never edited by hand."
      />
      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "200px minmax(0, 1fr)" }, alignItems: "start" }}>
        <Box component="nav" aria-label="Admin sections" sx={{ display: { xs: "none", md: "block" }, position: "sticky", top: 16 }}>
          <List dense disablePadding>
            {GROUPS.map((g) => (
              <Box component="li" key={g.name} sx={{ listStyle: "none" }}>
                <List dense disablePadding subheader={<ListSubheader disableSticky sx={GROUP_HEADER}>{g.name}</ListSubheader>}>
                  {g.sections.map((s) => (
                    <ListItemButton
                      key={s.id}
                      component={RouterLink}
                      to={`/admin/${s.id}`}
                      selected={s.id === section.id}
                      aria-current={s.id === section.id ? "page" : undefined}
                      sx={{ borderRadius: 1, py: 0.5, color: "text.secondary", "&.Mui-selected": { color: "text.primary" } }}
                    >
                      <ListItemText primary={s.label} slotProps={{ primary: { variant: "body2" } }} />
                    </ListItemButton>
                  ))}
                </List>
              </Box>
            ))}
          </List>
        </Box>
        <TextField
          select
          size="small"
          label="Section"
          value={section.id}
          onChange={(e) => { navigate(`/admin/${e.target.value}`); }}
          sx={{ display: { xs: "flex", md: "none" } }}
        >
          {GROUPS.flatMap((g) => [
            <ListSubheader key={g.name} sx={{ ...GROUP_HEADER, lineHeight: "36px" }}>
              {g.name}
            </ListSubheader>,
            ...g.sections.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.label}
              </MenuItem>
            )),
          ])}
        </TextField>
        <Box sx={{ minWidth: 0 }}>{section.content}</Box>
      </Box>
    </Box>
  );
}
