// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { PageHeader } from "../components/PageHeader";
import { ApiError, changePassword, PASSWORD_MIN_LENGTH } from "../api";
import { useAuth } from "../auth/AuthContext";

export function AccountPage() {
  const { user } = useAuth();
  return (
    <Box>
      <PageHeader title="Account" subtitle={user?.email} />
      <ChangePasswordCard />
    </Box>
  );
}

function ChangePasswordCard() {
  const { adoptToken } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setSubmitting(true);
    try {
      // The change revokes this very session, so the new token has to be
      // swapped in before anything else makes a request.
      adoptToken(await changePassword(currentPassword, newPassword));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card variant="outlined" sx={{ maxWidth: 480 }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>
          Change password
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Signs out every other session on this account. This one stays signed in.
        </Typography>
        <Box component="form" onSubmit={(event: FormEvent) => void handleSubmit(event)}>
          <Stack spacing={2}>
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              required
              fullWidth
              size="small"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
              }}
            />
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              fullWidth
              size="small"
              helperText={`At least ${String(PASSWORD_MIN_LENGTH)} characters`}
              slotProps={{ htmlInput: { minLength: PASSWORD_MIN_LENGTH } }}
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
              }}
            />
            <TextField
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              required
              fullWidth
              size="small"
              error={mismatch}
              helperText={mismatch ? "Doesn't match the new password" : " "}
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
              }}
            />
            {error && <Alert severity="error">{error}</Alert>}
            {success && <Alert severity="success">Password changed. Other sessions have been signed out.</Alert>}
            <Box>
              <Button
                type="submit"
                variant="contained"
                disabled={submitting || mismatch || confirmPassword.length === 0}
              >
                {submitting ? "Changing…" : "Change password"}
              </Button>
            </Box>
          </Stack>
        </Box>
      </CardContent>
    </Card>
  );
}
