// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TeamCard } from "../components/TeamCard";
import { ApiError, createTeam } from "../api";
import { useAuth } from "../auth/AuthContext";

export function TeamsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [newTeamName, setNewTeamName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  async function handleCreateTeam(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const team = await createTeam(newTeamName);
      // Creating a team doesn't make you a member of it (admins reach every
      // team anyway), so go straight to it to add its first members.
      navigate(`/teams/${encodeURIComponent(team.name)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!user) return null;

  return (
    <Box>
      <PageHeader
        title="Your teams"
        subtitle="Manage team access and resources."
        action={
          user.isAdmin && (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={() => { setShowCreateForm((v) => !v); }}
            >
              Create team
            </Button>
          )
        }
      />

      {user.isAdmin && showCreateForm && (
        <Card variant="outlined" sx={{ mb: 3, maxWidth: 480 }}>
          <CardContent>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
              Create a team
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Catalog platforms get their team automatically. For any other team, its Kubernetes
              namespace must also exist and carry the label <code>acyclix/team=true</code> before
              its tasks can run.
            </Typography>
            <Box
              component="form"
              onSubmit={(event: FormEvent) => void handleCreateTeam(event)}
              sx={{ display: "flex", gap: 1 }}
            >
              <TextField
                size="small"
                label="Team name"
                placeholder="e.g. gcp"
                required
                fullWidth
                autoFocus
                value={newTeamName}
                onChange={(event) => {
                  setNewTeamName(event.target.value);
                }}
              />
              <Button type="submit" variant="contained" disabled={submitting}>
                {submitting ? "Creating…" : "Create"}
              </Button>
            </Box>
            {error && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {error}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {user.teamNames.length === 0 ? (
        <EmptyState
          message={
            user.isAdmin
              ? "You're not a member of any team. As an admin you can open any team from the Admin page."
              : "You're not a member of any team yet. Ask a member of your team, or an admin, to add you."
          }
        />
      ) : (
        <Grid container spacing={2}>
          {user.teamNames.map((teamName) => (
            <Grid key={teamName} size={{ xs: 12, sm: 6, md: 4 }}>
              <TeamCard name={teamName} />
            </Grid>
          ))}
        </Grid>
      )}

      {user.isAdmin && (
        <Link component={RouterLink} to="/admin" variant="body2" sx={{ display: "block", mt: 3 }}>
          Looking for every team, not just yours? See Admin.
        </Link>
      )}
    </Box>
  );
}
