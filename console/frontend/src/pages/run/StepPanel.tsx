// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import { dump as dumpYaml } from "js-yaml";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Link from "@mui/material/Link";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";
import type { ExecutionEvent, FailureHelp, SubmittedExecutionPayload, SubmittedTaskPayload, TaskAttempt, TaskLogs, TaskStatus } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { imageName } from "../../imageRef";
import { duration, when } from "../../time";
import { Approval } from "./Approval";
import { RETRY } from "./FailureHelp";
import { StepLogs } from "./StepLogs";

type TabId = "attempts" | "outputs" | "inputs" | "logs" | "definition";

const TRIGGER: Record<string, string> = {
  submitted: "started by",
  retried: "retried by",
  automatic_retry: "retried automatically",
};

const mono = { fontFamily: "fontFamilyMono", fontSize: 13 } as const;

/** One step's definition as it was submitted, in the shape a DAG file uses. */
function definitionYaml(payload: SubmittedExecutionPayload, task: SubmittedTaskPayload): string {
  const { id, image, action, dependsOn, team, serviceAccount, secretRefs, inputs, timeoutSeconds, maxAttempts } = task;
  const entry = {
    id,
    image,
    action,
    ...(dependsOn?.length ? { dependsOn } : {}),
    team,
    ...(serviceAccount !== undefined ? { serviceAccount } : {}),
    ...(secretRefs?.length ? { secretRefs } : {}),
    ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  };
  // lineWidth -1: a long input stays on its line.
  return dumpYaml({ name: payload.name, tasks: [entry] }, { indent: 2, lineWidth: -1 });
}

