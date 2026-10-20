// SPDX-License-Identifier: MIT
import { useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ApiError, PASSWORD_MIN_LENGTH, register } from "../api";

export function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(email, password);
      // Registering doesn't log you in (see ../../src/rpc/services/auth.ts) --
      // it deliberately grants no access by itself, so the next real step
      // is a normal login.
      navigate("/login");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        bgcolor: "background.default",
      }}
    >
      <Card sx={{ width: 380 }} variant="outlined">
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" sx={{ fontWeight: 600, mb: 3 }}>
            Create an account
          </Typography>
          <Box component="form" onSubmit={(event: FormEvent) => void handleSubmit(event)}>
            <Stack spacing={2}>
              <TextField
                label="Email"
                type="email"
                required
                fullWidth
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
              <TextField
                label="Password"
                type="password"
                required
                fullWidth
                helperText={`At least ${String(PASSWORD_MIN_LENGTH)} characters`}
                slotProps={{ htmlInput: { minLength: PASSWORD_MIN_LENGTH } }}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button type="submit" variant="contained" size="large" disabled={submitting}>
                {submitting ? "Creating account…" : "Create account"}
              </Button>
              <Typography variant="body2" sx={{ textAlign: "center" }}>
                Already have an account? <Link component={RouterLink} to="/login">Sign in</Link>
              </Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
