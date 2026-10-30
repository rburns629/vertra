// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CardContent, Checkbox, Chip, FormControlLabel, Stack, TextField, Typography } from "@mui/material";
import { createBot, listBotIdentities, listBots, revokeToken, setBotCallback, setBotOrders, type Bot, type BotIdentity } from "../../api";
import { KeylessSection } from "./KeylessSection";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { CodeBlock } from "../../components/CodeBlock";
import { TabIntro, errorMessage, relativeTime } from "./shared";
import { Mono } from "../../components/Mono";
import { SignedCallback } from "../../components/SignedCallback";
import { DEFAULT_TOKEN_DAYS, expiryText, TokenLifetime } from "../../components/TokenLifetime";

/** Templates as typed: <team>/<name>, one per line or comma-separated. */
function templateList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean))];
}

/** What an ordering bot may order, editable by the team's maintainers. */
function OrderTemplates({ teamName, bot, readOnly, onSaved }: { teamName: string; bot: Bot; readOnly: boolean; onSaved: () => void }) {
  const [text, setText] = useState(bot.orderTemplates.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = templateList(text).join("\n") !== bot.orderTemplates.join("\n");
  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await setBotOrders(teamName, bot.email, templateList(text));
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save its templates. Try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack spacing={1}>
      <Typography variant="body2">
        Places orders: it may run only these templates, for {teamName}, and nothing else.
      </Typography>
      {readOnly ? (
        <Typography variant="body2" color="text.secondary">
          {bot.orderTemplates.length > 0 ? bot.orderTemplates.join(", ") : "None yet: it can't order anything."}
        </Typography>
      ) : (
        <>
          <TextField
            label="Templates it may order"
            size="small"
            multiline
            minRows={2}
            value={text}
            onChange={(e) => { setText(e.target.value); }}
            helperText="<team>/<name>, one per line, as the Catalog shows them."
          />
          <Button size="small" variant="outlined" disabled={busy || !changed} onClick={() => void save()} sx={{ alignSelf: "flex-start" }}>
            Save
          </Button>
        </>
      )}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}

/** Where an ordering bot's orders' outcomes are posted, signed. */
function OrderCallback({ teamName, bot, readOnly, onSaved }: { teamName: string; bot: Bot; readOnly: boolean; onSaved: () => void }) {
  return (
    <SignedCallback
      current={bot.callback ? { ...bot.callback, lastError: bot.callback.lastError || null } : null}
      editable={!readOnly}
      none="No callback: whatever placed an order asks how it went."
      save={async (url, rotate) => (await setBotCallback(teamName, bot.email, url, rotate)).signingSecret}
      onSaved={onSaved}
    />
  );
}

/** A bot's email is just its identity here, never mailed: derived from
 * what will use it, so the person creating one only has to say that. */
function botEmail(teamName: string, purpose: string): string {
  const slug = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${teamName}-${slug || "bot"}@bots.vertra.local`;
}

export function AutomationTab({ teamName, readOnly }: { teamName: string; readOnly: boolean }) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ tokenId: string; label: string; email: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [issued, setIssued] = useState<{ email: string; token: string; ordering: boolean } | null>(null);
  const [keyless, setKeyless] = useState<{ identities: BotIdentity[]; issuers: string[]; audience: string } | null>(null);

  const reload = useCallback(() => {
    listBots(teamName)
      .then(setBots)
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load this team's bots."));
      });
    // Display only: without it, bots just don't offer keyless sign-in.
    listBotIdentities(teamName).then(setKeyless).catch(() => undefined);
  }, [teamName]);

  useEffect(reload, [reload]);

  async function revoke(): Promise<void> {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await revokeToken(revoking.tokenId);
      reload();
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't revoke it. Try again."));
    } finally {
      setRevokeBusy(false);
      setRevoking(null);
    }
  }

  const consoleUrl = window.location.origin;

  return (
    <Box>
      <TabIntro>
        Accounts for your own pipelines, for example a GitHub Actions job that submits a DAG after a release. You don't
        need one to publish products: the catalog's own CI already does that.
      </TabIntro>
      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 1.5fr) minmax(0, 1fr)" },
          gap: 2,
          alignItems: "start",
        }}
      >
        <Stack spacing={2}>
          {bots && bots.length === 0 && (
            <Card variant="outlined">
              <CardContent>
                <Typography color="text.secondary">No bots yet.</Typography>
              </CardContent>
            </Card>
          )}
          {(bots ?? []).map((bot) => {
            const keylessOnly = bot.tokens.length === 0 && (keyless?.identities.some((i) => i.botId === bot.id) ?? false);
            return (
            <Card key={bot.id} variant="outlined">
              <CardContent>
                <Stack spacing={1.5}>
                  <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Typography sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                      <Mono>{bot.email}</Mono>
                    </Typography>
                    <Chip
                      label={bot.tokens.length > 0 ? "Active" : keylessOnly ? "Keyless" : "No token"}
                      size="small"
                      color={bot.tokens.length > 0 || keylessOnly ? "success" : "default"}
                      variant="outlined"
                    />
                  </Box>
                  {bot.ordering && <OrderTemplates teamName={teamName} bot={bot} readOnly={readOnly} onSaved={reload} />}
                  {bot.ordering && <OrderCallback teamName={teamName} bot={bot} readOnly={readOnly} onSaved={reload} />}
                  {bot.tokens.length === 0 && !keylessOnly && (
                    <Typography variant="body2" color="text.secondary">
                      No working token. Anything still using an old one fails to sign in.
                    </Typography>
                  )}
                  {keyless && (
                    <KeylessSection
                      teamName={teamName}
                      botId={bot.id}
                      identities={keyless.identities.filter((i) => i.botId === bot.id)}
                      issuers={keyless.issuers}
                      audience={keyless.audience}
                      readOnly={readOnly}
                      onChanged={reload}
                    />
                  )}
                  {bot.tokens.map((token) => (
                    <Box
                      key={token.id}
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 1.5,
                        p: 1.5,
                        bgcolor: "action.hover",
                        borderRadius: 2,
                        flexWrap: "wrap",
                      }}
                    >
                      <Box>
                        <Typography sx={{ fontWeight: 500 }}>{token.label}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          created {relativeTime(token.createdAt)} · last used {relativeTime(token.lastUsedAt)} · {expiryText(token.expiresAt)}
                        </Typography>
                      </Box>
                      {!readOnly && (
                        <Button
                          size="small"
                          color="error"
                          variant="outlined"
                          onClick={() => {
                            setRevoking({ tokenId: token.id, label: token.label, email: bot.email });
                          }}
                        >
                          Revoke
                        </Button>
                      )}
                    </Box>
                  ))}
                </Stack>
              </CardContent>
            </Card>
            );
          })}
          <Card variant="outlined" sx={{ bgcolor: "action.hover" }}>
            <CardContent>
              <Typography sx={{ fontWeight: 600, mb: 0.5 }}>What a bot can do</Typography>
              <Typography variant="body2" color="text.secondary">
                It acts as a maintainer of {teamName}: it can submit and read this team's executions and register secrets, and
                nothing outside {teamName}. An ordering bot is a member instead, and may order only the templates listed for it. Give each pipeline its own bot, so revoking one doesn't break the others.
              </Typography>
            </CardContent>
          </Card>
        </Stack>

        {!readOnly &&
          (issued ? (
            <Card variant="outlined">
              <CardContent>
                <Stack spacing={1.5}>
                  <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
                    Token for {issued.email}
                  </Typography>
                  <Alert severity="warning">
                    <strong>Copy it now.</strong> This is the only time it's shown.
                  </Alert>
                  <CodeBlock code={issued.token} copyLabel="Copy token" />
                  <Typography variant="subtitle2">1. Store it in your pipeline</Typography>
                  <CodeBlock code={"gh secret set VERTRA_TOKEN \\\n  --repo <your-org>/<your-repo>"} />
                  <Typography variant="subtitle2">{issued.ordering ? "2. Place an order from it" : "2. Submit a DAG from it"}</Typography>
                  <CodeBlock
                    code={
                      issued.ordering
                        ? [
                            `curl -X POST ${consoleUrl}/api/vertra.console.v1.TemplateService/RunTemplate \\`,
                            '  -H "Authorization: Bearer $VERTRA_TOKEN" \\',
                            '  -H "Content-Type: application/json" \\',
                            `  -d '{"team": "<team>", "name": "<template>", "onBehalfOf": "${teamName}", "requestId": "<order id>", "parameters": {}}'`,
                          ].join("\n")
                        : [
                            `jq '{dag: .}' dag.json | curl -X POST ${consoleUrl}/api/vertra.console.v1.ExecutionService/SubmitExecution \\`,
                            '  -H "Authorization: Bearer $VERTRA_TOKEN" \\',
                            '  -H "Content-Type: application/json" \\',
                            "  -d @-",
                          ].join("\n")
                    }
                  />
                  <Button
                    variant="contained"
                    sx={{ alignSelf: "flex-start" }}
                    onClick={() => {
                      setIssued(null);
                    }}
                  >
                    Done
                  </Button>
                </Stack>
              </CardContent>
            </Card>
          ) : (
            <AddBot
              teamName={teamName}
              onCreated={(email, token, ordering) => {
                setIssued({ email, token, ordering });
                reload();
              }}
            />
          ))}
      </Box>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke "${revoking?.label ?? ""}"?`}
        description={`${revoking?.email ?? "This bot"}'s token stops working immediately. Any pipeline still using it will fail to sign in.`}
        confirmLabel="Revoke token"
        destructive
        busy={revokeBusy}
        onConfirm={() => void revoke()}
        onCancel={() => {
          setRevoking(null);
        }}
      />
    </Box>
  );
}

