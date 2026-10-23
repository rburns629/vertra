// SPDX-License-Identifier: MIT
import { useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { useAuth } from "../auth/AuthContext";
import { ErrorPage } from "../components/ErrorPage";
import { PageHeader } from "../components/PageHeader";
import { GatewayTab } from "./admin/GatewayTab";
import { OverviewTab } from "./admin/OverviewTab";
import { PeopleTab } from "./admin/PeopleTab";

type TabId = "overview" | "people" | "gateway";

/**
 * This install's settings, for admins: Overview (the catalog, the cluster's
 * policies, the audit log's copy, image sources), People (signing in and
 * accounts), and the API gateway. The tab is in the address (?tab=people).
 */
export function AdminPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabId = requested === "people" || requested === "gateway" ? requested : "overview";

  if (!user?.isAdmin) {
    return <ErrorPage title="Admins only" message="This page holds the install's settings, for its admins. Ask one if you need something changed." />;
  }

  return (
    <Box>
      <PageHeader
        title="Admin"
        subtitle="Settings for this install. Teams, products and templates come from the catalog; runs and their state are never edited by hand."
      />
      <Tabs
        value={tab}
        onChange={(_e, value: TabId) => { setParams(value === "overview" ? {} : { tab: value }, { replace: true }); }}
        sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab value="overview" label="Overview" />
        <Tab value="people" label="People" />
        <Tab value="gateway" label="Gateway" />
      </Tabs>
      {tab === "overview" && <OverviewTab />}
      {tab === "people" && <PeopleTab />}
      {tab === "gateway" && <GatewayTab />}
    </Box>
  );
}
