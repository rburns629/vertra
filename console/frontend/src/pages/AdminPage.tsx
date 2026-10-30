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
import Typography from "@mui/material/Typography";
import { useAuth } from "../auth/AuthContext";
import { ErrorPage } from "../components/ErrorPage";
import { HelpLink } from "../components/HelpLink";
import { PageHeader } from "../components/PageHeader";
import { Pill, type PillTone } from "../components/Pill";
import { AdminChannelCard } from "./admin/AdminChannelCard";
import { AutomationTokensCard } from "./admin/AutomationTokensCard";
import { ChatSettingsCard } from "./admin/ChatSettingsCard";
import { ChatTab } from "./admin/ChatTab";
import { GatewayTab } from "./admin/GatewayTab";
import { ImageScansTab } from "./admin/ImageScansTab";
import { ImageSourcesCard } from "./admin/ImageSourcesCard";
import { AuditCopyCard, CatalogSection, OverviewTab, PoliciesCard } from "./admin/OverviewTab";
import { PeopleTab } from "./admin/PeopleTab";
import { SsoCard } from "./admin/SsoCard";

/** The guide that explains every section (console/docs/16-admin-settings.md). */
const GUIDE = "16-admin-settings";

/**
 * Where a section's settings are made: in the console (here), by the
 * install (vertra.yaml or the Helm values, then vertra apply), the install
 * turning it on and the console running it (both), or nothing to set.
 */
type Source = "here" | "install" | "both" | "status";
const SOURCE: Record<Source, { label: string; tone: PillTone }> = {
  here: { label: "Set here", tone: "info" },
  install: { label: "Set by the install", tone: "neutral" },
  both: { label: "Install and here", tone: "neutral" },
  status: { label: "Status only", tone: "neutral" },
};

interface Section {
  id: string;
  label: string;
  /** What it does and what it affects, in a sentence or two. */
  about: ReactNode;
  source: Source;
  /** Which part is set where, when it's not all one place. */
  where: ReactNode;
  content: ReactNode;
}

const mono = (text: string) => (
  <Box component="span" sx={{ fontFamily: "fontFamilyMono", fontSize: "0.93em" }}>
    {text}
  </Box>
);

/** The sections, grouped: each its own page, /admin/<id>. */
const GROUPS: { name: string; sections: Section[] }[] = [
  {
    name: "Install",
    sections: [
      {
        id: "overview",
        label: "Overview",
        about: "What this install still needs before teams can run anything, and which optional parts are on. Each part leads to the section that sets it.",
        source: "status",
        where: <>Optional parts are turned on in vertra.yaml ({mono("vertra config set")}, then {mono("vertra apply")}) or the Helm values.</>,
        content: <OverviewTab />,
      },
    ],
  },
  {
    name: "People and access",
    sections: [
      {
        id: "people",
        label: "People",
        about: "Everyone who can sign in: add a person (a maintainer of the teams you choose), make or remove an admin, reset a password, or delete an account.",
        source: "here",
        where: <>The first admin comes from the install ({mono("admin.email")} in vertra.yaml).</>,
        content: <PeopleTab />,
      },
      {
        id: "sign-in",
        label: "Single sign-on and groups",
        about: "Lets people sign in with your OpenID Connect provider (Google, Entra ID, Okta…), and keeps team membership and roles in step with its groups.",
        source: "both",
        where: <>The provider is set here, unless the install sets it ({mono("vertra sso")}); group mappings are always set here. Whether a team requires single sign-on is on that team&apos;s Settings tab.</>,
        content: <SsoCard />,
      },
      {
        id: "tokens",
        label: "Automation tokens",
        about: "Tokens for the platform's own automation, each with only the scopes ticked. They belong to no team: a team's bots are on that team's Automation tab.",
        source: "here",
        where: "Issued and revoked here.",
        content: <AutomationTokensCard />,
      },
    ],
  },
  {
    name: "Catalog and images",
    sections: [
      {
        id: "catalog",
        label: "Catalog",
        about: "Where teams, products and templates come from: the catalog release this install pulls, whether its signature is checked, and teams the catalog didn't make.",
        source: "both",
        where: <>The release, its signer and an external catalog are set by the install ({mono("vertra catalog create")}, vertra.yaml&apos;s {mono("catalog")}); pulling now and adopting a team are done here.</>,
        content: <CatalogSection />,
      },
      {
        id: "images",
        label: "Image sources",
        about: "The registries a step's image may come from. The cluster refuses any other image, however it was submitted (IMAGE_NOT_ALLOWED).",
        source: "both",
        where: <>The first source is set at install ({mono("taskImages.registry")}); add or remove others here. Upgrades keep what's added here.</>,
        content: <ImageSourcesCard />,
      },
      {
        id: "scans",
        label: "Image scans",
        about: "Every image's last scan. A failed image can't be registered or run until it's rebuilt, or an admin accepts it here.",
        source: "both",
        where: <>Scanning is turned on by the install (the console chart&apos;s {mono("scanning.enabled")}); rescans and accepting a finding are done here.</>,
        content: <ImageScansTab />,
      },
    ],
  },
  {
    name: "Integrations",
    sections: [
      {
        id: "gateway",
        label: "API gateway",
        about: "The gateway that serves the catalog's API products to their callers. Closing it makes every API answer 503 until it's reopened.",
        source: "both",
        where: <>Turned on and addressed by the install ({mono("gateway.enabled")}, {mono("gateway.backendHosts")}); closed and reopened here.</>,
        content: <GatewayTab />,
      },
      {
        id: "chat",
        label: "Chat agent",
        about: "The model behind Ask Vertra, which answers from the guides, and what people asked it and how they rated the answers.",
        source: "both",
        where: <>The install may set a model ({mono("chat")} in vertra.yaml); a model chosen here takes its place until you choose Use the install&apos;s.</>,
        content: (
          <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <ChatSettingsCard />
            <ChatTab />
          </Box>
        ),
      },
      {
        id: "alerts",
        label: "Admins' alerts",
        about: "Which team's chat webhook gets the alerts meant for admins, such as a catalog that can't be pulled.",
        source: "here",
        where: <>Chosen here; the hosts a webhook may post to are set by the install ({mono("notifications.webhookHosts")}).</>,
        content: <AdminChannelCard />,
      },
    ],
  },
  {
    name: "Security and audit",
    sections: [
      {
        id: "policies",
        label: "Cluster policies",
        about: "The admission policies the cluster enforces whatever the console says: which products, identities, secrets and images a step may use. The console rewrites them when those change, and at startup.",
        source: "status",
        where: "Written by the console; Write them again rewrites them now.",
        content: <PoliciesCard />,
      },
      {
        id: "audit",
        label: "Audit log copy",
        about: "The audit log's write-once copy in a bucket that refuses deletes, and whether its hash chain still holds.",
        source: "install",
        where: <>Turned on by the install ({mono("audit.export")} in vertra.yaml, on gcp and aws). The log itself is in Observe.</>,
        content: <AuditCopyCard />,
      },
    ],
  },
];
const SECTIONS = GROUPS.flatMap((g) => g.sections);

