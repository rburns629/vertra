// SPDX-License-Identifier: MIT
import { Suspense, useState } from "react";
import { Link as RouterLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import MenuIcon from "@mui/icons-material/Menu";
import HomeIcon from "@mui/icons-material/HomeOutlined";
import CatalogIcon from "@mui/icons-material/GridViewOutlined";
import ApiIcon from "@mui/icons-material/CodeOutlined";
import RunsIcon from "@mui/icons-material/PlayArrowOutlined";
import ObserveIcon from "@mui/icons-material/InsightsOutlined";
import GroupsIcon from "@mui/icons-material/GroupsOutlined";
import AdminIcon from "@mui/icons-material/VerifiedUserOutlined";
import SettingsIcon from "@mui/icons-material/SettingsOutlined";
import PersonIcon from "@mui/icons-material/PersonOutlined";
import HelpIcon from "@mui/icons-material/HelpOutlineOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import type { Me } from "../api";
import { useAuth } from "../auth/AuthContext";
import { useEnvironment } from "../environment";

const DRAWER_WIDTH = 248;

/** Each place in the console; `also` are paths that belong to it too. */
const NAV_ITEMS = [
  { label: "Home", to: "/", icon: <HomeIcon />, also: [] as string[] },
  { label: "Catalog", to: "/catalog", icon: <CatalogIcon />, also: ["/products"] },
  { label: "APIs", to: "/apis", icon: <ApiIcon />, also: [] },
  { label: "Runs", to: "/runs", icon: <RunsIcon />, also: [] },
  { label: "Observe", to: "/observe", icon: <ObserveIcon />, also: [] },
  { label: "Teams", to: "/teams", icon: <GroupsIcon />, also: [] },
];
const ADMIN_ITEM = { label: "Admin", to: "/admin", icon: <AdminIcon />, also: [] as string[] };

const isUnder = (path: string, prefix: string) => (prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`));

/** Who you are here, in a few words: "admin", "maintainer · azure-apps". */
function roleLine(user: Me): string {
  if (user.isAdmin) return "admin";
  const [first] = user.maintainerOf;
  if (first) return `maintainer · ${first}`;
  const [team] = user.teamNames;
  return team ? `member · ${team}` : "no team yet";
}

/** Two DAG steps feeding a third: the Vertra mark. */
function Mark() {
  return (
    <Box component="svg" viewBox="0 0 24 24" sx={{ width: 22, height: 22, flexShrink: 0, color: "sidebar.accent" }} aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2.5" />
        <circle cx="19" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="M7 7.5l3.5 8.5M17 7.5l-3.5 8.5" />
      </g>
    </Box>
  );
}

/** Which install this tab is talking to (the chart's environmentLabel). */
function InstallCard() {
  const label = useEnvironment()?.label;
  if (!label) return null;
  return (
    <Box sx={{ mx: 1.5, px: 1.5, py: 1.25, borderRadius: 2, bgcolor: "sidebar.hoverBg", display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography sx={{ fontSize: 11, color: "sidebar.textMuted", textTransform: "uppercase", letterSpacing: 0.6 }}>This install</Typography>
      <Typography sx={{ fontFamily: "fontFamilyMono", fontSize: 13, color: "sidebar.text", overflowWrap: "anywhere" }}>{label}</Typography>
    </Box>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  // Below md the sidebar would take most of a phone's width, so it becomes
  // a temporary drawer opened from a top bar instead of a permanent column.
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const [navOpen, setNavOpen] = useState(false);

  if (!user) return null;

  const items = user.isAdmin ? [...NAV_ITEMS, ADMIN_ITEM] : NAV_ITEMS;

  const goTo = (to: string) => {
    setMenuAnchor(null);
    setNavOpen(false);
    navigate(to);
  };

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      <Drawer
        variant={isDesktop ? "permanent" : "temporary"}
        open={isDesktop || navOpen}
        onClose={() => { setNavOpen(false); }}
        ModalProps={{ keepMounted: true }}
        sx={{
          width: isDesktop ? DRAWER_WIDTH : undefined,
          flexShrink: 0,
          [`& .MuiDrawer-paper`]: {
            width: DRAWER_WIDTH,
            boxSizing: "border-box",
            bgcolor: "sidebar.background",
            borderRight: 1,
            borderColor: "sidebar.border",
            color: "sidebar.text",
            pt: 2.5,
            pb: 1.5,
            gap: 2.5,
          },
        }}
      >
        <Box
          component={RouterLink}
          to="/"
          onClick={() => { setNavOpen(false); }}
          sx={{ display: "flex", alignItems: "center", gap: 1.25, px: 2.25, color: "sidebar.textStrong", textDecoration: "none", fontWeight: 600, fontSize: 17 }}
        >
          <Mark />
          Vertra
        </Box>

        <InstallCard />

        <List component="nav" aria-label="Main" sx={{ px: 1.5, py: 0, flexGrow: 1 }}>
          {items.map((item) => {
            const selected = [item.to, ...item.also].some((p) => isUnder(location.pathname, p));
            return (
              <ListItemButton
                key={item.to}
                component={RouterLink}
                to={item.to}
                selected={selected}
                aria-current={selected ? "page" : undefined}
                onClick={() => { setNavOpen(false); }}
                sx={{
                  borderRadius: 2,
                  mb: 0.25,
                  minHeight: 40,
                  color: selected ? "sidebar.activeText" : "sidebar.text",
                  "&:hover": { bgcolor: "sidebar.hoverBg", color: "sidebar.textStrong" },
                  "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent },
                  "&.Mui-selected": {
                    bgcolor: "sidebar.activeBg",
                    "&:hover": { bgcolor: "sidebar.activeBg" },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 32, color: "inherit", "& svg": { fontSize: 19 } }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: 14, fontWeight: selected ? 500 : 400 } } }} />
              </ListItemButton>
            );
          })}
        </List>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, mx: 1.5, pt: 1.25, px: 0.75, borderTop: 1, borderColor: "sidebar.border" }}>
          <Avatar sx={{ width: 32, height: 32, bgcolor: "primary.main", fontSize: 12, fontWeight: 600 }} aria-hidden="true">
            {user.email.slice(0, 2).toUpperCase()}
          </Avatar>
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography noWrap sx={{ fontSize: 13, color: "sidebar.textStrong", lineHeight: 1.35 }}>
              {user.email}
            </Typography>
            <Typography noWrap sx={{ fontSize: 12, color: "sidebar.textMuted", lineHeight: 1.35 }}>
              {roleLine(user)}
            </Typography>
          </Box>
          <IconButton
            aria-label="Settings"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            onClick={(event) => { setMenuAnchor(event.currentTarget); }}
            sx={{
              color: "sidebar.text",
              borderRadius: 2,
              "&:hover": { bgcolor: "sidebar.hoverBg", color: "sidebar.textStrong" },
              "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent },
            }}
          >
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Box>
        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={() => { setMenuAnchor(null); }}
          anchorOrigin={{ vertical: "top", horizontal: "right" }}
          transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        >
          <MenuItem onClick={() => { goTo("/account"); }}>
            <ListItemIcon>
              <PersonIcon fontSize="small" />
            </ListItemIcon>
            Preferences
          </MenuItem>
          <MenuItem onClick={() => { goTo("/docs"); }}>
            <ListItemIcon>
              <HelpIcon fontSize="small" />
            </ListItemIcon>
            Help and guides
          </MenuItem>
          <MenuItem
            onClick={() => {
              logout();
              goTo("/login");
            }}
            sx={{ color: "error.main" }}
          >
            <ListItemIcon sx={{ color: "inherit" }}>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
            Sign out
          </MenuItem>
        </Menu>
      </Drawer>

      <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {!isDesktop && (
          <AppBar position="sticky" color="inherit" elevation={0}>
            <Toolbar sx={{ gap: 1 }}>
              <IconButton edge="start" aria-label="Open navigation" onClick={() => { setNavOpen(true); }}>
                <MenuIcon />
              </IconButton>
              <Typography sx={{ fontWeight: 600, fontSize: 16 }}>Vertra</Typography>
            </Toolbar>
          </AppBar>
        )}
        {/* No maxWidth/centering here on purpose -- that squeezed every page,
            including ones that genuinely want the full available width,
            into the same narrow centered column regardless of what
            they're actually showing. */}
        <Box component="main" sx={{ flexGrow: 1, px: { xs: 2, sm: 3, md: 6 }, pt: { xs: 2, sm: 3, md: 4 }, pb: 6, minWidth: 0 }}>
          <Suspense
            fallback={
              <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
                <CircularProgress size={28} aria-label="Loading page" />
              </Box>
            }
          >
            <Outlet />
          </Suspense>
        </Box>
      </Box>
    </Box>
  );
}
