// SPDX-License-Identifier: MIT
import type { Readiness } from "../api";
import { Pill, type PillTone } from "./Pill";

const LOOK: Record<Readiness["state"], { tone: PillTone; label: string }> = {
  ready: { tone: "success", label: "Ready" },
  not_ready: { tone: "error", label: "Not ready" },
  failed: { tone: "warning", label: "Check failed" },
  checking: { tone: "info", label: "Checking" },
  unchecked: { tone: "neutral", label: "Not checked yet" },
};

/** Whether a product is ready on this install (its check), with what's missing on hover. */
export function ReadinessPill({ readiness }: { readiness: Readiness }) {
  const { tone, label } = LOOK[readiness.state];
  const title = [
    readiness.principal && `Acts as ${readiness.principal}`,
    readiness.missing.length > 0 && `Missing: ${readiness.missing.join("; ")}`,
    readiness.detail,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <Pill tone={tone} title={title || undefined}>
      {label}
    </Pill>
  );
}
