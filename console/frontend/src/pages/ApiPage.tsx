// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";
import { Link as RouterLink, useParams, useSearchParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import { ApiError, getApi, pauseApi, resumeApi, type ApiProduct } from "../api";
import { useAuth } from "../auth/AuthContext";
import { Pill } from "../components/Pill";
import { ApiDefinition } from "./api/ApiDefinition";
import { ApiOverview } from "./api/ApiOverview";
import { ApiStatePill } from "./api/ApiStatePill";
import { ApiTraffic } from "./api/ApiTraffic";

type TabId = "overview" | "traffic" | "definition";

/**
 * One API product (ApiService.GetApi). Overview for anyone who may see it:
 * its endpoints and how to call them. Traffic and Definition for its own
 * team and admins, the only ones the console shows its backend to; its
 * maintainers pause it there. The tab is in the address (?tab=traffic).
 */
export function ApiPage() {
  const { team = "", name = "" } = useParams();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [api, setApi] = useState<ApiProduct | null>(null);
  const [openapi, setOpenapi] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    getApi(team, name)
      .then((result) => {
        setApi(result.api);
        setOpenapi(result.openapi);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load the API.");
      });
  }, [team, name]);

  useEffect(load, [load]);

  const ownTeam = Boolean(api?.backendUrl);
  const maintains = !!user && (user.isAdmin || user.maintainerOf.includes(team));
  const inTeam = user?.teamNames.includes(team) ?? false;
  const requested = params.get("tab");
  const tab: TabId = ownTeam && (requested === "traffic" || requested === "definition") ? requested : "overview";
  const setTab = (next: TabId) => { setParams(next === "overview" ? {} : { tab: next }, { replace: true }); };

  async function change(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/apis">
          APIs
        </Link>{" "}
        / {team} / {api?.displayName ?? name}
      </Typography>
      {error && (
        <Alert severity="error" sx={{ my: 2 }}>
          {error}
        </Alert>
      )}
      {!api && !error && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
          <CircularProgress size={28} aria-label="Loading the API" />
        </Box>
      )}
      {api && (
        <>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1.25, mt: 0.75, mb: 0.5 }}>
            <Typography variant="h4" component="h1" sx={{ overflowWrap: "anywhere" }}>
              {api.displayName}
            </Typography>
            <ApiStatePill state={api.state} />
            <Pill tone={api.internet ? "info" : "neutral"}>{api.internet ? "Internet" : "In the cluster"}</Pill>
            {ownTeam && (
              <Pill tone="neutral">{!inTeam ? "Viewing as admin" : user?.maintainerOf.includes(team) ? "You maintain it" : "Your team's"}</Pill>
            )}
          </Box>
          {api.description && (
            <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 840, mb: 2 }}>
              {api.description}
            </Typography>
          )}

          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, mb: 2 }}>
            {api.state === "PAUSED" && (
              <Alert severity="warning">Paused by its team: every request gets 503 with “{api.pausedMessage}”, and nothing reaches the backend.</Alert>
            )}
            {api.state === "HELD" && <Alert severity="warning">Held: {api.heldReason}</Alert>}
            {api.deprecated && <Alert severity="info">Deprecated: {api.deprecated}</Alert>}
            {!api.mayCall && (
              <Alert severity="info">
                It isn&apos;t shared with your teams: the gateway refuses your calls (403). Its team decides who may call it, in its api.yaml.
              </Alert>
            )}
          </Box>

          {ownTeam && (
            <Tabs value={tab} onChange={(_e, value: TabId) => { setTab(value); }} sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}>
              <Tab value="overview" label="Overview" />
              <Tab value="traffic" label="Traffic" />
              <Tab value="definition" label="Definition" />
            </Tabs>
          )}
          {tab === "overview" && <ApiOverview key={`${team}/${name}`} api={api} openapi={openapi} />}
          {tab === "traffic" && <ApiTraffic team={team} name={name} />}
          {tab === "definition" && (
            <ApiDefinition
              api={api}
              canPause={maintains}
              busy={busy}
              onPause={(message) => change(() => pauseApi(team, name, message))}
              onResume={() => change(() => resumeApi(team, name))}
            />
          )}
        </>
      )}
    </Box>
  );
}