// A group's name heads its sections: bold and darker than they are, not one of them.
const GROUP_HEADER = { lineHeight: "32px", bgcolor: "transparent", px: 1.5, fontWeight: 700, color: "text.primary" } as const;

/**
 * What a section is for, where its settings are made, and its part of the
 * guide: above its cards, which carry its headings.
 */
function SectionIntro({ section }: { section: Section }) {
  const source = SOURCE[section.source];
  return (
    <Box
      component="section"
      aria-label={`About ${section.label}`}
      sx={{ mb: 2, px: 2, py: 1.5, borderRadius: 2.5, bgcolor: "background.paper", border: 1, borderColor: "divider", display: "flex", flexDirection: "column", gap: 0.75 }}
    >
      <Typography variant="body2" sx={{ maxWidth: 820 }}>
        {section.about}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
        <Pill tone={source.tone}>{source.label}</Pill>
        <Typography variant="body2" color="text.secondary" sx={{ flex: "1 1 320px", maxWidth: 760 }}>
          {section.where}
        </Typography>
      </Box>
      <Box>
        <HelpLink guide={GUIDE} section={section.label.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")} label={`About ${section.label}`} />
      </Box>
    </Box>
  );
}

/**
 * This install's settings, for admins, in sections down the side: the
 * install, who has access and how they sign in, where the catalog and its
 * images come from, what it's connected to (the gateway, the chat agent's
 * model, alerts) and what keeps it honest. Each section is in the address
 * (/admin/chat) and says where its settings are made; the old tabs'
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
        subtitle="Settings for this install. Teams, products and templates come from the catalog; runs and their state are never edited by hand. Each section says whether it's set here or by the install."
        help={{ guide: GUIDE, label: "The Admin page, setting by setting" }}
      />
      <Box sx={{ display: "grid", gap: 3, gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "220px minmax(0, 1fr)" }, alignItems: "start" }}>
        <Box component="nav" aria-label="Admin sections" sx={{ display: { xs: "none", md: "block" }, position: "sticky", top: 16 }}>
          <List dense disablePadding>
            {GROUPS.map((g) => (
              <Box component="li" key={g.name} sx={{ listStyle: "none", mb: 1 }}>
                <List dense disablePadding subheader={<ListSubheader disableSticky sx={GROUP_HEADER}>{g.name}</ListSubheader>}>
                  {g.sections.map((s) => (
                    <ListItemButton
                      key={s.id}
                      component={RouterLink}
                      to={`/admin/${s.id}`}
                      selected={s.id === section.id}
                      aria-current={s.id === section.id ? "page" : undefined}
                      sx={{ borderRadius: 1, py: 0.5, minHeight: 36, color: "text.secondary", "&.Mui-selected": { color: "text.primary", fontWeight: 500 } }}
                    >
                      <ListItemText primary={s.label} slotProps={{ primary: { variant: "body2", sx: { fontWeight: "inherit" } } }} />
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
        <Box sx={{ minWidth: 0 }}>
          <SectionIntro section={section} />
          {section.content}
        </Box>
      </Box>
    </Box>
  );
}
