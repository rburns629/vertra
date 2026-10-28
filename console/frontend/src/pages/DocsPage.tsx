// SPDX-License-Identifier: MIT
import { Children, createContext, isValidElement, useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Typography from "@mui/material/Typography";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import { ApiError, getDoc, listDocs, searchDocs, type DocHit, type DocSummary } from "../api";
import { PageHeader } from "../components/PageHeader";
import { API_REFERENCE_ID, ApiReference } from "./ApiReference";
import { contentsOf, docTarget, placeOf, sectionsOf, slug, START_HERE, type Category, type Entry } from "./docs/contents";

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

/** The ids of the docs the console serves, for links between them. */
const Served = createContext<ReadonlySet<string>>(new Set());

/**
 * A link from one doc to another is written as the repository has it
 * ("security-model.md", "../setup.md", "clouds/gcp.md#…"). It goes to the
 * same doc here (docTarget), through react-router: a full navigation to
 * /docs/<id> would reach the backend's own GET /docs/:id (raw markdown),
 * not the app. A doc the console doesn't serve (TODO.md, the kernel's)
 * stays as its words, not a link to nowhere. External links and in-page
 * "#anchor" links are left as plain <a>s.
 */
function DocLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const navigate = useNavigate();
  const served = useContext(Served);
  if (!href || !/^[^:]*\.md(#|$)/.test(href)) return <a href={href}>{children}</a>;
  const to = docTarget(href, served);
  if (!to) return <>{children}</>;
  return (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        void navigate(to);
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

/** Searching every guide and reference doc (GuideService/SearchGuides): the sections that match, linked. */
function DocSearch() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocHit[] | null>(null);
  const search = useDeferredValue(query.trim());
  useEffect(() => {
    if (search.length < 2) {
      setHits(null);
      return;
    }
    let current = true;
    searchDocs(search)
      .then((found) => { if (current) setHits(found); })
      .catch(() => { if (current) setHits([]); });
    return () => {
      current = false;
    };
  }, [search]);
  return (
    <Box sx={{ mb: 2 }}>
      <TextField
        size="small"
        fullWidth
        placeholder="Search the docs: how do I back up the database?"
        slotProps={{ htmlInput: { "aria-label": "Search the docs" } }}
        value={query}
        onChange={(e) => { setQuery(e.target.value); }}
        sx={{ maxWidth: 560, bgcolor: "background.paper" }}
      />
      {hits && (
        <Card variant="outlined" sx={{ mt: 1, maxWidth: 760 }}>
          {hits.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              Nothing matches.
            </Typography>
          ) : (
            <List dense disablePadding aria-label="Search results">
              {hits.map((h) => (
                <ListItemButton
                  key={`${h.guide}#${h.heading}`}
                  component={RouterLink}
                  to={`/docs/${h.guide}${h.heading === h.title ? "" : `#${slug(h.heading.split(" > ").at(-1) ?? "")}`}`}
                  onClick={() => { setQuery(""); }}
                >
                  <ListItemText
                    primary={`${h.title} · ${h.heading}`}
                    secondary={`${h.kind === "history" ? "Design history, not how it works now: " : ""}${h.excerpt.slice(0, 180)}`}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </Card>
      )}
    </Box>
  );
}


/** The contents down the side: each category a heading that opens and closes, the one you're in open. */
function DocsNav({ categories, current }: { categories: Category[]; current: string | undefined }) {
  const here = categories.find((c) => c.entries.some((e) => e.id === current))?.id;
  const [open, setOpen] = useState<Set<string>>(() => new Set(here ? [here] : []));
  useEffect(() => {
    if (here) setOpen((was) => (was.has(here) ? was : new Set([...was, here])));
  }, [here]);
  const toggle = (id: string) => {
    setOpen((was) => {
      const now = new Set(was);
      if (now.has(id)) now.delete(id);
      else now.add(id);
      return now;
    });
  };
  return (
    <List component="nav" aria-label="Docs contents" dense disablePadding>
      <ListItemButton component={RouterLink} to="/docs" selected={!current} aria-current={!current ? "page" : undefined} sx={{ borderRadius: 1, mb: 1 }}>
        <ListItemText primary="Docs home" slotProps={{ primary: { sx: { fontWeight: 600 } } }} />
      </ListItemButton>
      {categories.map((c) => {
        const expanded = open.has(c.id);
        return (
          <Box component="li" key={c.id} sx={{ listStyle: "none" }}>
            <ListItemButton onClick={() => { toggle(c.id); }} aria-expanded={expanded} sx={{ borderRadius: 1 }}>
              <ListItemText primary={c.title} slotProps={{ primary: { sx: { fontWeight: 700, color: "text.primary" } } }} />
              <ExpandMoreIcon fontSize="small" sx={{ color: "text.secondary", transition: "transform .15s", transform: expanded ? "rotate(180deg)" : "none" }} />
            </ListItemButton>
            <Collapse in={expanded} unmountOnExit>
              <List dense disablePadding sx={{ ml: 1.5, pl: 1, borderLeft: 1, borderColor: "divider", mb: 0.5 }}>
                {c.entries.map((e) => (
                  <ListItemButton
                    key={e.id}
                    component={RouterLink}
                    to={`/docs/${e.id}`}
                    selected={e.id === current}
                    aria-current={e.id === current ? "page" : undefined}
                    sx={{ borderRadius: 1, py: 0.25, color: "text.secondary", "&.Mui-selected": { color: "primary.main", fontWeight: 600 } }}
                  >
                    <ListItemText primary={e.label} secondary={e.history ? "Design history" : undefined} slotProps={{ primary: { sx: { fontWeight: "inherit" } } }} />
                  </ListItemButton>
                ))}
              </List>
            </Collapse>
          </Box>
        );
      })}
    </List>
  );
}

/** On a phone, the contents as one list to choose from. */
function DocsPicker({ categories, current }: { categories: Category[]; current: string | undefined }) {
  const navigate = useNavigate();
  return (
    <TextField
      select
      label="Doc"
      size="small"
      value={current ?? ""}
      onChange={(event) => { void navigate(event.target.value ? `/docs/${event.target.value}` : "/docs"); }}
      slotProps={{ select: { native: true } }}
      sx={{ display: { md: "none" }, bgcolor: "background.paper", mb: 2 }}
      fullWidth
    >
      <option value="">Docs home</option>
      {categories.map((c) => (
        <optgroup key={c.id} label={c.title}>
          {c.entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </optgroup>
      ))}
    </TextField>
  );
}

/** The docs' home: where to start, in order, and each category with what's in it. */
function DocsHome({ categories }: { categories: Category[] }) {
  const entries = new Map(categories.flatMap((c) => c.entries.map((e) => [e.id, e])));
  const path = START_HERE.flatMap((id) => entries.get(id) ?? []);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {path.length > 0 && (
        <Box component="section" aria-labelledby="start-here">
          <Typography id="start-here" variant="h6" component="h2" sx={{ mb: 1.5 }}>
            Start here
          </Typography>
          <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: `repeat(${String(path.length)}, 1fr)` } }}>
            {path.map((e, i) => (
              <li key={e.id}>
                <Card variant="outlined" sx={{ height: "100%", "&:hover": { borderColor: "primary.main" } }}>
                  <CardActionArea component={RouterLink} to={`/docs/${e.id}`} sx={{ p: 2, height: "100%", display: "flex", alignItems: "flex-start", justifyContent: "flex-start", gap: 1.5 }}>
                    <Box
                      aria-hidden="true"
                      sx={{ flex: "none", width: 28, height: 28, borderRadius: "50%", bgcolor: "primary.main", color: "primary.contrastText", display: "grid", placeItems: "center", fontSize: 14, fontWeight: 700 }}
                    >
                      {i + 1}
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">
                        Step {i + 1}
                      </Typography>
                      <Typography sx={{ fontWeight: 600 }}>{e.label}</Typography>
                    </Box>
                  </CardActionArea>
                </Card>
              </li>
            ))}
          </Box>
        </Box>
      )}
      <Box component="section" aria-labelledby="browse">
        <Typography id="browse" variant="h6" component="h2" sx={{ mb: 1.5 }}>
          Browse the docs
        </Typography>
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", xl: "1fr 1fr 1fr" } }}>
          {categories.map((c) => (
            <Card key={c.id} variant="outlined" sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 1 }}>
              <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700 }}>
                {c.title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {c.blurb}
              </Typography>
              <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
                {c.entries.map((e) => (
                  <li key={e.id}>
                    <Link component={RouterLink} to={`/docs/${e.id}`} underline="hover" variant="body2" sx={{ fontWeight: 500 }}>
                      {e.label}
                    </Link>
                  </li>
                ))}
              </Box>
            </Card>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/** Previous and next in reading order, at the foot of a doc. */
function Onward({ place }: { place: NonNullable<ReturnType<typeof placeOf>> }) {
  const card = (to: { entry: Entry; category: Category } | undefined, way: "Previous" | "Next") =>
    to ? (
      <Card variant="outlined" sx={{ "&:hover": { borderColor: "primary.main" } }}>
        <CardActionArea component={RouterLink} to={`/docs/${to.entry.id}`} sx={{ p: 2, textAlign: way === "Next" ? "right" : "left" }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.5, justifyContent: way === "Next" ? "flex-end" : "flex-start" }}>
            {way === "Previous" && <ArrowBackIcon sx={{ fontSize: 14 }} />}
            {way} · {to.category.title}
            {way === "Next" && <ArrowForwardIcon sx={{ fontSize: 14 }} />}
          </Typography>
          <Typography sx={{ fontWeight: 600, color: "primary.main" }}>{to.entry.label}</Typography>
        </CardActionArea>
      </Card>
    ) : (
      <Box />
    );
  return (
    <Box component="nav" aria-label="Previous and next" sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, mt: 4 }}>
      {card(place.previous, "Previous")}
      {card(place.next, "Next")}
    </Box>
  );
}

/** "On this page": a doc's sections, beside it on a wide screen. */
function OnThisPage({ markdown }: { markdown: string }) {
  const sections = useMemo(() => sectionsOf(markdown), [markdown]);
  if (sections.length < 2) return null;
  return (
    <Box component="nav" aria-label="On this page" sx={{ display: { xs: "none", lg: "block" }, position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
      <Typography variant="overline" color="text.secondary" sx={{ display: "block", mb: 0.5, lineHeight: 2 }}>
        On this page
      </Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", borderLeft: 1, borderColor: "divider" }}>
        {sections.map((s) => (
          <li key={s.anchor}>
            <Link href={`#${s.anchor}`} underline="hover" variant="body2" color="text.secondary" sx={{ display: "block", py: 0.5, pl: 1.5, "&:hover": { color: "text.primary" } }}>
              {s.title}
            </Link>
          </li>
        ))}
      </Box>
    </Box>
  );
}

const PROSE = {
  maxWidth: 820,
  fontSize: 15,
  lineHeight: 1.7,
  "& h1": { fontSize: 30, lineHeight: 1.25, fontWeight: 600, mt: 0, mb: 2 },
  "& h2": { fontSize: 22, lineHeight: 1.3, fontWeight: 600, mt: 5, mb: 1.5, pt: 2, borderTop: 1, borderColor: "divider" },
  "& h3": { fontSize: 18, fontWeight: 600, mt: 3.5, mb: 1 },
  "& h4": { fontSize: 15, fontWeight: 600, mt: 3, mb: 1 },
  "& h1, & h2, & h3, & h4": { scrollMarginTop: 16 },
  // A doc's own rule before a section: the section's is enough.
  "& hr": { border: 0, borderTop: 1, borderColor: "divider", my: 4 },
  "& hr + h2": { borderTop: 0, pt: 0, mt: 0 },
  "& a": { color: "primary.main" },
  "& blockquote": { m: 0, my: 2, px: 2, py: 1, borderLeft: 4, borderColor: "primary.main", bgcolor: "action.hover", borderRadius: 1 },
  "& table": { borderCollapse: "collapse", width: "100%", fontSize: 14 },
  "& .task-list-item": { listStyle: "none", ml: -2.5, pl: "1.45em", textIndent: "-1.45em" },
  "& th, & td": { border: "1px solid", borderColor: "divider", p: 1, textAlign: "left" },
  "& th": { bgcolor: "action.hover" },
  "& pre": { bgcolor: "code.background", color: "code.text", p: 2, borderRadius: 2, overflowX: "auto", lineHeight: 1.5 },
  "& code": { fontFamily: "fontFamilyMono", fontSize: "0.875em" },
  "& :not(pre) > code": { bgcolor: "action.hover", px: 0.5, py: 0.125, borderRadius: 0.5 },
  "& img": { maxWidth: "100%" },
};

/**
 * The guides in console/docs/, and the platform's own docs in
 * console/docs/reference/, served by ../../src/rpc/services/guide.ts from
 * the console's image, laid out as one set of docs (./docs/contents.ts):
 * a home with where to start, the contents down the side in categories,
 * each doc with where it sits, its sections beside it, and the next one
 * to read at its foot, and a search over them all.
 */
export function DocsPage() {
  const { id } = useParams();
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => {
    listDocs()
      .then(setDocs)
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Failed to load docs.");
      });
  }, []);

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

  // A link to a section scrolls to it once the doc is there to scroll in.
  const { hash } = useLocation();
  useEffect(() => {
    if (content && hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
  }, [content, hash]);

  const categories = useMemo(() => (docs ? contentsOf(docs) : []), [docs]);
  const served = useMemo(() => new Set([API_REFERENCE_ID, ...(docs?.map((d) => d.id) ?? [])]), [docs]);
  const place = id ? placeOf(categories, id) : null;

  const header = (
    <PageHeader
      title="Vertra documentation"
      subtitle="Learn how Vertra runs your teams' products, then use it: run DAGs, keep secrets, publish to the catalog, and install and operate it."
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
      {!id && header}
      <DocSearch />
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "248px minmax(0, 1fr)" },
          gap: { xs: 0, md: 4 },
          alignItems: "start",
        }}
      >
        <Box sx={{ display: { xs: "none", md: "block" }, position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflowY: "auto" }}>
          {docs ? (
            <DocsNav categories={categories} current={id} />
          ) : (
            <Box sx={{ p: 2, display: "flex", justifyContent: "center" }}>
              <CircularProgress size={24} aria-label="Loading" />
            </Box>
          )}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          {docs && <DocsPicker categories={categories} current={id} />}
          {!id && docs && <DocsHome categories={categories} />}
          {id && (
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: "minmax(0, 1fr) 220px" }, gap: 4, alignItems: "start" }}>
              <Box sx={{ minWidth: 0 }}>
                <Breadcrumbs aria-label="Where this is" sx={{ mb: 2, fontSize: 14 }}>
                  <Link component={RouterLink} to="/docs" underline="hover" color="inherit">
                    Docs
                  </Link>
                  {place && <Typography sx={{ fontSize: "inherit" }}>{place.category.title}</Typography>}
                </Breadcrumbs>
                <Card variant="outlined" sx={{ p: { xs: 2, sm: 4 } }}>
                  {id === API_REFERENCE_ID && <ApiReference />}
                  {id !== API_REFERENCE_ID && (loadingContent || !content) && (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                      <CircularProgress size={24} aria-label="Loading" />
                    </Box>
                  )}
                  {id !== API_REFERENCE_ID && !loadingContent && content && (
                    <Box sx={PROSE}>
                      <Served.Provider value={served}>
                        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={MARKDOWN_COMPONENTS}>
                          {content}
                        </Markdown>
                      </Served.Provider>
                    </Box>
                  )}
                </Card>
                {place && <Onward place={place} />}
              </Box>
              {id !== API_REFERENCE_ID && content && <OnThisPage markdown={content} />}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
