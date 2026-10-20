// SPDX-License-Identifier: MIT
import { useEffect, useState, type FormEvent } from "react";
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
import { ApiError, getEnvironment } from "../api";
import { useAuth } from "../auth/AuthContext";
import { EnvironmentBadge } from "../layout/EnvironmentBadge";

export function LoginPage() {
  const { login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Registration is usually closed (admins create accounts); only offer
  // it when the server says it's open.
  const [selfRegistration, setSelfRegistration] = useState(false);
  useEffect(() => {
    getEnvironment()
      .then((environment) => {
        setSelfRegistration(environment.selfRegistration);
      })
      .catch(() => undefined);
  }, []);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/");
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
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 3 }}>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>
              Sign in
            </Typography>
            <EnvironmentBadge />
          </Box>
          <Box component="form" onSubmit={(event: FormEvent) => void handleSubmit(event)}>
            <Stack spacing={2}>
              {sessionExpired && !error && (
                <Alert severity="info">Your session has ended. Sign in again to continue.</Alert>
              )}
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
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button type="submit" variant="contained" size="large" disabled={submitting}>
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
              <Typography variant="body2" sx={{ textAlign: "center" }}>
                {selfRegistration ? (
                  <>
                    No account? <Link component={RouterLink} to="/register">Register</Link>
                  </>
                ) : (
                  "No account? Ask an Vertra admin to create one for you."
                )}
              </Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
