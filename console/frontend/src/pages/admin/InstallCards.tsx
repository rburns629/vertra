// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import CheckIcon from "@mui/icons-material/CheckCircle";
import TodoIcon from "@mui/icons-material/RadioButtonUnchecked";
import { getCatalogStatus, getChatSettings, getImagePolicy, getInstall, listAllTeams, listUsers, type InstallInfo } from "../../api";
import { Pill } from "../../components/Pill";

const mono = { fontFamily: "fontFamilyMono", fontSize: 13 } as const;
const code = (text: string) => <Box component="span" sx={mono}>{text}</Box>;

/** One optional part: on, or what turns it on; its name leads to its section, when it has one. */
function Part({ name, on, detail, howTo, to }: { name: string; on: boolean; detail?: string; howTo: ReactNode; to?: string }) {
  return (
    <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, py: 1, borderTop: 1, borderColor: "divider" }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2">
          {to ? (
            <Link component={RouterLink} to={to}>
              {name}
            </Link>
          ) : (
            name
          )}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {on ? detail : howTo}
        </Typography>
      </Box>
      {on ? <Pill tone="success">On</Pill> : <Pill tone="neutral">Off</Pill>}
    </Box>
  );
}

/** This install: its version, and which optional parts are on (each a setting in vertra.yaml). */
export function InstallCard() {
  const [install, setInstall] = useState<InstallInfo | null>(null);
  const [chat, setChat] = useState<{ enabled: boolean; model: string } | null>(null);
  useEffect(() => {
    // Display only: without it, the card isn't shown.
    getInstall().then(setInstall).catch(() => undefined);
    getChatSettings().then(setChat).catch(() => undefined);
  }, []);
  if (!install) return null;
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1, mb: 1 }}>
        <Typography variant="h6" component="h2">
          This install
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {install.environmentLabel} · {code(install.version)}
        </Typography>
      </Box>
      <Part name="Signing in with single sign-on" to="/admin/sign-in" on={install.ssoProvider !== ""} detail={install.ssoProvider} howTo="Set up in Single sign-on and groups" />
      <Part name="The chat agent" to="/admin/chat" on={chat?.enabled ?? false} detail={chat?.model} howTo="Choose its model in Chat agent" />
      <Part name="The catalog" to="/admin/catalog" on={install.catalog} detail={install.catalogSigned ? "Releases' signatures checked" : "Releases read, signatures not checked"} howTo={<>{code("vertra catalog create")}</>} />
      <Part name="Images scanned before they run" to="/admin/scans" on={install.scanning} detail="Fixable high and critical findings block a run" howTo="The console chart's scanning.enabled" />
      <Part name="Log search" on={install.logs} detail={`The last ${String(install.logSearchDays)} days, in Observe`} howTo={<>{code("logs.enabled")} in vertra.yaml</>} />
      <Part name="The audit log's write-once copy" to="/admin/policies" on={install.auditCopy} detail="Copied to a bucket that refuses deletes" howTo={<>{code("audit.export")} in vertra.yaml (gcp, aws)</>} />
      <Part name="The API gateway" to="/admin/gateway" on={install.gateway} detail="Serving the catalog's API products" howTo={<>{code("gateway.enabled")} in vertra.yaml</>} />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
        Runs are kept {install.runRetentionDays} days. Sign-in and the chat agent&apos;s model are set here; the rest changes with{" "}
        {code("vertra config set")} and {code("vertra apply")}.
      </Typography>
    </Card>
  );
}

interface Step {
  done: boolean;
  title: string;
  how: ReactNode;
}

/**
 * Getting a new install ready: what it needs before teams can run anything
 * (a catalog, an image source, teams, people), and Google sign-in if
 * wanted. Gone once the needed steps are done.
 */
export function FirstRunChecklist() {
  const [steps, setSteps] = useState<Step[] | null>(null);
  useEffect(() => {
    void Promise.allSettled([getCatalogStatus(), getImagePolicy(), listAllTeams(), listUsers(), getInstall()]).then(([catalog, policy, teams, people, install]) => {
      const ok = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
      const c = ok(catalog);
      const p = ok(policy);
      const t = ok(teams);
      const u = ok(people);
      const i = ok(install);
      setSteps([
        {
          done: Boolean(c?.release && c.appliedAt),
          title: "Connect the catalog",
          how: <>Make the repository your teams publish from: {code("vertra catalog create")}. Its first release is pulled within minutes.</>,
        },
        {
          done: Boolean(p && p.allowed.length > 0),
          title: "Allow an image source",
          how: <>The registry your catalog&apos;s CI pushes to: set at install, or in Image sources.</>,
        },
        {
          done: Boolean(t && t.length > 0),
          title: "Have a team",
          how: <>A team folder in the catalog makes one; or create one on the <Link component={RouterLink} to="/teams">Teams</Link> page.</>,
        },
        {
          done: Boolean(u && u.length > 1),
          title: "Add people",
          how: <>On the <Link component={RouterLink} to="/admin/people">People</Link> section, in the teams they work on.</>,
        },
        {
          done: Boolean(i?.ssoProvider),
          title: "Optional: single sign-on",
          how: <>In <Link component={RouterLink} to="/admin/sign-in">Single sign-on and groups</Link> (Google, Entra ID, Okta…), or {code("vertra sso google")}. Passwords keep working.</>,
        },
      ]);
    });
  }, []);

  const needed = steps?.filter((s) => !s.title.startsWith("Optional")) ?? [];
  if (!steps || needed.every((s) => s.done)) return null;
  const done = needed.filter((s) => s.done).length;
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5, borderColor: "info.light" }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Typography variant="h6" component="h2">
          Getting this install ready
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {done} of {needed.length} done
        </Typography>
      </Box>
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1.25 }}>
        {steps.map((step) => (
          <Box component="li" key={step.title} sx={{ display: "flex", gap: 1.5, alignItems: "flex-start" }}>
            {step.done ? <CheckIcon color="success" fontSize="small" sx={{ mt: 0.25 }} aria-label="Done" /> : <TodoIcon color="disabled" fontSize="small" sx={{ mt: 0.25 }} aria-label="Not yet" />}
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 500, color: step.done ? "text.secondary" : "text.primary" }}>
                {step.title}
              </Typography>
              {!step.done && (
                <Typography variant="body2" color="text.secondary">
                  {step.how}
                </Typography>
              )}
            </Box>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary">
        The whole of it is in the guide{" "}
        <Link component={RouterLink} to="/docs/reference-setup">
          Set up Vertra
        </Link>
        .
      </Typography>
    </Card>
  );
}
