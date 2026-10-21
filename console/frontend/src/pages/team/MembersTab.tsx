// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Link,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import { addTeamMember, listTeamMembers, removeTeamMember, setTeamMemberRole, type Role, type TeamMember } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { TabIntro, errorMessage, relativeTime } from "./shared";

const COLUMNS = { xs: "minmax(0, 1fr)", sm: "minmax(0, 2fr) minmax(0, 1.2fr) minmax(0, 0.8fr) auto" };

const ROLE_LABELS: Record<Role, string> = { maintainer: "Maintainer", member: "Member" };

export function MembersTab({
  teamName,
  readOnly,
  currentUserId,
  onShowAutomation,
}: {
  teamName: string;
  readOnly: boolean;
  currentUserId: string | undefined;
  /** Absent for someone who can't see the team's bots. */
  onShowAutomation?: () => void;
}) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [roleBusy, setRoleBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    listTeamMembers(teamName)
      .then(setMembers)
      .catch((err: unknown) => {
        setLoadError(errorMessage(err, "Couldn't load members."));
      });
  }, [teamName]);

  useEffect(reload, [reload]);

  async function remove(): Promise<void> {
    if (!removing) return;
    setRemoveBusy(true);
    setLoadError(null);
    try {
      await removeTeamMember(teamName, removing.id);
      reload();
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't remove them. Try again."));
    } finally {
      setRemoveBusy(false);
      setRemoving(null);
    }
  }

  async function changeRole(member: TeamMember, role: Role): Promise<void> {
    setRoleBusy(member.id);
    setLoadError(null);
    try {
      await setTeamMemberRole(teamName, member.id, role);
      reload();
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't change their role. Try again."));
    } finally {
      setRoleBusy(null);
    }
  }

  const people = (members ?? []).filter((m) => !m.isBot);
  const botCount = (members ?? []).length - people.length;

  return (
    <Box>
      <TabIntro>
        People in {teamName}. Every member sees the team's runs, logs and secrets' names, and runs its actions.
        Maintainers also manage it: people and their roles, secrets, bots, and raw DAGs. Nobody here acts for another
        team.
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
        <Card variant="outlined" sx={{ overflow: "hidden" }}>
          <Box
            sx={{
              display: { xs: "none", sm: "grid" },
              gridTemplateColumns: COLUMNS,
              gap: 2,
              px: 2,
              py: 1.25,
              bgcolor: "action.hover",
              fontSize: 12,
              fontWeight: 600,
              color: "text.secondary",
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            <span>Person</span>
            <span>Role</span>
            <span>Added</span>
            <span />
          </Box>
          {members && people.length === 0 && (
            <Typography color="text.secondary" sx={{ p: 2, borderTop: 1, borderColor: "divider" }}>
              Nobody yet. An admin adds the first person.
            </Typography>
          )}
          {people.map((m) => (
            <Box
              key={m.id}
              sx={{
                display: "grid",
                gridTemplateColumns: COLUMNS,
                gap: 2,
                alignItems: "center",
                px: 2,
                py: 1.5,
                borderTop: 1,
                borderColor: "divider",
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, minWidth: 0 }}>
                <Box
                  sx={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    flexShrink: 0,
                    bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                    color: "primary.dark",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 14,
                  }}
                >
                  {m.email.slice(0, 2).toUpperCase()}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600, overflowWrap: "anywhere" }}>{m.email}</Typography>
                  {m.id === currentUserId && (
                    <Typography variant="caption" color="text.secondary">
                      You
                    </Typography>
                  )}
                </Box>
              </Box>
              <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
                {readOnly ? (
                  <Chip label={ROLE_LABELS[m.role]} size="small" variant="outlined" />
                ) : (
                  <TextField
                    select
                    size="small"
                    value={m.role}
                    disabled={roleBusy === m.id}
                    onChange={(event) => void changeRole(m, event.target.value as Role)}
                    slotProps={{ htmlInput: { "aria-label": `${m.email}'s role` } }}
                    sx={{ minWidth: 140 }}
                  >
                    <MenuItem value="maintainer">Maintainer</MenuItem>
                    <MenuItem value="member">Member</MenuItem>
                  </TextField>
                )}
                {m.isAdmin && <Chip label="Vertra admin" size="small" color="warning" variant="outlined" />}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {relativeTime(m.addedAt)}
              </Typography>
              <Box sx={{ textAlign: "right" }}>
                {!readOnly && (
                  <Button
                    size="small"
                    color="error"
                    onClick={() => {
                      setRemoving(m);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </Box>
            </Box>
          ))}
          {onShowAutomation && (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: "divider" }}>
              {botCount > 0 ? `${String(botCount)} bot account${botCount === 1 ? "" : "s"} for pipelines: ` : "Bot accounts for your pipelines are on the "}
              <Link component="button" onClick={onShowAutomation} sx={{ verticalAlign: "baseline" }}>
                Automation
              </Link>
              {botCount > 0 ? "." : " tab."}
            </Typography>
          )}
        </Card>

        {!readOnly && <AddPerson teamName={teamName} onAdded={reload} />}
      </Box>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.email ?? ""} from ${teamName}?`}
        description={
          removing?.id === currentUserId
            ? "You'll lose access to this team straight away. A maintainer or an admin can add you back."
            : "They lose access to this team straight away: its secrets, runs and settings. A maintainer can add them back."
        }
        confirmLabel="Remove"
        destructive
        busy={removeBusy}
        onConfirm={() => void remove()}
        onCancel={() => {
          setRemoving(null);
        }}
      />
    </Box>
  );
}

function AddPerson({ teamName, onAdded }: { teamName: string; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setAdded(null);
    setSubmitting(true);
    try {
      await addTeamMember(teamName, email.trim(), role);
      setAdded(email.trim());
      setEmail("");
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Couldn't add them. Try again."));
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
              Add a person
            </Typography>
            <TextField
              label="Their console email"
              type="email"
              size="small"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              helperText="They need a console account first. No account yet? Ask a Vertra admin to create one; it can join this team straight away."
            />
            <TextField
              select
              label="Role"
              size="small"
              value={role}
              onChange={(event) => {
                setRole(event.target.value as Role);
              }}
              helperText={
                role === "maintainer"
                  ? "Can manage the team: people, secrets, bots and raw DAGs."
                  : "Sees the team's work and runs its actions; manages nothing."
              }
            >
              <MenuItem value="member">Member</MenuItem>
              <MenuItem value="maintainer">Maintainer</MenuItem>
            </TextField>
            <Button type="submit" variant="contained" disabled={submitting} sx={{ alignSelf: "flex-start" }}>
              {submitting ? "Adding…" : `Add to ${teamName}`}
            </Button>
            {error && <Alert severity="error">{error}</Alert>}
            {added && (
              <Alert severity="success">
                {added} added. They'll see {teamName} the next time they open the console.
              </Alert>
            )}
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}
