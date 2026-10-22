// SPDX-License-Identifier: MIT
import { useEffect, useState, type FormEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { ApiError, getEnvironment, SSO_START } from "../api";
import { useAuth } from "../auth/AuthContext";
import { EnvironmentBadge } from "../layout/EnvironmentBadge";

/** What /login#error=<CODE> means, from a single sign-on that was refused. */
const SSO_ERRORS: Record<string, string> = {
  DOMAIN_NOT_ALLOWED: "That account isn't from a domain allowed to sign in here. Choose your work account.",
  EMAIL_NOT_VERIFIED: "Your provider hasn't verified that account's email.",
  ACCOUNT_LINKED_ELSEWHERE: "This email's Vertra account signs in with a different account. Ask an admin if that's wrong.",
  SIGN_IN_EXPIRED: "That sign-in took too long or was started elsewhere. Try again.",
  SIGN_IN_CANCELLED: "Sign-in was cancelled.",
  SIGN_IN_FAILED: "Sign-in didn't work. Try again, or ask an admin.",
};

export function LoginPage() {
  const { login, sessionExpired, adoptToken, refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Registration is usually closed (admins create accounts); only offer
  // it when the server says it's open.
  const [selfRegistration, setSelfRegistration] = useState(false);
  // Single sign-on's provider, when it's on. Passwords still work, except
  // for teams that require single sign-on.
  const [sso, setSso] = useState("");
  useEffect(() => {
    getEnvironment()
      .then((environment) => {
        setSelfRegistration(environment.selfRegistration);
        setSso(environment.ssoLabel);
      })
      .catch(() => undefined);
  }, []);

  // Back from single sign-on: the session (or why not) in the fragment,
  // which never reaches a server. Taken off the address straight away.
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get("token");
    const failed = fragment.get("error");
    if (!token && !failed) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (failed) {
      setError(SSO_ERRORS[failed] ?? SSO_ERRORS["SIGN_IN_FAILED"] ?? null);
      return;
    }
    if (token) {
      adoptToken(token);
      void refresh().then(() => {
        navigate("/");
      });
    }
  }, [adoptToken, refresh, navigate]);

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
          {sso && (
            <Stack spacing={2} sx={{ mb: 2 }}>
              <Button variant="contained" size="large" href={SSO_START}>
                Sign in with {sso}
              </Button>
              <Divider>
                <Typography variant="caption" color="text.secondary">
                  or with a password
                </Typography>
              </Divider>
            </Stack>
          )}
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
              <Button type="submit" variant={sso ? "outlined" : "contained"} size="large" disabled={submitting}>
                {submitting ? "Signing in…" : "Sign in"}
              </Button>
              <Typography variant="body2" sx={{ textAlign: "center" }}>
                {selfRegistration ? (
                  <>
                    No account? <Link component={RouterLink} to="/register">Register</Link>
                  </>
                ) : sso ? (
                  `No account? Sign in with ${sso}, or ask a Vertra admin for one.`
                ) : (
                  "No account? Ask a Vertra admin to create one for you."
                )}
              </Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
