// SPDX-License-Identifier: MIT
import { Children, isValidElement, useEffect, useId, useRef, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import Typography from "@mui/material/Typography";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { ApiError, getDoc, listDocs, type DocSummary } from "../api";
import { PageHeader } from "../components/PageHeader";
import { API_REFERENCE_ID, ApiReference } from "./ApiReference";
import Divider from "@mui/material/Divider";

/** mermaid is most of this page's weight, so it's fetched only when a
 * guide actually has a diagram, and once. */
let mermaidLoader: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  mermaidLoader ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: "neutral" });
    return mermaid;
  });
  return mermaidLoader;
}

/**
 * react-markdown renders a fenced ```mermaid block as plain <pre><code> --
 * it has no idea what "mermaid" means. This intercepts exactly that one
 * language tag and renders the diagram for real; every other language
 * still falls through to the default <pre><code> (for e.g. syntax-tagged
 * ```json/```bash blocks elsewhere in these docs, which should stay as
 * plain code, not be swept into this same special case).
 */
function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const isMermaid = className === "language-mermaid";
  const diagramId = useId().replace(/:/g, "-");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const source = String(children ?? "");

  useEffect(() => {
    if (!isMermaid || !containerRef.current) return;
    let cancelled = false;
    loadMermaid()
      .then((mermaid) => mermaid.render(`mermaid-${diagramId}`, source))
      .then(({ svg }) => {
        if (!cancelled && containerRef.current) containerRef.current.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (!cancelled && containerRef.current) {
          containerRef.current.textContent = `Failed to render diagram: ${String(err)}`;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isMermaid, diagramId, source]);

  if (!isMermaid) return <code className={className}>{children}</code>;
  return <div ref={containerRef} />;
}

/**
 * A mermaid diagram must not end up inside a <pre> -- that's the code-block
 * background/padding/monospace styling this page applies via its own "&
 * pre" sx rule, which looks wrong around a rendered SVG. Every other
 * fenced block (```json, ```bash, ...) still needs the normal <pre> the
 * CSS actually targets.
 */
function Pre({ children }: { children?: React.ReactNode }) {
  const child = Children.only(children);
  const isMermaid = isValidElement(child) && (child.props as { className?: string }).className === "language-mermaid";
  // tabIndex: a long line scrolls the block sideways, and keyboard users
  // can only scroll what they can focus.
  return isMermaid ? <>{children}</> : <pre tabIndex={0}>{children}</pre>;
}

/** Wide tables scroll inside their own focusable box rather than widening the page. */
function DocTable({ children }: { children?: React.ReactNode }) {
  return (
    <Box tabIndex={0} role="region" aria-label="Table" sx={{ overflowX: "auto", mb: 2 }}>
      <table>{children}</table>
    </Box>
  );
}

/**
 * GFM task lists ("- [x] done") render as disabled checkboxes: unlabeled
 * form controls that can't be used, and 13px targets. In a guide they're
 * a status mark, so render them as one.
 */
function TaskMark({ type, checked }: { type?: string; checked?: boolean }) {
  if (type !== "checkbox") return <input type={type} />;
  const Icon = checked ? CheckBoxIcon : CheckBoxBlankIcon;
  return (
    <Icon
      role="img"
      aria-label={checked ? "Done:" : "To do:"}
      aria-hidden={false}
      sx={{ fontSize: "1.1em", verticalAlign: "-0.2em", mr: 0.5, color: checked ? "primary.main" : "text.secondary" }}
    />
  );
}

/**
 * A link from one doc to another (e.g. "see [04-secrets-explained.md](04-secrets-explained.md)")
 * would otherwise be a plain <a>, which triggers a real browser
 * navigation -- and a full navigation to /docs/<id> hits this backend's
 * own GET /docs/:id route directly (raw markdown text/plain), not the
 * React app, the same route-collision this project already has for
 * /docs and /executions/:id. Intercepting a same-directory ".md" link
 * and routing it through react-router's navigate() instead keeps it
 * inside the SPA. External links and in-page "#anchor" links (from
 * rehype-slug's heading ids) are left as plain <a>s -- those need real
 * browser behavior, not client-side routing.
 */
function DocLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const navigate = useNavigate();
  const isCrossDocLink = !!href && /^[a-zA-Z0-9_-]+\.md$/.test(href);
  if (!isCrossDocLink) return <a href={href}>{children}</a>;
  return (
    <a
      href={`/docs/${href!.replace(/\.md$/, "")}`}
      onClick={(event) => {
        event.preventDefault();
        navigate(`/docs/${href!.replace(/\.md$/, "")}`);
      }}
    >
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  code: CodeBlock,
  pre: Pre,
  a: DocLink,
  table: DocTable,
  input: TaskMark,
};

/**
 * Renders the guides in console/docs/, served by ../../src/rpc/services/guide.ts
 * from the console's image. The first one in the list opens by default.
 */
export function DocsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => {
    listDocs()
      .then((list) => {
        setDocs(list);
        if (!id && list.length > 0 && list[0]) {
          navigate(`/docs/${list[0].id}`, { replace: true });
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load docs.");
      });
  }, [id, navigate]);

  useEffect(() => {
    if (!id || id === API_REFERENCE_ID) return;
    setLoadingContent(true);
    setContent(null);
    getDoc(id)
      .then(setContent)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load this doc.");
      })
      .finally(() => {
        setLoadingContent(false);
      });
  }, [id]);

  const header = (
    <PageHeader
      title="Help and guides"
      subtitle="How Vertra works and how to use it: getting started, secrets, DAGs, calling the API, and the API reference."
    />
  );

  if (error) {
    return (
      <Box>
        {header}
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  if (docs && docs.length === 0) {
    return (
      <Box>
        {header}
        <Alert severity="info">
          No guides are available here. They ship inside the console&apos;s image, from console/docs/ in the repo.
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      {header}
      {/* Grid, not flex, for the page-level split: a fixed sidebar column plus
         a content column that takes every remaining pixel (1fr), not just
         "grows to fit its content" the way flex's grow/shrink math does --
         exactly what a long-form reading pane like this needs, and why it
         looked narrower/more centered than it should have before.
         Below md there's no room for a second column: the guide list becomes
         a native select above the guide, so the guide itself starts on the
         first screen instead of after a screenful of links. */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "260px minmax(0, 1fr)" },
          gap: { xs: 2, md: 3 },
          alignItems: "start",
        }}
      >
        {docs && (
          <TextField
            select
            label="Guide"
            size="small"
            value={id ?? ""}
            onChange={(event) => {
              navigate(`/docs/${event.target.value}`);
            }}
            slotProps={{ select: { native: true } }}
            sx={{ display: { md: "none" }, bgcolor: "background.paper" }}
          >
            {docs.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.title}
              </option>
            ))}
            <option value={API_REFERENCE_ID}>API reference</option>
          </TextField>
        )}
        <Card variant="outlined" sx={{ display: { xs: "none", md: "block" } }}>
          {docs ? (
            <List component="nav" aria-label="Guides" dense disablePadding>
              {docs.map((doc) => (
                <ListItemButton
                  key={doc.id}
                  component={RouterLink}
                  to={`/docs/${doc.id}`}
                  selected={doc.id === id}
                  aria-current={doc.id === id ? "page" : undefined}
                >
                  <ListItemText primary={doc.title} />
                </ListItemButton>
              ))}
              <Divider />
              <ListItemButton
                component={RouterLink}
                to={`/docs/${API_REFERENCE_ID}`}
                selected={id === API_REFERENCE_ID}
                aria-current={id === API_REFERENCE_ID ? "page" : undefined}
              >
                <ListItemText primary="API reference" />
              </ListItemButton>
            </List>
          ) : (
            <Box sx={{ p: 2, display: "flex", justifyContent: "center" }}>
              <CircularProgress size={24} aria-label="Loading" />
            </Box>
          )}
        </Card>

        <Card variant="outlined" sx={{ minWidth: 0, p: { xs: 2, sm: 4 } }}>
          {id === API_REFERENCE_ID && <ApiReference />}
          {id !== API_REFERENCE_ID && loadingContent && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={24} aria-label="Loading" />
            </Box>
          )}
          {id !== API_REFERENCE_ID && !loadingContent && content && (
            <Box
              sx={{
                "& table": { borderCollapse: "collapse", width: "100%" },
                "& .task-list-item": { listStyle: "none", ml: -2.5, pl: "1.45em", textIndent: "-1.45em" },
                "& th, & td": { border: "1px solid", borderColor: "divider", p: 1, textAlign: "left" },
                "& pre": { bgcolor: "code.background", color: "code.text", p: 2, borderRadius: 2, overflowX: "auto" },
                "& code": { fontFamily: "fontFamilyMono", fontSize: "0.875em" },
                "& img": { maxWidth: "100%" },
              }}
            >
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug]}
                components={MARKDOWN_COMPONENTS}
              >
                {content}
              </Markdown>
            </Box>
          )}
          {!loadingContent && !content && !docs && (
            <Typography color="text.secondary">Loading…</Typography>
          )}
        </Card>
      </Box>
    </Box>
  );
}
