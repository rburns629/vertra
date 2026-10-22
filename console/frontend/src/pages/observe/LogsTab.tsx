// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { Mono } from "../../components/Mono";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import { Pill, type PillTone } from "../../components/Pill";
import { useAuth } from "../../auth/AuthContext";
import { ApiError, listAllTeams, searchLogs, type LogLineView } from "../../api";

const LEVEL: Record<string, PillTone> = { debug: "neutral", info: "info", warn: "warning", error: "error" };
const RANGES: [number, string][] = [
  [1, "Last hour"],
  [6, "Last 6 hours"],
  [24, "Last 24 hours"],
  [168, "Last 7 days"],
  [720, "Last 30 days"],
];

export function LogsTab({ initialRun }: { initialRun: string }) {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [team, setTeam] = useState("");
  const [run, setRun] = useState(initialRun);
  const [level, setLevel] = useState("");
  const [platform, setPlatform] = useState(false);
  const [hours, setHours] = useState(initialRun ? 168 : 1);
  const [teams, setTeams] = useState<string[]>([]);
  const [lines, setLines] = useState<LogLineView[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searchDays, setSearchDays] = useState(30);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (!user.isAdmin) {
      setTeams(user.teamNames);
      return;
    }
    listAllTeams()
      .then((all) => {
        setTeams(all.map((t) => t.name).sort());
      })
      .catch(() => {
        setTeams([]);
      });
  }, [user]);

  async function search(): Promise<void> {
    setSearching(true);
    setError(null);
    try {
      const found = await searchLogs({
        text: text.trim(),
        team: platform ? "" : team,
        executionId: platform ? "" : run.trim(),
        level,
        source: platform ? "platform" : "step",
        hours,
      });
      setLines(found.lines);
      setTruncated(found.truncated);
      setSearchDays(found.searchDays);
    } catch (err) {
      if (err instanceof ApiError && err.code === "LOGS_OFF") setOff(true);
      else setError(err instanceof ApiError ? err.message : "Failed to search the logs.");
    } finally {
      setSearching(false);
    }
  }

  // The first search, as the page opens (a run's, when it came from one).
  useEffect(() => {
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (off) {
    return (
      <Alert severity="info">
        This install doesn&apos;t keep logs, so there&apos;s nothing to search. Each run&apos;s page still shows its steps&apos; output. An admin can
        turn log search on (the console chart&apos;s <Mono>logs.enabled</Mono>).
      </Alert>
    );
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" component="h2">
          Search the logs
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {user?.isAdmin
            ? `Every step's output, and the platform's own. Credentials are redacted before anything is kept. Searchable for ${String(searchDays)} days, then archived.`
            : `Every line from your teams' steps, and the INFO lines of other runs you can see. Credentials are redacted before anything is kept. Searchable for ${String(searchDays)} days, then archived.`}
        </Typography>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
          sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center", mb: 2 }}
        >
          <TextField
            size="small"
            placeholder="Text to find"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            sx={{ flex: "1 1 220px" }}
            slotProps={{ htmlInput: { "aria-label": "Text to find", maxLength: 200 } }}
          />
          {!platform && (
            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="logs-team-label">Team</InputLabel>
              <Select
                labelId="logs-team-label"
                label="Team"
                value={team}
                onChange={(event) => {
                  setTeam(event.target.value);
                }}
              >
                <MenuItem value="">Any</MenuItem>
                {teams.map((name) => (
                  <MenuItem key={name} value={name}>
                    {name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
          {!platform && (
            <TextField
              size="small"
              placeholder="Run id"
              value={run}
              onChange={(event) => {
                setRun(event.target.value);
              }}
              sx={{ width: 300 }}
              slotProps={{ htmlInput: { "aria-label": "Run id" } }}
            />
          )}
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel id="logs-level-label">Level</InputLabel>
            <Select
              labelId="logs-level-label"
              label="Level"
              value={level}
              onChange={(event) => {
                setLevel(event.target.value);
              }}
            >
              <MenuItem value="">Any</MenuItem>
              {Object.keys(LEVEL).map((name) => (
                <MenuItem key={name} value={name}>
                  {name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel id="logs-range-label">When</InputLabel>
            <Select
              labelId="logs-range-label"
              label="When"
              value={hours}
              onChange={(event) => {
                setHours(Number(event.target.value));
              }}
            >
              {RANGES.filter(([h]) => h <= searchDays * 24).map(([h, label]) => (
                <MenuItem key={h} value={h}>
                  {label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {user?.isAdmin && (
            <FormControlLabel
              control={
                <Switch
                  checked={platform}
                  onChange={(event) => {
                    setPlatform(event.target.checked);
                  }}
                />
              }
              label="The platform's own"
            />
          )}
          <Button type="submit" variant="contained" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </Button>
        </Box>
        {truncated && (
          <Alert severity="info" sx={{ mb: 2 }}>
            Only the newest {lines?.length ?? 0} lines are shown. Narrow the search to see the rest.
          </Alert>
        )}
        {lines === null ? (
          <Typography color="text.secondary">Searching…</Typography>
        ) : lines.length === 0 ? (
          <Typography color="text.secondary">Nothing found.</Typography>
        ) : (
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, overflowX: "auto" }}>
            {lines.map((l, i) => (
              <Box
                key={`${l.at ?? ""}/${String(i)}`}
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", md: "170px 64px 220px 1fr" },
                  gap: 1,
                  px: 1.5,
                  py: 0.75,
                  borderTop: i === 0 ? 0 : 1,
                  borderColor: "divider",
                  alignItems: "start",
                }}
              >
                <Typography variant="caption" color="text.secondary">
                  {l.at ? new Date(l.at).toLocaleString() : ""}
                </Typography>
                <Box>
                  <Pill tone={LEVEL[l.level] ?? "neutral"}>{l.level}</Pill>
                </Box>
                <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                  {l.executionId ? (
                    <>
                      {l.team} · {l.task}
                      {l.attempt > 1 ? ` (attempt ${String(l.attempt)})` : ""} ·{" "}
                      <Link component={RouterLink} to={`/runs/${l.executionId}`}>
                        {l.executionId.slice(0, 8)}
                      </Link>
                    </>
                  ) : (
                    l.app || "platform"
                  )}
                </Typography>
                <Box component="pre" sx={{ m: 0, fontFamily: "monospace", fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {l.line}
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
