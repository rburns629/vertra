// SPDX-License-Identifier: MIT
import { useState, type ReactNode } from "react";
import { dump as dumpYaml } from "js-yaml";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { ExecutionEvent, SubmittedExecutionPayload, SubmittedTaskPayload, TaskAttempt, TaskLogs, TaskStatus } from "../../api";
import { StatusBadge } from "../../components/StatusBadge";
import { imageName } from "../../imageRef";
import { duration, when } from "../../time";
import { Approval } from "./Approval";
import { StepLogs } from "./StepLogs";

type TabId = "attempts" | "outputs" | "inputs" | "logs" | "definition";

const TRIGGER: Record<string, string> = {
  submitted: "started by",
  retried: "retried by",
  automatic_retry: "retried automatically",
};

const mono = { fontFamily: "fontFamilyMono", fontSize: 13 } as const;

/** repo:tag@sha256:1a2b3c4d5e6f…: the digest cut short (the whole of it on hover). */
function shortImage(image: string): string {
  return image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, "@sha256:$1…");
}

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
    <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "minmax(120px, auto) 1fr", columnGap: 3, rowGap: 1 }}>
      {entries.map(([key, value]) => (
        <Box key={key} sx={{ display: "contents" }}>
          <Box component="dt" sx={{ ...mono, color: "text.secondary" }}>
            {key}
          </Box>
          <Box component="dd" sx={{ ...mono, m: 0, overflowWrap: "anywhere" }}>
            {valueOf(value)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function Attempt({ attempt, now }: { attempt: TaskAttempt; now: number }) {
  const started = attempt.startedAt ? Date.parse(attempt.startedAt) : null;
  const ended = attempt.completedAt ? Date.parse(attempt.completedAt) : null;
  const how = attempt.failure ? "failed" : ended ? "succeeded" : started ? "running" : "waiting to start";
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, py: 1.5, borderTop: 1, borderColor: "divider", "&:first-of-type": { borderTop: 0, pt: 0 } }}>
      <Typography sx={{ fontWeight: 500 }}>
        Attempt {attempt.number} · {how}
        {started !== null && ` ${ended ? "after" : "for"} ${duration((ended ?? now) - started)}`}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {[
          [TRIGGER[attempt.trigger] ?? attempt.trigger, attempt.requestedBy].filter(Boolean).join(" "),
          attempt.startedAt ? when(attempt.startedAt) : "",
        ]
          .filter(Boolean)
          .join(", ")}
      </Typography>
      {attempt.failure && (
        <Typography variant="body2">
          <Box component="span" sx={{ ...mono, fontWeight: 600, color: "error.main" }}>
            {attempt.failure.code}
          </Box>{" "}
          · {attempt.failure.message}
          {!attempt.failure.retryable && " (not retryable)"}
        </Typography>
      )}
    </Box>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography component="div" variant="body2" sx={{ overflowWrap: "anywhere" }}>
        {children}
      </Typography>
    </Box>
  );
}

/**
 * The selected step: its approval, if it needs one; its attempts, outputs,
 * inputs, logs and definition; and who acted in it.
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
  const last = task.attempts.at(-1);

  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3, alignItems: "flex-start" }}>
      <Card sx={{ flex: "3 1 520px", minWidth: 0, p: 3, display: "flex", flexDirection: "column", gap: 2 }}>
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
              <Typography variant="h6" component="h2">
                {task.taskId}
              </Typography>
              <StatusBadge status={task.state} />
            </Box>
            {definition && (
              <Typography variant="body2" color="text.secondary">
                {imageName(definition.image)} · {definition.action} · {definition.team}
              </Typography>
            )}
          </Box>
          {task.state === "FAILED" && (
            <Tooltip title={retryBlocked ?? ""}>
              {/* A disabled button fires no events, so the tooltip needs a wrapper. */}
              <span>
                <Button variant="contained" disabled={busy || retryBlocked !== null} onClick={onRetry}>
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
        {task.approval && <Approval executionId={executionId} taskId={task.taskId} approval={task.approval} awaiting={task.state === "AWAITING_APPROVAL"} busy={busy} onDecide={onDecide} />}

        <Tabs value={tab} onChange={(_, value: TabId) => { setTab(value); }} variant="scrollable" allowScrollButtonsMobile sx={{ borderBottom: 1, borderColor: "divider", minHeight: 40 }}>
          <Tab value="attempts" label="Attempts" />
          <Tab value="outputs" label="Outputs" />
          <Tab value="inputs" label="Inputs" />
          <Tab value="logs" label="Logs" />
          <Tab value="definition" label="Definition" />
        </Tabs>

        {tab === "attempts" &&
          (task.attempts.length > 0 ? (
            <Box>
              {[...task.attempts].reverse().map((a) => (
                <Attempt key={a.number} attempt={a} now={now} />
              ))}
            </Box>
          ) : (
            <Typography color="text.secondary">
              {task.dependsOn.length > 0 ? `Waits for ${task.dependsOn.join(", ")}.` : "Not started yet."}
            </Typography>
          ))}
        {tab === "outputs" && <KeyValues values={task.outputs} empty="No outputs yet: a step reports them when it finishes." />}
        {tab === "inputs" && <KeyValues values={definition?.inputs} empty="It takes no inputs." />}
        {tab === "logs" && <StepLogs executionId={executionId} taskId={task.taskId} logs={logs} events={events} />}
        {tab === "definition" &&
          (payload && definition ? (
            <Box component="pre" tabIndex={0} sx={{ ...mono, m: 0, p: 2, borderRadius: 2, bgcolor: "code.background", color: "code.text", overflowX: "auto" }}>
              {definitionYaml(payload, definition)}
            </Box>
          ) : (
            <Typography color="text.secondary">This run predates stored submissions, so its definition isn't kept.</Typography>
          ))}
      </Card>

      <Card component="aside" sx={{ flex: "1 1 260px", minWidth: 0, p: 3, display: "flex", flexDirection: "column", gap: 1.75 }}>
        <Typography variant="h6" component="h3">
          Who acted
        </Typography>
        <Fact label="Asked for by">
          {last?.requestedBy || (last?.trigger === "automatic_retry" ? "the scheduler, retrying automatically" : "—")}
        </Fact>
        <Fact label="Ran as">
          <Box component="span" sx={mono}>
            {last?.actedAs || (definition ? `${definition.team}/${definition.serviceAccount ?? "default"}` : "—")}
          </Box>
        </Fact>
        {definition && (
          <Fact label="Image">
            <Box component="span" sx={mono} title={last?.image || definition.image}>
              {shortImage(last?.image || definition.image)}
            </Box>
          </Fact>
        )}
        {definition?.secretRefs && definition.secretRefs.length > 0 && (
          <Fact label="Secrets mounted">
            <Box component="span" sx={mono}>
              {definition.secretRefs.join(", ")}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Names only: values are never shown.
            </Typography>
          </Fact>
        )}
      </Card>
    </Box>
  );
}
