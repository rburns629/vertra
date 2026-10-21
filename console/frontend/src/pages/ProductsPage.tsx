// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Link as RouterLink } from "react-router-dom";
import Button from "@mui/material/Button";
import { ApiError, listProducts, listRunnables, type Product, type ProductRelease } from "../api";
import { imageName, imageVersion } from "../imageRef";

/** How many releases one product shows. A long-lived product's full
 * history is mostly noise; the recent ones are what a DAG author wants. */
const MAX_RELEASES_SHOWN = 50;

/** Products no team owns are grouped under this heading, after the
 * real platforms. */
const UNOWNED_GROUP = "Platform-provided";

function matches(product: Product, query: string): boolean {
  return (
    product.name.toLowerCase().includes(query) ||
    product.action.toLowerCase().includes(query) ||
    (product.teamName ?? UNOWNED_GROUP).toLowerCase().includes(query) ||
    // Any release, not only the current image, so a search for an old tag
    // still finds the product it belongs to.
    product.image.toLowerCase().includes(query) ||
    product.releases.some((r) => r.image.toLowerCase().includes(query))
  );
}

/**
 * A read-only view of the product registry (`GET /products`) -- what's
 * currently registered as discoverable, kept up to date automatically by
 * the catalog's CI (docs/architecture.md), not something
 * anyone edits here. Deliberately NOT the source of truth for what a DAG
 * can reference -- kernel/ has no concept of this table at all, and any
 * image is runnable directly whether it's registered or not (see this
 * page's own subtitle).
 *
 * Grouped the way the catalog is: one accordion per platform, its products
 * inside, and each product expands to its releases (every image it has
 * been registered with), the current one marked "latest".
 */
export function ProductsPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // The products the caller may run on their own (shared with them).
  const [runnable, setRunnable] = useState<Set<string>>(new Set());

  useEffect(() => {
    listRunnables()
      .then((all) => {
        setRunnable(new Set(all.filter((r) => r.kind === "action").map((r) => r.name)));
      })
      // Only the Run buttons depend on it; the registry still shows.
      .catch(() => undefined);
    listProducts()
      .then(setProducts)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load products.");
      });
  }, []);

  const query = search.trim().toLowerCase();

  /** Platforms in name order, unowned products last. */
  const platforms = useMemo(() => {
    if (!products) return null;
    const byPlatform = new Map<string, Product[]>();
    for (const product of query ? products.filter((p) => matches(p, query)) : products) {
      const platform = product.teamName ?? UNOWNED_GROUP;
      byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), product]);
    }
    return [...byPlatform.entries()].sort(([a], [b]) => {
      if (a === UNOWNED_GROUP) return 1;
      if (b === UNOWNED_GROUP) return -1;
      return a.localeCompare(b);
    });
  }, [products, query]);

  return (
    <Box>
      <PageHeader
        title="Products"
        subtitle="Every team's products, as each catalog release registers them, by team. Expand a team for its products, and a product for its releases. Run one shared with you on its own, or find templates that use them on the Run page."
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ mb: 2 }}>
        <TextField
          size="small"
          placeholder="Search platforms, products or image tags"
          slotProps={{ htmlInput: { "aria-label": "Search platforms, products or image tags" } }}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          sx={{ minWidth: 320 }}
        />
      </Box>

      {platforms === null && !error && (
        <Box>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} variant="rounded" height={56} sx={{ mb: 1 }} />
          ))}
        </Box>
      )}
      {platforms?.length === 0 && (
        <EmptyState
          message={
            products && products.length > 0 ? "No products match this search." : "No products registered yet."
          }
        />
      )}
      {platforms?.map(([platform, platformProducts]) => (
        // Remounted when a search starts or ends, so matches open
        // automatically and everything collapses again afterwards.
        <PlatformAccordion
          key={`${platform}:${query ? "search" : "browse"}`}
          platform={platform}
          products={platformProducts}
          defaultExpanded={query !== ""}
          runnable={runnable}
        />
      ))}
    </Box>
  );
}

