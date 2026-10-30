// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Typography from "@mui/material/Typography";
import type { SubmittedTaskPayload, TaskStatus } from "../../api";

const mono = { fontFamily: "fontFamilyMono", fontSize: 12 } as const;

/** repo:tag@sha256:1a2b3c4d5e6f…: the digest cut short (the whole of it on hover). */
function shortImage(image: string): string {
  return image.replace(/@sha256:([0-9a-f]{12})[0-9a-f]+$/, "@sha256:$1…");
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Box component="dt" sx={{ color: "text.secondary", mt: 1, "&:first-of-type": { mt: 0 } }}>
        {label}
      </Box>
      <Box component="dd" sx={{ m: 0, overflowWrap: "anywhere" }}>
        {children}
      </Box>
    </>
  );
}

/** Who asked for the selected step's latest attempt, what it ran as, with which image and secrets. */
export function WhoActed({
  task,
  definition,
  userEmail,
  onBehalfOf,
}: {
  task: TaskStatus;
  definition: SubmittedTaskPayload | undefined;
  userEmail: string | undefined;
  onBehalfOf: string | null;
}) {
  const last = task.attempts.at(-1);
  const asker = last?.requestedBy;
  return (
    <Card component="section" aria-labelledby="who-heading" sx={{ p: { xs: 2, sm: 2.75 }, display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Typography id="who-heading" variant="h6" component="h2">
        Who acted
      </Typography>
      <Box component="dl" sx={{ m: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", rowGap: 0.5, fontSize: 13 }}>
        <Fact label="Asked for by">
          {asker
            ? `${asker === userEmail ? `You (${asker})` : asker}${onBehalfOf ? `, for ${onBehalfOf}` : ""}`
            : last?.trigger === "automatic_retry"
              ? "the scheduler, retrying automatically"
              : "—"}
        </Fact>
        <Fact label="Ran as">
          <Box component="span" sx={mono}>
            {(last?.actedAs || (definition ? `${definition.team}/${definition.serviceAccount ?? "default"}` : "—")).replace("/", " / ")}
          </Box>
        </Fact>
        {definition && (
          <Fact label="Image">
            <Box component="span" sx={mono} title={last?.image || definition.image}>
              {shortImage(last?.image || definition.image)}
            </Box>
          </Fact>
        )}
        {definition?.secretRefs && definition.secretRefs.length > 0 && (
          <Fact label="Secrets mounted">
            <Box component="span" sx={mono}>
              {definition.secretRefs.join(", ")}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              Names only: values are never shown.
            </Typography>
          </Fact>
        )}
      </Box>
    </Card>
  );
}
