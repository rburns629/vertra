// SPDX-License-Identifier: MIT
import { Suspense, useState } from "react";
import { Link as RouterLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
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
import PlayCircleIcon from "@mui/icons-material/PlayCircleOutlined";
import RunIcon from "@mui/icons-material/RocketLaunchOutlined";
import GroupsIcon from "@mui/icons-material/GroupsOutlined";
import InventoryIcon from "@mui/icons-material/Inventory2Outlined";
import DocsIcon from "@mui/icons-material/MenuBookOutlined";
import AdminIcon from "@mui/icons-material/AdminPanelSettingsOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import KeyIcon from "@mui/icons-material/KeyOutlined";
import ExpandMoreIcon from "@mui/icons-material/UnfoldMore";
import { useAuth } from "../auth/AuthContext";
import { EnvironmentBadge } from "./EnvironmentBadge";

const DRAWER_WIDTH = 232;

const NAV_ITEMS = [
  { label: "Home", to: "/", icon: <HomeIcon /> },
  { label: "Run", to: "/run", icon: <RunIcon /> },
  { label: "Executions", to: "/executions", icon: <PlayCircleIcon /> },
  { label: "Products", to: "/products", icon: <InventoryIcon /> },
  { label: "Teams", to: "/teams", icon: <GroupsIcon /> },
  { label: "Docs", to: "/docs", icon: <DocsIcon /> },
];

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  // Below md the sidebar would take most of a phone's width, so it becomes
  // a temporary drawer opened from the top bar instead of a permanent column.
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const [navOpen, setNavOpen] = useState(false);

  if (!user) return null;

  const items = user.isAdmin
    ? [...NAV_ITEMS, { label: "Admin", to: "/admin", icon: <AdminIcon /> }]
    : NAV_ITEMS;

  const goTo = (to: string) => {
    setNavOpen(false);
    navigate(to);
  };

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
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
          },
        }}
      >
        <Toolbar sx={{ gap: 1.25 }}>
          <Box
            sx={{
              width: 28,
              height: 28,
              borderRadius: 1,
              bgcolor: "primary.main",
              flexShrink: 0,
            }}
          />
          <Typography sx={{ fontWeight: 600, color: "sidebar.textStrong", fontSize: 15 }}>Vertra Console</Typography>
        </Toolbar>

        <List component="nav" aria-label="Main" sx={{ px: 1.25, pt: 1, flexGrow: 1 }}>
          {items.map((item) => {
            const selected =
              item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
            return (
              <ListItemButton
                key={item.to}
                component={RouterLink}
                to={item.to}
                selected={selected}
                aria-current={selected ? "page" : undefined}
                onClick={() => {
                  setNavOpen(false);
                }}
                sx={{
                  borderRadius: 1.5,
                  mb: 0.5,
                  color: selected ? "sidebar.activeText" : "sidebar.text",
                  "&:hover": { bgcolor: "sidebar.hoverBg" },
                  "&.Mui-focusVisible": { outlineColor: (t) => t.palette.sidebar.accent },
                  "&.Mui-selected": {
                    bgcolor: "sidebar.activeBg",
                    "&:hover": { bgcolor: "sidebar.activeBg" },
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 36, color: "inherit" }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.label} slotProps={{ primary: { sx: { fontSize: 14 } } }} />
              </ListItemButton>
            );
          })}
        </List>

        <Divider sx={{ borderColor: "sidebar.border" }} />
        <ButtonBase
          aria-haspopup="menu"
          aria-expanded={Boolean(menuAnchor)}
          sx={{
            p: 1.5,
            display: "flex",
            alignItems: "center",
            gap: 1,
            textAlign: "left",
            borderRadius: 1.5,
            m: 1,
            "&:hover": { bgcolor: "sidebar.hoverBg" },
            "&.Mui-focusVisible": { bgcolor: "sidebar.hoverBg", outlineColor: (t) => t.palette.sidebar.accent },
          }}
          onClick={(event) => {
            setMenuAnchor(event.currentTarget);
          }}
        >
          <Avatar sx={{ width: 32, height: 32, bgcolor: "primary.main", fontSize: 14 }}>
            {user.email[0]?.toUpperCase()}
          </Avatar>
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography noWrap sx={{ fontSize: 13, color: "sidebar.textStrong", lineHeight: 1.3 }}>
              {user.email}
            </Typography>
            <Typography sx={{ fontSize: 12, color: "sidebar.textMuted", lineHeight: 1.3 }}>
              {user.isAdmin ? "admin" : "member"}
            </Typography>
          </Box>
          <ExpandMoreIcon sx={{ fontSize: 18, color: "sidebar.textMuted" }} />
        </ButtonBase>
        <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => { setMenuAnchor(null); }}>
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              goTo("/account");
            }}
          >
            <ListItemIcon>
              <KeyIcon fontSize="small" />
            </ListItemIcon>
            Change password
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenuAnchor(null);
              logout();
              goTo("/login");
            }}
          >
            <ListItemIcon>
              <LogoutIcon fontSize="small" />
            </ListItemIcon>
            Sign out
          </MenuItem>
        </Menu>
      </Drawer>

      <Box sx={{ flexGrow: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <AppBar position="static" color="inherit" elevation={0}>
          <Toolbar sx={{ gap: 1.5 }}>
            {!isDesktop && (
              <>
                <IconButton
                  edge="start"
                  aria-label="Open navigation"
                  onClick={() => { setNavOpen(true); }}
                >
                  <MenuIcon />
                </IconButton>
                <Typography sx={{ fontWeight: 600, fontSize: 15 }}>Vertra Console</Typography>
              </>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <EnvironmentBadge />
          </Toolbar>
        </AppBar>
        {/* No maxWidth/centering here on purpose -- that squeezed every page,
            including ones that genuinely want the full available width,
            into the same narrow centered column regardless of what
            they're actually showing. */}
        <Box
          component="main"
          sx={{ flexGrow: 1, bgcolor: "background.default", p: { xs: 2, sm: 3 }, minWidth: 0 }}
        >
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
