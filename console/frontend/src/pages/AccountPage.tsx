// SPDX-License-Identifier: MIT
import { useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
import { PageHeader } from "../components/PageHeader";
import { PasswordChangeForm } from "../components/PasswordChangeForm";
import { useAuth } from "../auth/AuthContext";

export function AccountPage() {
  const { user } = useAuth();
  const [changed, setChanged] = useState(false);
  return (
    <Box>
      <PageHeader title="Account" subtitle={user?.email} />
      <Card sx={{ maxWidth: 480 }}>
        <CardContent sx={{ p: 3 }}>
          <Typography variant="h6" component="h2" sx={{ mb: 0.5 }}>
            Change password
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Signs out every other session on this account. This one stays signed in.
          </Typography>
          {changed && (
            <Alert severity="success" sx={{ mb: 2 }}>
              Password changed. Other sessions have been signed out.
            </Alert>
          )}
          <PasswordChangeForm currentLabel="Current password" submitLabel="Change password" onChanged={() => { setChanged(true); }} />
        </CardContent>
      </Card>
    </Box>
  );
}
