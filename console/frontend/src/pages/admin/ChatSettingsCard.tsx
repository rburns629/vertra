// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Collapse from "@mui/material/Collapse";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, getChatConfig, resetChatConfig, setChatConfig, testChatConfig, type ChatConfig, type ChatConfigInput, type ChatTestResult } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Mono } from "../../components/Mono";
import { Pill } from "../../components/Pill";

const PROVIDERS: { id: string; label: string; model: string }[] = [
  { id: "vertex", label: "Gemini on Vertex AI (Google Cloud)", model: "google/gemini-3.5-flash" },
  { id: "anthropic", label: "Claude through Anthropic's API", model: "claude-haiku-5-5" },
  { id: "openai-compatible", label: "An OpenAI-compatible server (LM Studio, Ollama…)", model: "qwen3-14b" },
];
const nameOf = (provider: string) => PROVIDERS.find((p) => p.id === provider)?.label ?? provider;

/** The form's values from settings as they're set: a key is never among them. */
function formOf(c: ChatConfig): ChatConfigInput {
  return {
    enabled: c.enabled,
    provider: c.provider || "vertex",
    model: c.model,
    endpoint: c.endpoint,
    vertexProject: c.vertexProject,
    vertexLocation: c.vertexLocation || "global",
    effort: c.effort,
    // Left blank, the default; shown only when an admin set one.
    maxSteps: c.source === "admins" ? c.maxSteps : 0,
    contextTokens: c.source === "admins" ? c.contextTokens : 0,
    maxTokens: c.source === "admins" ? c.maxTokens : 0,
    apiKey: "",
  };
}

const whole = (value: string) => (/^\d+$/.test(value) ? Number(value) : 0);

function Field({ children }: { children: ReactNode }) {
  return <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>{children}</Box>;
}

/**
 * The chat agent's model (decision 24): what answers in Ask, set here in
 * place of the install's, or the install's. A key is typed once and kept
 * encrypted; Vertex needs none (it signs in as the console). Test tries the
 * form as it is, before saving it.
 */
