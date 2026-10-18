// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";
import Chip from "@mui/material/Chip";
import { getEnvironment } from "../api";

/**
 * Which deployment this tab is actually talking to -- a local `kind`
 * cluster and a real GKE deployment both run the identical chart and both
 * say "Kubernetes" by default, so this is what lets a browser tab
 * distinguish them when it matters (or confirms which `kind` cluster, if
 * more than one is ever running). Driven by ENVIRONMENT_LABEL (see
 * ../../src/config.ts), set via helm/charts/execution-console/values.yaml's
 * environmentLabel -- override it per-install if you want the badge to
 * name the specific cluster, rather than a guess made in the browser.
 */
export function EnvironmentBadge() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    getEnvironment()
      .then((env) => { setLabel(env.label); })
      .catch(() => { /* cosmetic only -- a failed fetch just means no badge */ });
  }, []);

  if (!label) return null;

  return (
    <Chip
      label={label}
      size="small"
      color="warning"
      sx={{ fontWeight: 600 }}
    />
  );
}
