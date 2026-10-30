// SPDX-License-Identifier: MIT
import { useDeferredValue, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import FormControlLabel from "@mui/material/FormControlLabel";
import Link from "@mui/material/Link";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { ApiError, listResources, type MadeResource } from "../api";
import { HelpLink } from "../components/HelpLink";
import { ResourceTable } from "../components/ResourceTable";
import { DeleteRequests } from "./DeleteRequests";

/**
 * What runs made (/runs/made): every resource a run's step reported, for
 * your teams or you, kept after the runs themselves are gone; searchable,
 * and deletable where its product says how (decision 21).
 */
export function ResourcesPage() {
  const [query, setQuery] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [found, setFound] = useState<MadeResource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useDeferredValue(query.trim());

  useEffect(() => {
    let current = true;
    listResources({ query: search, includeDeleted })
      .then((rows) => { if (current) { setFound(rows); setError(null); } })
      .catch((err: unknown) => { if (current) setError(err instanceof ApiError ? err.message : "Couldn't load what runs made."); });
    return () => {
      current = false;
    };
  }, [search, includeDeleted]);

  return (
    <Box>
      <Typography variant="body2" color="text.secondary">
        <Link component={RouterLink} to="/runs">
          Runs
        </Link>{" "}
        / What runs made
      </Typography>
      <Typography variant="h4" component="h1" sx={{ mt: 0.75 }}>
        What runs made
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5, mb: 3, maxWidth: 840 }}>
        What your teams&apos; runs, and yours, made or changed, as each product reported it. It&apos;s kept after the runs are gone,
        so it can be deleted at any time: deleting runs the product&apos;s own cleanup. Something other resources still use is
        deleted only once an admin approves it.{" "}
        <HelpLink guide="10-ordering-and-the-cart" section="where-do-i-find-what-a-run-made-and-how-do-i-delete-it" label="Deleting what a run made" />
      </Typography>
      <DeleteRequests />
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center", mb: 2 }}>
        <TextField
          size="small"
          label="Search"
          placeholder="A type, an id or a name"
          value={query}
          onChange={(e) => { setQuery(e.target.value); }}
          sx={{ flex: "1 1 280px", maxWidth: 480, bgcolor: "background.paper" }}
        />
        <FormControlLabel control={<Switch checked={includeDeleted} onChange={(e) => { setIncludeDeleted(e.target.checked); }} />} label="Show deleted" />
      </Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Card>
        <ResourceTable
          resources={found}
          showRun
          emptyMessage={search ? "Nothing matches." : "Nothing yet: a product lists what a step made as resources in its outputs."}
        />
      </Card>
    </Box>
  );
}