export function ChatSettingsCard() {
  const [saved, setSaved] = useState<ChatConfig | null>(null);
  const [form, setForm] = useState<ChatConfigInput | null>(null);
  const [limits, setLimits] = useState(false);
  const [busy, setBusy] = useState<"save" | "test" | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tested, setTested] = useState<ChatTestResult | null>(null);
  const [resetting, setResetting] = useState(false);

  function show(c: ChatConfig): void {
    setSaved(c);
    setForm(formOf(c));
  }

  useEffect(() => {
    getChatConfig()
      .then(show)
      .catch((err: unknown) => { setError(err instanceof ApiError ? err.message : "Couldn't load the chat agent's settings."); });
  }, []);

  if (!saved || !form) {
    return <Card sx={{ p: 3 }}>{error ? <Alert severity="error">{error}</Alert> : <Typography color="text.secondary">Loading…</Typography>}</Card>;
  }
  const set = (patch: Partial<ChatConfigInput>) => {
    setForm({ ...form, ...patch });
    setTested(null);
  };
  const example = PROVIDERS.find((p) => p.id === form.provider)?.model ?? "";
  // A key kept is the provider's: another provider's needs its own.
  const keyKept = saved.keySet && saved.provider === form.provider;

  async function act(what: "save" | "test" | "reset", run: () => Promise<void>, failed: string): Promise<void> {
    setBusy(what);
    setError(null);
    setNotice(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : failed);
    } finally {
      setBusy(null);
    }
  }
  const save = () =>
    act(
      "save",
      async () => {
        show(await setChatConfig(form));
        setNotice(form.enabled ? "Saved: in effect within seconds." : "Saved: the chat agent is off.");
      },
      "Couldn't save them.",
    );
  const test = () => act("test", async () => { setTested(await testChatConfig({ ...form, enabled: true })); }, "Couldn't try them.");
  const reset = () =>
    act(
      "reset",
      async () => {
        show(await resetChatConfig());
        setResetting(false);
        setNotice("The install's settings are in effect again.");
      },
      "Couldn't go back to the install's.",
    );

  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
        <Typography variant="h6" component="h2">
          Chat agent
        </Typography>
        {saved.enabled && !saved.problem ? <Pill tone="success">On · {saved.model}</Pill> : <Pill tone="neutral">Off</Pill>}
      </Box>
      <Typography variant="body2" color="text.secondary">
        The model that answers in Ask: questions from the docs, and carts from the catalog.{" "}
        {saved.source === "install"
          ? saved.installModel
            ? `These are the install's settings (${nameOf(saved.installProvider)}). Saving your own replaces them until you go back.`
            : "The install sets no model: choose one here."
          : `Set here${saved.updatedBy ? ` by ${saved.updatedBy}` : ""}${saved.updatedAt ? `, ${new Date(saved.updatedAt).toLocaleString()}` : ""}${saved.installModel ? `, in place of the install's (${saved.installModel})` : ""}.`}
      </Typography>
      {saved.problem && (
        <Alert severity="error">
          These settings can&apos;t be used, so the chat agent is off: {saved.problem}
        </Alert>
      )}

      <FormControlLabel control={<Switch checked={form.enabled} onChange={(e) => { set({ enabled: e.target.checked }); }} />} label="People may ask the chat agent" />
      <Field>
        <TextField select size="small" label="Provider" value={form.provider} onChange={(e) => { set({ provider: e.target.value, model: "" }); }}>
          {PROVIDERS.map((p) => (
            <MenuItem key={p.id} value={p.id}>
              {p.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="Model"
          value={form.model}
          placeholder={example}
          onChange={(e) => { set({ model: e.target.value }); }}
          helperText={form.provider === "vertex" ? "Empty: Gemini 3.5 Flash, the one scored" : `Its name there, such as ${example}`}
        />
        {form.provider === "vertex" && (
          <>
            <TextField size="small" label="Google Cloud project" value={form.vertexProject} onChange={(e) => { set({ vertexProject: e.target.value }); }} helperText="Whose Vertex AI answers" />
            <TextField size="small" label="Location" value={form.vertexLocation} onChange={(e) => { set({ vertexLocation: e.target.value }); }} helperText="global, or a region to keep requests in it" />
          </>
        )}
        {form.provider !== "vertex" && (
          <>
            <TextField
              size="small"
              label={form.provider === "anthropic" ? "Address (optional)" : "Server's address"}
              value={form.endpoint}
              placeholder={form.provider === "anthropic" ? "Anthropic's own" : "http://host:1234/v1"}
              onChange={(e) => { set({ endpoint: e.target.value }); }}
              helperText={form.provider === "anthropic" ? "Empty for Anthropic's API" : "Its base URL, ending /v1"}
            />
            <TextField
              size="small"
              type="password"
              label={form.provider === "anthropic" ? "API key" : "API key (optional)"}
              value={form.apiKey}
              onChange={(e) => { set({ apiKey: e.target.value }); }}
              autoComplete="new-password"
              helperText={keyKept ? "One is kept (encrypted, never shown): type to replace it" : "Kept encrypted, never shown again"}
            />
          </>
        )}
      </Field>
      {form.provider === "vertex" && (
        <Typography variant="caption" color="text.secondary">
          No key: the console signs in as its own Google identity, which needs <Mono>roles/aiplatform.user</Mono> in this project
          (<Mono>vertra apply</Mono> grants it on GCP).
        </Typography>
      )}

      <Box>
        <Button size="small" onClick={() => { setLimits(!limits); }}>
          {limits ? "Hide limits" : "Limits"}
        </Button>
        <Collapse in={limits}>
          <Field>
            <TextField select size="small" label="Thinking" value={form.effort} onChange={(e) => { set({ effort: e.target.value }); }} sx={{ mt: 1 }}>
              <MenuItem value="">The model&apos;s own</MenuItem>
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
            </TextField>
            <TextField size="small" label="Steps per answer" value={form.maxSteps || ""} placeholder="8" onChange={(e) => { set({ maxSteps: whole(e.target.value) }); }} sx={{ mt: 1 }} />
            <TextField
              size="small"
              label="Context window (tokens)"
              value={form.contextTokens || ""}
              placeholder={form.provider === "openai-compatible" ? "16000" : "64000"}
              onChange={(e) => { set({ contextTokens: whole(e.target.value) }); }}
              helperText="What one call may be sent: it bounds each answer's cost"
            />
            <TextField
              size="small"
              label="Reply length (tokens)"
              value={form.maxTokens || ""}
              placeholder={form.provider === "openai-compatible" ? "1500" : "8000"}
              onChange={(e) => { set({ maxTokens: whole(e.target.value) }); }}
              helperText="Thinking counts toward it"
            />
          </Field>
        </Collapse>
      </Box>

      {tested &&
        (tested.ok ? (
          <Alert severity="success">
            {tested.model} answered in {tested.seconds} s{tested.citations > 0 ? `, citing ${String(tested.citations)} section${tested.citations === 1 ? "" : "s"}` : ""}: &ldquo;
            {tested.answer.length > 200 ? `${tested.answer.slice(0, 200)}…` : tested.answer}&rdquo;
          </Alert>
        ) : (
          <Alert severity="error">
            {tested.model} didn&apos;t answer: {tested.problem}
          </Alert>
        ))}
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}

      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Button variant="contained" disabled={busy !== null} onClick={() => { void save(); }}>
          {busy === "save" ? "Saving…" : "Save"}
        </Button>
        <Button variant="outlined" disabled={busy !== null} onClick={() => { void test(); }}>
          {busy === "test" ? "Asking it…" : "Test"}
        </Button>
        {saved.source === "admins" && (
          <Button disabled={busy !== null} onClick={() => { setResetting(true); }}>
            Use the install&apos;s
          </Button>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Test asks it one question through the agent, as you, before you save. Score another model before relying on it (
        <Mono>npm run chat-eval</Mono>).
      </Typography>

      <ConfirmDialog
        open={resetting}
        title="Go back to the install's settings?"
        description={saved.installModel ? `The install's (${saved.installModel}) answer again; these, and their key, are forgotten.` : "The install sets no model: the chat agent will be off. These, and their key, are forgotten."}
        confirmLabel="Go back"
        busy={busy === "reset"}
        onConfirm={() => { void reset(); }}
        onCancel={() => { setResetting(false); }}
      />
    </Card>
  );
}