function PlatformAccordion({
  platform,
  products,
  defaultExpanded,
  runnable,
}: {
  platform: string;
  products: Product[];
  defaultExpanded: boolean;
  runnable: Set<string>;
}) {
  return (
    <Accordion
      variant="outlined"
      disableGutters
      defaultExpanded={defaultExpanded}
      slotProps={{ transition: { unmountOnExit: true } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{platform}</Typography>
          <Typography variant="body2" color="text.secondary">
            {products.length} {products.length === 1 ? "product" : "products"}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0, bgcolor: "background.default" }}>
        {products.map((product) => (
          <ProductAccordion key={product.id} product={product} runnable={runnable.has(product.name)} />
        ))}
      </AccordionDetails>
    </Accordion>
  );
}

function ProductAccordion({ product, runnable }: { product: Product; runnable: boolean }) {
  const releaseCount = product.releases.length;
  const shown = product.releases.slice(0, MAX_RELEASES_SHOWN);

  return (
    // Unmounted until opened: a long registry shouldn't render every
    // product's release list up front.
    <Accordion variant="outlined" disableGutters slotProps={{ transition: { unmountOnExit: true } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", minWidth: 0, pr: 1 }}>
          <Typography sx={{ fontWeight: 600, fontFamily: "fontFamilyMono", fontSize: 14 }}>
            {imageName(product.image)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            action: {product.action}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {releaseCount} {releaseCount === 1 ? "release" : "releases"}
          </Typography>
          {product.deprecated && (
            <Tooltip title={product.deprecated}>
              <Chip label="deprecated" size="small" color="warning" />
            </Tooltip>
          )}
          <Tooltip title={product.image}>
            <Chip
              label={`latest: ${imageVersion(product.image)}`}
              size="small"
              color="success"
              variant="outlined"
              sx={{ maxWidth: 260, fontFamily: "fontFamilyMono" }}
            />
          </Tooltip>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0 }}>
        {product.deprecated && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            Deprecated: {product.deprecated}
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          Registered as <code>{product.name}</code>
          {" · "}
          {product.shareWith.includes("*")
            ? "shared with every team"
            : product.shareWith.length > 0
              ? `shared with ${product.shareWith.join(", ")}`
              : "its own team only"}
          {product.secretRefs.length > 0 && <> · uses {product.secretRefs.join(", ")}</>}
          {product.tokenAudiences.length > 0 && <> · tokens for {product.tokenAudiences.join(", ")}</>}
        </Typography>
        {runnable && (
          <Button
            component={RouterLink}
            to={`/run?action=${encodeURIComponent(product.name)}`}
            size="small"
            variant="outlined"
            sx={{ mb: 1 }}
          >
            Run on its own
          </Button>
        )}
        {shown.map((release) => (
          <ReleaseRow key={release.image} release={release} isLatest={release.image === product.image} />
        ))}
        {releaseCount > MAX_RELEASES_SHOWN && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            Showing the {MAX_RELEASES_SHOWN} most recent of {releaseCount} releases.
          </Typography>
        )}
      </AccordionDetails>
    </Accordion>
  );
}

function ReleaseRow({ release, isLatest }: { release: ProductRelease; isLatest: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(release.image);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    } catch {
      // Clipboard access can be refused (an insecure origin, a denied
      // permission). The full reference is on screen to select by hand.
    }
  }

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        py: 0.75,
        borderTop: 1,
        borderColor: "divider",
      }}
    >
      <Box
        component="span"
        sx={{ fontFamily: "fontFamilyMono", fontSize: 12.5, wordBreak: "break-all", flexGrow: 1, minWidth: 0 }}
      >
        {release.image}
      </Box>
      {isLatest && <Chip label="latest" size="small" color="success" sx={{ flexShrink: 0 }} />}
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, whiteSpace: "nowrap" }}>
        {new Date(release.registeredAt).toLocaleString()}
      </Typography>
      <Tooltip title={copied ? "Copied" : "Copy image reference"}>
        <IconButton size="small" aria-label="Copy image reference" onClick={() => void copy()} sx={{ flexShrink: 0 }}>
          {copied ? <CheckIcon fontSize="small" color="success" /> : <ContentCopyIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    </Box>
  );
}
