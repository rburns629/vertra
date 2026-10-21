// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Link, Stack, TextField, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { addTeamMember, listTeamMembers, removeTeamMember, type TeamMember } from "../../api";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { TabIntro, errorMessage, relativeTime } from "./shared";

const COLUMNS = { xs: "minmax(0, 1fr)", sm: "minmax(0, 2fr) minmax(0, 1fr) minmax(0, 0.8fr) auto" };

export function MembersTab({
  teamName,
  readOnly,
  currentUserId,
  onShowAutomation,
}: {
  teamName: string;
  readOnly: boolean;
  currentUserId: string | undefined;
  onShowAutomation: () => void;
}) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

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

  const people = (members ?? []).filter((m) => !m.isBot);
  const botCount = (members ?? []).length - people.length;

  return (
    <Box>
      <TabIntro>
        People who look after this platform. Every member can add secrets, run and retry this team's work, and add other
        people. Members only act inside {teamName}; they can't see other teams.
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
            <span>Access</span>
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
              <Box>
                {m.isAdmin ? (
                  <Chip label="Vertra admin" size="small" color="warning" variant="outlined" />
                ) : (
                  <Chip label="Member" size="small" variant="outlined" />
                )}
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
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: "divider" }}>
            {botCount > 0 ? `${String(botCount)} bot account${botCount === 1 ? "" : "s"} for pipelines: ` : "Bot accounts for your pipelines are on the "}
            <Link component="button" onClick={onShowAutomation} sx={{ verticalAlign: "baseline" }}>
              Automation
            </Link>
            {botCount > 0 ? "." : " tab."}
          </Typography>
        </Card>

        {!readOnly && <AddPerson teamName={teamName} onAdded={reload} />}
      </Box>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.email ?? ""} from ${teamName}?`}
        description={
          removing?.id === currentUserId
            ? "You'll lose access to this team straight away. Another member or an admin can add you back."
            : "They lose access to this team straight away: its secrets, runs and settings. Another member can add them back."
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
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setAdded(null);
    setSubmitting(true);
    try {
      await addTeamMember(teamName, email.trim());
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
