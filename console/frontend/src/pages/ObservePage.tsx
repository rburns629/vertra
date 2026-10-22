// SPDX-License-Identifier: MIT
import { AuditTab } from "./observe/AuditTab";
import { LogsTab } from "./observe/LogsTab";
import { MetricsTab } from "./observe/MetricsTab";
import { SecurityTab } from "./observe/SecurityTab";
import { useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { PageHeader } from "../components/PageHeader";

type TabId = "security" | "metrics" | "logs" | "audit";
const TABS: [TabId, string][] = [
  ["security", "Security checks"],
  ["metrics", "Metrics"],
  ["logs", "Logs"],
  ["audit", "Audit log"],
];

/**
 * Observe: what this install checks, what it refused, and what everything
 * is doing. Everyone signed in sees the security checks; a run's details
 * follow who may see that run.
 */
export function ObservePage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([id]) => id === params.get("tab"))?.[0] ?? "security") satisfies TabId;
  return (
    <Box>
      <PageHeader
        title="Observe"
        subtitle="What this install checks, what it refused, and what everything is doing. Everyone can see this; logs follow who can see each run."
      />
      <Tabs
        value={tab}
        onChange={(_e, value: TabId) => {
          setParams({ tab: value });
        }}
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}
      >
        {TABS.map(([id, label]) => (
          <Tab key={id} value={id} label={label} />
        ))}
      </Tabs>
      {tab === "security" && <SecurityTab />}
      {tab === "metrics" && <MetricsTab />}
      {tab === "logs" && <LogsTab initialRun={params.get("run") ?? ""} />}
      {tab === "audit" && <AuditTab />}
    </Box>
  );
}
