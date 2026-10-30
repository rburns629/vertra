// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { Link as RouterLink } from "react-router-dom";
import Link from "@mui/material/Link";
import HelpIcon from "@mui/icons-material/HelpOutlineOutlined";

/** A place in the guides: the guide's id (console/docs/<id>.md), and a section's anchor. */
export interface Help {
  guide: string;
  section?: string;
  /** What the link says; the guide's subject, so it reads on its own ("Ordering and the cart"). */
  label: ReactNode;
}

/** A guide's address on the Docs page. */
export const helpHref = ({ guide, section }: Pick<Help, "guide" | "section">) => `/docs/${guide}${section ? `#${section}` : ""}`;

/** A link into the guide that explains what's on screen: a question mark, then what it's about. */
export function HelpLink({ guide, section, label }: Help) {
  return (
    <Link
      component={RouterLink}
      to={helpHref({ guide, section })}
      variant="body2"
      underline="hover"
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 500 }}
    >
      <HelpIcon sx={{ fontSize: 16 }} aria-hidden="true" />
      {label}
    </Link>
  );
}
