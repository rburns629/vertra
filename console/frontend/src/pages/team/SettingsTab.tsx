// SPDX-License-Identifier: MIT
import { useEffect, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { ApiError, listTeamMembers, setTeamSignIn, type Team, type TeamMember } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useAuth } from "../../auth/AuthContext";
import { useEnvironment } from "../../environment";
import { QuotaSection } from "./QuotaSection";
import { OutcomeWebhookSection } from "./OutcomeWebhookSection";
import { WebhookSection } from "./WebhookSection";

function Section({ title, children, tone }: { title: string; children: ReactNode; tone?: "danger" }) {
  return (
    <Card sx={{ p: 3, display: "flex", flexDirection: "column", gap: 1.5, borderColor: tone === "danger" ? "error.light" : undefined }}>
      <Typography variant="h6" component="h2">
        {title}
      </Typography>
      {children}
    </Card>
  );
}

const mono = { fontFamily: "fontFamilyMono", fontSize: 13 } as const;

/**
 * How a team signs in, its chat notifications, where it comes from, and (for an admin) retiring,
 * restoring and purging it. Members see the same, without the controls.
 */
export function SettingsTab({
  team,
  isAdmin,
  onChanged,
  onRetire,
  onRestore,
  onPurge,
  busy,
}: {
  team: Team;
  isAdmin: boolean;
  /** The team changed (its sign-in): reload it. */
  onChanged: () => void;
  onRetire: () => Promise<void>;
  onRestore: () => Promise<void>;
  onPurge: () => Promise<void>;
  busy: boolean;
}) {
  const sso = useEnvironment()?.ssoLabel ?? "";
  const { user } = useAuth();
  const canManage = isAdmin || (user?.maintainerOf.includes(team.name) ?? false);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<"retire" | "purge" | null>(null);
  const retired = Boolean(team.retiredAt);

  useEffect(() => {
    // Display only: without it, the warning below just isn't shown.
    listTeamMembers(team.name).then(setMembers).catch(() => undefined);
  }, [team.name]);

  // People (not bots) who only have a password: requiring single sign-on
  // stops them signing in until they use it. Admins keep their password.
  const passwordOnly = (members ?? []).filter((m) => !m.isBot && !m.isAdmin && m.hasPassword && !m.usesSso);

  async function changeSignIn(requireSso: boolean): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      await setTeamSignIn(team.name, requireSso);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change how it signs in.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))", gap: 2, alignItems: "start" }}>
      {error && (
        <Alert severity="error" sx={{ gridColumn: "1 / -1" }}>
          {error}
        </Alert>
      )}

      <Section title="Signing in">
        {sso ? (
          <>
            <FormControlLabel
              control={<Switch checked={team.requireSso} disabled={!isAdmin || saving || retired} onChange={(event) => void changeSignIn(event.target.checked)} />}
              label={`Require ${sso} sign-in for its members`}
              sx={{ justifyContent: "space-between", ml: 0, "& .MuiFormControlLabel-label": { fontWeight: 500 } }}
              labelPlacement="start"
            />
            <Typography variant="body2" color="text.secondary">
              Its members then can&apos;t use a password, here or with the gateway, and a password session they already have
              stops working. Admins can always use theirs, in case {sso} can&apos;t be reached.
              {!isAdmin && " Only admins change this."}
            </Typography>
            {passwordOnly.length > 0 && (
              <Alert severity="warning">
                {passwordOnly.length === 1 ? "1 member signs" : `${String(passwordOnly.length)} members sign`} in with a password only:{" "}
                {passwordOnly.map((m) => m.email).join(", ")}.{" "}
                {team.requireSso ? "They can't sign in until they use " : "Requiring it would stop them until they use "}
                {sso}.
              </Alert>
            )}
          </>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Everyone signs in with a password: single sign-on isn&apos;t set up on this install.
            {isAdmin && (
              <>
                {" "}
                To set it up: Admin, People, Single sign-on (or <Box component="span" sx={mono}>vertra sso google</Box>).
              </>
            )}
          </Typography>
        )}
      </Section>

      <QuotaSection team={team} isAdmin={isAdmin} onChanged={onChanged} />

      <WebhookSection team={team.name} canManage={canManage} retired={retired} />

      <OutcomeWebhookSection team={team.name} canManage={canManage} retired={retired} />

      <Section title="Where it comes from">
        <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 2, rowGap: 1 }}>
          <Typography component="dt" variant="body2" color="text.secondary">
            Made by
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            {team.fromCatalog ? (
              <>
                The catalog: <Box component="span" sx={mono}>teams/{team.name}/</Box>
              </>
            ) : (
              "Made here: the catalog leaves it alone until an admin adopts it."
            )}
          </Typography>
          <Typography component="dt" variant="body2" color="text.secondary">
            Namespace
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, ...mono }}>
            {team.name}
          </Typography>
          <Typography component="dt" variant="body2" color="text.secondary">
            Created
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0 }}>
            {new Date(team.createdAt).toLocaleDateString()}
          </Typography>
        </Box>
        <Typography variant="body2" color="text.secondary">
          {team.fromCatalog
            ? "Its name, maintainers and products change in the catalog. Members and secrets change here."
            : "Its members, secrets and products all change here."}
        </Typography>
      </Section>

      {isAdmin && (
        <Section title={retired ? "Restore it" : "Retire it"} tone={retired ? undefined : "danger"}>
          <Typography variant="body2">
            {retired
              ? "It's retired: read-only, its products unregistered, nothing new starting in its namespace. Restoring it makes it a working team again; its products return with the catalog's next release."
              : "For a team that's going away. It becomes read-only, its products are unregistered, and nothing new starts in its namespace; what's running finishes. You can undo it."}
            {team.fromCatalog && !retired && " A catalog release without its folder retires it too."}
          </Typography>
          <Box>
            {retired ? (
              <Button variant="outlined" disabled={busy} onClick={() => void onRestore()}>
                Restore {team.name}
              </Button>
            ) : (
              <Button variant="outlined" color="error" disabled={busy} onClick={() => { setConfirm("retire"); }}>
                Retire {team.name}…
              </Button>
            )}
          </Box>
        </Section>
      )}

      {isAdmin && (
        <Section title="Purge it" tone="danger">
          <Typography variant="body2">
            Can&apos;t be undone. Only for a retired team with no unfinished runs. Removes its members, secrets&apos; grants,
            products and the bots it leaves with no team. Its run history stays, and its name stays taken. Its namespace
            stays too, labelled retired, for a cluster administrator to delete.
          </Typography>
          <Box>
            <Button variant="contained" color="error" disabled={busy || !retired} onClick={() => { setConfirm("purge"); }}>
              Purge {team.name}…
            </Button>
            {!retired && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
                Retire it first.
              </Typography>
            )}
          </Box>
        </Section>
      )}

      <ConfirmDialog
        open={confirm === "retire"}
        title={`Retire ${team.name}?`}
        description="It becomes read-only and its products are unregistered; nothing new starts in its namespace. You can restore it."
        confirmLabel="Retire"
        destructive
        busy={busy}
        onConfirm={() => void onRetire().finally(() => { setConfirm(null); })}
        onCancel={() => { setConfirm(null); }}
      />
      <ConfirmDialog
        open={confirm === "purge"}
        title={`Purge ${team.name}?`}
        description="This can't be undone. Members, secret grants and bot tokens are removed, and the name stays reserved; run history is kept. Its namespace stays, labelled retired, for a cluster administrator to delete."
        confirmLabel="Purge"
        confirmText={team.name}
        destructive
        busy={busy}
        onConfirm={() => void onPurge().finally(() => { setConfirm(null); })}
        onCancel={() => { setConfirm(null); }}
      />
    </Box>
  );
}
