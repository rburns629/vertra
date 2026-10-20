// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Stack, TextField, Typography } from "@mui/material";
import { createBot, listBots, revokeToken, type Bot } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {CodeBlock, TabIntro, errorMessage, relativeTime } from "./shared";
import { Mono } from "../../components/Mono";

/** A bot's email is just its identity here, never mailed: derived from
 * what will use it, so the person creating one only has to say that. */
function botEmail(teamName: string, purpose: string): string {
  const slug = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${teamName}-${slug || "bot"}@bots.acyclix.local`;
}

export function AutomationTab({ teamName, readOnly }: { teamName: string; readOnly: boolean }) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ tokenId: string; label: string; email: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);

  const reload = useCallback(() => {
    listBots(teamName)
      .then(setBots)
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load this team's bots."));
      });
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
          {(bots ?? []).map((bot) => (
            <Card key={bot.id} variant="outlined">
              <CardContent>
                <Stack spacing={1.5}>
                  <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                    <Typography sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                      <Mono>{bot.email}</Mono>
                    </Typography>
                    <Chip
                      label={bot.tokens.length > 0 ? "Active" : "No token"}
                      size="small"
                      color={bot.tokens.length > 0 ? "success" : "default"}
                      variant="outlined"
                    />
                  </Box>
                  {bot.tokens.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No working token. Anything still using an old one fails to sign in.
                    </Typography>
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
                          created {relativeTime(token.createdAt)} · last used {relativeTime(token.lastUsedAt)}
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
          ))}
          <Card variant="outlined" sx={{ bgcolor: "action.hover" }}>
            <CardContent>
              <Typography sx={{ fontWeight: 600, mb: 0.5 }}>What a bot can do</Typography>
              <Typography variant="body2" color="text.secondary">
                It acts as a member of {teamName}: it can submit and read this team's executions and register secrets, and
                nothing outside {teamName}. Give each pipeline its own bot, so revoking one doesn't break the others.
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
                  <CodeBlock code={"gh secret set ACYCLIX_TOKEN \\\n  --repo <your-org>/<your-repo>"} />
                  <Typography variant="subtitle2">2. Submit a DAG from it</Typography>
                  <CodeBlock
                    code={[
                      `jq '{dag: .}' dag.json | curl -X POST ${consoleUrl}/api/acyclix.console.v1.ExecutionService/SubmitExecution \\`,
                      '  -H "Authorization: Bearer $ACYCLIX_TOKEN" \\',
                      '  -H "Content-Type: application/json" \\',
                      "  -d @-",
                    ].join("\n")}
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
              onCreated={(email, token) => {
                setIssued({ email, token });
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

function AddBot({ teamName, onCreated }: { teamName: string; onCreated: (email: string, token: string) => void }) {
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await createBot(teamName, botEmail(teamName, purpose), purpose.trim());
      setPurpose("");
      onCreated(result.email, result.token);
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