/** A value as text: an input from another step says which. */
function valueOf(value: unknown): ReactNode {
  if (value && typeof value === "object" && "$fromTask" in value) {
    const ref = value as { $fromTask: string; $output: string };
    return (
      <Box component="span" sx={{ color: "text.secondary" }}>
        from step {ref.$fromTask} → {ref.$output}
      </Box>
    );
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function KeyValues({ values, empty }: { values: Record<string, unknown> | null | undefined; empty: string }) {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return <Typography color="text.secondary">{empty}</Typography>;
  return (
    <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "minmax(80px, auto) minmax(0, 1fr)", columnGap: 2, rowGap: 0.75 }}>
      {entries.map(([key, value]) => (
        <Box key={key} sx={{ display: "contents" }}>
          <Box component="dt" sx={{ ...mono, fontSize: 12, color: "text.secondary" }}>
            {key}
          </Box>
          <Box component="dd" sx={{ ...mono, fontSize: 12, m: 0, overflowWrap: "anywhere" }}>
            {valueOf(value)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * One attempt as a tinted box: how it went and for how long, when, who asked
 * for it, its failure, and, once retried, when and by whom.
 */
function Attempt({ attempt, next, help, now }: { attempt: TaskAttempt; next: TaskAttempt | undefined; help: FailureHelp | null; now: number }) {
  const theme = useTheme();
  const started = attempt.startedAt ? Date.parse(attempt.startedAt) : null;
  const ended = attempt.completedAt ? Date.parse(attempt.completedAt) : null;
  const how = attempt.failure ? "failed" : ended ? "succeeded" : started ? "running" : "waiting to start";
  const tone = attempt.failure ? (next ? theme.palette.warning.main : theme.palette.error.main) : ended ? theme.palette.success.main : started ? theme.palette.primary.main : theme.palette.grey[500];
  const retried = next && [TRIGGER[next.trigger] ?? next.trigger, next.requestedBy].filter(Boolean).join(" ");
  const gap = next?.startedAt && ended !== null ? ` after ${duration(Date.parse(next.startedAt) - ended)}` : "";
  return (
    <Box
      component="li"
      sx={{ display: "flex", flexDirection: "column", gap: 0.75, px: 2, py: 1.75, borderRadius: 2, border: 1, borderColor: alpha(tone, 0.35), bgcolor: alpha(tone, 0.05) }}
    >
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 1 }}>
        <Typography component="span" sx={{ fontSize: 14, fontWeight: 600 }}>
          Attempt {attempt.number} · {how}
          {started !== null && ` ${ended ? "after" : "for"} ${duration((ended ?? now) - started)}`}
        </Typography>
        <Typography component="span" sx={{ fontSize: 13, color: "text.secondary" }}>
          {retried
            ? `${retried}${gap}`
            : attempt.startedAt && attempt.completedAt
              ? `${clock(attempt.startedAt)} to ${clock(attempt.completedAt)}`
              : attempt.startedAt
                ? `since ${clock(attempt.startedAt)}`
                : ""}
        </Typography>
      </Box>
      <Typography component="span" sx={{ fontSize: 13, color: "text.secondary" }}>
        {[[TRIGGER[attempt.trigger] ?? attempt.trigger, attempt.requestedBy].filter(Boolean).join(" "), attempt.startedAt ? when(attempt.startedAt) : ""].filter(Boolean).join(", ")}
      </Typography>
      {attempt.failure && (
        <Typography component="span" sx={{ ...mono, color: "text.primary", overflowWrap: "anywhere" }}>
          <Box component="span" sx={{ fontWeight: 600, color: next ? "warning.dark" : "error.main" }}>
            {attempt.failure.code}
          </Box>{" "}
          · {attempt.failure.message}
          {!attempt.failure.retryable && " (not retryable)"}
        </Typography>
      )}
      {attempt.failure && help && RETRY[help.retry] && (
        <Typography component="span" sx={{ fontSize: 13, color: "text.secondary" }}>
          Safe to retry? {RETRY[help.retry]}
        </Typography>
      )}
    </Box>
  );
}

/**
 * The selected step: its approval, if it needs one; its attempts (and, once
 * it succeeded, its outputs), outputs, inputs, logs and definition.
 */
export function StepPanel({
  executionId,
  task,
  definition,
  payload,
  logs,
  events,
  now,
  busy,
  retryBlocked,
  onRetry,
  onDecide,
}: {
  executionId: string;
  task: TaskStatus;
  definition: SubmittedTaskPayload | undefined;
  payload: SubmittedExecutionPayload | null;
  logs: TaskLogs | undefined;
  events: ExecutionEvent[];
  now: number;
  busy: boolean;
  retryBlocked: string | null;
  onRetry: () => void;
  onDecide: (approve: boolean, reason: string) => void;
}) {
  const [tab, setTab] = useState<TabId>("attempts");
  const hasOutputs = Object.keys(task.outputs ?? {}).length > 0;

  return (
    <Card component="section" id="step" aria-labelledby="step-heading" sx={{ minWidth: 0, p: { xs: 2, sm: 3 }, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 1.5 }}>
        <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
            <Typography id="step-heading" variant="h6" component="h2" sx={{ fontSize: 18, overflowWrap: "anywhere" }}>
              {task.taskId}
            </Typography>
            <StatusBadge status={task.state} />
          </Box>
          {definition && (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
              {imageName(definition.image)} · {definition.action} · {definition.team}
            </Typography>
          )}
        </Box>
        {task.state === "FAILED" && (
          <Tooltip title={retryBlocked ?? ""}>
            {/* A disabled button fires no events, so the tooltip needs a wrapper. */}
            <span>
              <Button variant="outlined" disabled={busy || retryBlocked !== null} onClick={onRetry}>
                {busy ? "Retrying…" : "Retry this step"}
              </Button>
            </span>
          </Tooltip>
        )}
      </Box>

      {task.waitingFor && (
        <Alert severity="info">
          Waiting its turn: another run is changing the same{" "}
          {Object.entries(task.waitingFor)
            .map(([name, value]) => `${name} (${typeof value === "string" ? value : JSON.stringify(value)})`)
            .join(", ")}
          . It starts when that one finishes.
        </Alert>
      )}
      {task.waitingForCap && (
        <Alert severity="info">
          Waiting its turn: its product already has as many steps running as it allows at once (its maxRunning). It starts
          when one of them finishes.
        </Alert>
      )}
      {task.approval && <Approval executionId={executionId} taskId={task.taskId} approval={task.approval} awaiting={task.state === "AWAITING_APPROVAL"} busy={busy} onDecide={onDecide} />}

      <Tabs value={tab} onChange={(_, value: TabId) => { setTab(value); }} aria-label="Step views" variant="scrollable" allowScrollButtonsMobile>
        <Tab value="attempts" label="Attempts" />
        <Tab value="outputs" label="Outputs" />
        <Tab value="inputs" label="Inputs" />
        <Tab value="logs" label="Logs" />
        <Tab value="definition" label="Definition" />
      </Tabs>

      {tab === "attempts" &&
        (task.attempts.length > 0 ? (
          <>
            <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1.5 }}>
              {task.attempts.map((a, i) => (
                <Attempt key={a.number} attempt={a} next={task.attempts[i + 1]} help={task.help} now={now} />
              ))}
            </Box>
            {task.state === "SUCCEEDED" && hasOutputs && (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 1, pt: 1.75, borderTop: 1, borderColor: "divider" }}>
                <Typography component="h3" sx={{ fontSize: 13, fontWeight: 600 }}>
                  Outputs
                </Typography>
                <KeyValues values={task.outputs} empty="" />
              </Box>
            )}
          </>
        ) : (
          <Typography color="text.secondary">
            {task.dependsOn.length > 0 ? `Waits for ${task.dependsOn.join(", ")}.` : "Not started yet."}
          </Typography>
        ))}
      {tab === "outputs" && <KeyValues values={task.outputs} empty="No outputs yet: a step reports them when it finishes." />}
      {tab === "inputs" && <KeyValues values={definition?.inputs} empty="It takes no inputs." />}
      {tab === "logs" && <StepLogs taskId={task.taskId} logs={logs} events={events} />}
      {tab === "definition" &&
        (payload && definition ? (
          <Box component="pre" tabIndex={0} sx={{ ...mono, m: 0, p: 2, borderRadius: 2, bgcolor: "code.background", color: "code.text", overflowX: "auto" }}>
            {definitionYaml(payload, definition)}
          </Box>
        ) : (
          <Typography color="text.secondary">This run predates stored submissions, so its definition isn&apos;t kept.</Typography>
        ))}

      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
        {logs && logs.hidden > 0 && `You see this step's INFO lines, its status, errors and outputs; ${logs.visibleTo} sees every line. `}
        <Link component={RouterLink} to={`/observe?tab=logs&run=${encodeURIComponent(executionId)}`}>
          Search its logs in Observe
        </Link>
      </Typography>
    </Card>
  );
}
