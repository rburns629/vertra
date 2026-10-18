// SPDX-License-Identifier: MIT
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import GroupsIcon from "@mui/icons-material/GroupsOutlined";
import Typography from "@mui/material/Typography";
import { useNavigate } from "react-router-dom";

/**
 * No per-team stats (DAG count, member count, environment count) are
 * shown here -- `GET /teams` and `/me` only ever return a team's id/name,
 * nothing else, and this project treats "no real data" as a reason to
 * omit a number, not invent one. The namespace line is real: a team's
 * `name` doubles as its Kubernetes namespace, which the console creates
 * with the team (docs/architecture.md).
 */
export function TeamCard({ name }: { name: string }) {
  const navigate = useNavigate();
  return (
    <Card variant="outlined">
      <CardActionArea onClick={() => { navigate(`/teams/${encodeURIComponent(name)}`); }} sx={{ p: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Box
            sx={{
              width: 36,
              height: 36,
              borderRadius: 1.5,
              bgcolor: "action.hover",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <GroupsIcon fontSize="small" color="action" />
          </Box>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600 }}>{name}</Typography>
            <Typography variant="caption" color="text.secondary">
              Namespace: {name}
            </Typography>
          </Box>
          <ChevronRightIcon color="action" />
        </Box>
      </CardActionArea>
    </Card>
  );
}