function AddBot({ teamName, onCreated }: { teamName: string; onCreated: (email: string, token: string, ordering: boolean) => void }) {
  const [purpose, setPurpose] = useState("");
  const [ordering, setOrdering] = useState(false);
  const [templates, setTemplates] = useState("");
  const [days, setDays] = useState(DEFAULT_TOKEN_DAYS);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await createBot(teamName, botEmail(teamName, purpose), purpose.trim(), ordering ? templateList(templates) : undefined, days);
      setPurpose("");
      setTemplates("");
      onCreated(result.email, result.token, ordering);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the bot. Try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Box component="form" onSubmit={(event: FormEvent) => void submit(event)}>
          <Stack spacing={2}>
            <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 600 }}>
              Add a bot
            </Typography>
            <TextField
              label="What will use it?"
              size="small"
              required
              value={purpose}
              onChange={(event) => {
                setPurpose(event.target.value);
              }}
              placeholder="release pipeline in our infra repo"
              helperText="A pipeline or repo, so you know what breaks if you revoke it. Using the same words again adds another token to the same bot."
            />
            <FormControlLabel
              control={<Checkbox checked={ordering} onChange={(e) => { setOrdering(e.target.checked); }} />}
              label="It places orders (a storefront, or another system): only the templates listed, nothing else"
            />
            {ordering && (
              <TextField
                label="Templates it may order"
                size="small"
                multiline
                minRows={2}
                value={templates}
                onChange={(e) => { setTemplates(e.target.value); }}
                helperText="<team>/<name>, one per line. A member of this team, not a maintainer: it can't submit raw DAGs."
              />
            )}
            <TokenLifetime days={days} onChange={setDays} />
            <Button type="submit" variant="contained" disabled={submitting || !purpose.trim()} sx={{ alignSelf: "flex-start" }}>
              {submitting ? "Creating…" : "Create bot and token"}
            </Button>
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}
