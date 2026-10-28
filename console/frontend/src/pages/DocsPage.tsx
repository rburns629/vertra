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
import { DocFigure, FigureLink, figurePath } from "./docs/Figure";
import { contentsOf, docTarget, isSplit, pageOf, pagesOf, placeOf, sectionHolding, sectionsOf, slug, START_HERE, trailOf, type Category, type Group, type Node, type Page } from "./docs/contents";

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

/** The docs the console serves, and the one open: what links between docs and to a section resolve against. */
const Served = createContext<{ ids: ReadonlySet<string>; doc: string }>({ ids: new Set(), doc: "" });

/**
 * A link from one doc to another is written as the repository has it
 * ("security-model.md", "../setup.md", "clouds/gcp.md#…"). It goes to the
 * same doc here (docTarget), through react-router: a full navigation to
 * /docs/<id> would reach the backend's own GET /docs/:id (raw markdown),
 * not the app. A doc the console doesn't serve (TODO.md, the kernel's)
 * stays as its words, not a link to nowhere. A "#section" link to a part
 * of a long doc that's on another of its pages goes there (DocsPage finds
 * which); one on this page, and external links, are plain <a>s.
 */
function DocLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const navigate = useNavigate();
  const { ids, doc } = useContext(Served);
  if (href?.startsWith("#")) {
    return (
      <a
        href={href}
        onClick={(event) => {
          if (document.getElementById(decodeURIComponent(href.slice(1)))) return;
          event.preventDefault();
          void navigate(`/docs/${doc}${href}`);
        }}
      >
        {children}
      </a>
    );
  }
  const figure = figurePath(href);
  if (figure) return <FigureLink path={figure}>{children}</FigureLink>;
  if (!href || !/^[^:]*\.md(#|$)/.test(href)) return <a href={href}>{children}</a>;
  const to = docTarget(href, ids);
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

/** An image in a doc: a figure the docs draw, fetched through the API; anything else as written. */
function DocImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const path = typeof src === "string" ? figurePath(src) : null;
  if (path) return <DocFigure path={path} alt={alt ?? ""} />;
  return <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />;
}

/** A paragraph, except one that's only an image: that's a figure, which a <p> can't hold. */
function Paragraph({ node, children }: { node?: { children: { type: string; tagName?: string; value?: string }[] }; children?: React.ReactNode }) {
  const parts = node?.children.filter((c) => c.type !== "text" || c.value?.trim()) ?? [];
  if (parts.length === 1 && parts[0]?.tagName === "img") return <>{children}</>;
  return <p>{children}</p>;
}

const MARKDOWN_COMPONENTS: Components = {
  img: DocImage,
  p: Paragraph,
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


const linkTo = (p: Page) => `/docs/${p.doc}${p.section ? `/${p.section}` : ""}`;

interface Opened {
  current: string | undefined;
  open: Set<string>;
  toggle: (key: string) => void;
}

/** A group in the contents: its name opens and closes it, its pages and groups indented under it. */
function NavGroup({ group, depth, ...opened }: Opened & { group: Group; depth: number }) {
  const expanded = opened.open.has(group.key);
  return (
    <Box component="li" sx={{ listStyle: "none" }}>
      <ListItemButton onClick={() => { opened.toggle(group.key); }} aria-expanded={expanded} sx={{ borderRadius: 1, py: 0.25, pl: 0.5 }}>
        <ExpandMoreIcon fontSize="small" sx={{ mr: 0.5, color: "text.secondary", transition: "transform .15s", transform: expanded ? "none" : "rotate(-90deg)" }} />
        <ListItemText primary={group.label} slotProps={{ primary: { sx: { fontWeight: 600, color: "text.primary", fontSize: 13.5 } } }} />
      </ListItemButton>
      <Collapse in={expanded} unmountOnExit>
        <NavNodes nodes={group.children} depth={depth + 1} {...opened} />
      </Collapse>
    </Box>
  );
}

function NavNodes({ nodes, depth, ...opened }: Opened & { nodes: Node[]; depth: number }) {
  return (
    <List dense disablePadding sx={depth > 0 ? { ml: 1.5, pl: 0.75, borderLeft: 1, borderColor: "divider" } : undefined}>
      {nodes.map((n) =>
        n.kind === "group" ? (
          <NavGroup key={n.key} group={n} depth={depth} {...opened} />
        ) : (
          <ListItemButton
            key={n.key}
            component={RouterLink}
            to={linkTo(n)}
            selected={n.key === opened.current}
            aria-current={n.key === opened.current ? "page" : undefined}
            sx={{ borderRadius: 1, py: 0.25, pl: 1, color: "text.secondary", "&.Mui-selected": { color: "primary.main", fontWeight: 600 } }}
          >
            <ListItemText
              primary={n.label}
              secondary={n.history && !/history/i.test(n.label) ? "Design history" : undefined}
              slotProps={{ primary: { sx: { fontWeight: "inherit", fontSize: 13.5 } } }}
            />
          </ListItemButton>
        ),
      )}
    </List>
  );
}

/**
 * The contents down the side, nested: each category a heading, then its
 * docs and groups (a long doc is a group of its sections, some of those
 * grouped again). Each opens and closes; the way to the page you're on
 * is open.
 */
function DocsNav({ categories, current }: { categories: Category[]; current: string | undefined }) {
  const way = useMemo(() => {
    for (const c of categories) {
      const trail = current ? trailOf(c.children, current) : null;
      if (trail) return [`category:${c.id}`, ...trail.map((g) => g.key)];
    }
    return [];
  }, [categories, current]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(way));
  useEffect(() => {
    setOpen((was) => (way.every((k) => was.has(k)) ? was : new Set([...was, ...way])));
  }, [way]);
  const toggle = (key: string) => {
    setOpen((was) => {
      const now = new Set(was);
      if (now.has(key)) now.delete(key);
      else now.add(key);
      return now;
    });
  };
  return (
    <List component="nav" aria-label="Docs contents" dense disablePadding>
      <ListItemButton component={RouterLink} to="/docs" selected={!current} aria-current={!current ? "page" : undefined} sx={{ borderRadius: 1, mb: 1 }}>
        <ListItemText primary="Docs home" slotProps={{ primary: { sx: { fontWeight: 600 } } }} />
      </ListItemButton>
      {categories.map((c) => {
        const key = `category:${c.id}`;
        const expanded = open.has(key);
        return (
          <Box component="li" key={c.id} sx={{ listStyle: "none", mb: 0.5 }}>
            <ListItemButton onClick={() => { toggle(key); }} aria-expanded={expanded} sx={{ borderRadius: 1 }}>
              <ListItemText primary={c.title} slotProps={{ primary: { sx: { fontWeight: 700, color: "text.primary" } } }} />
              <ExpandMoreIcon fontSize="small" sx={{ color: "text.secondary", transition: "transform .15s", transform: expanded ? "rotate(180deg)" : "none" }} />
            </ListItemButton>
            <Collapse in={expanded} unmountOnExit>
              <NavNodes nodes={c.children} depth={0} current={current} open={open} toggle={toggle} />
            </Collapse>
          </Box>
        );
      })}
    </List>
  );
}

/** On a phone, the contents as one list to choose from, indented as they nest. */
function DocsPicker({ categories, current }: { categories: Category[]; current: string | undefined }) {
  const navigate = useNavigate();
  const options = (nodes: Node[], depth: number): React.ReactNode[] =>
    nodes.flatMap((n) => {
      const indent = "   ".repeat(depth);
      return n.kind === "page"
        ? [<option key={n.key} value={linkTo(n)}>{indent + n.label}</option>]
        : [<option key={n.key} disabled>{indent + n.label}</option>, ...options(n.children, depth + 1)];
    });
  const here = categories.flatMap((c) => pagesOf(c.children)).find((p) => p.key === current);
  return (
    <TextField
      select
      label="Doc"
      size="small"
      value={here ? linkTo(here) : "/docs"}
      onChange={(event) => { void navigate(event.target.value); }}
      slotProps={{ select: { native: true } }}
      sx={{ display: { md: "none" }, bgcolor: "background.paper", mb: 2 }}
      fullWidth
    >
      <option value="/docs">Docs home</option>
      {categories.map((c) => (
        <optgroup key={c.id} label={c.title}>
          {options(c.children, 0)}
        </optgroup>
      ))}
    </TextField>
  );
}

/** The docs' home: where to start, in order, and each category with what's in it. */
function DocsHome({ categories }: { categories: Category[] }) {
  const pages = new Map(categories.flatMap((c) => pagesOf(c.children).map((p) => [p.key, p])));
  const path = START_HERE.flatMap((id) => pages.get(id) ?? []);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {path.length > 0 && (
        <Box component="section" aria-labelledby="start-here">
          <Typography id="start-here" variant="h6" component="h2" sx={{ mb: 1.5 }}>
            Start here
          </Typography>
          <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr", lg: `repeat(${String(path.length)}, 1fr)` } }}>
            {path.map((p, i) => (
              <li key={p.key}>
                <Card variant="outlined" sx={{ height: "100%", "&:hover": { borderColor: "primary.main" } }}>
                  <CardActionArea component={RouterLink} to={linkTo(p)} sx={{ p: 2, height: "100%", display: "flex", alignItems: "flex-start", justifyContent: "flex-start", gap: 1.5 }}>
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
                      <Typography sx={{ fontWeight: 600 }}>{p.label}</Typography>
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
                {c.children.map((n) => {
                  // A group leads to its first page, and says how many it holds.
                  const all = n.kind === "page" ? [n] : pagesOf(n.children);
                  const first = all[0];
                  if (!first) return null;
                  return (
                    <li key={n.key}>
                      <Link component={RouterLink} to={linkTo(first)} underline="hover" variant="body2" sx={{ fontWeight: 500 }}>
                        {n.label}
                      </Link>
                      {all.length > 1 && (
                        <Typography component="span" variant="caption" color="text.secondary">
                          {` · ${String(all.length)} pages`}
                        </Typography>
                      )}
                    </li>
                  );
                })}
              </Box>
            </Card>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/** What a page is called on its own: a section by its name, a long doc's overview by the doc's. */
const nameOf = (p: Page, groups: Group[]) => (p.section || groups.length === 0 ? p.label : (groups.at(-1)?.label ?? p.label));

/** Previous and next in reading order, at the foot of a page. */
function Onward({ place }: { place: NonNullable<ReturnType<typeof placeOf>> }) {
  const card = (to: { page: Page; category: Category } | undefined, way: "Previous" | "Next") => {
    if (!to) return <Box />;
    const groups = trailOf(to.category.children, to.page.key) ?? [];
    const where = groups.length > 0 && to.page.section ? `${to.category.title} › ${groups[0]?.label ?? ""}` : to.category.title;
    return (
      <Card variant="outlined" sx={{ "&:hover": { borderColor: "primary.main" } }}>
        <CardActionArea component={RouterLink} to={linkTo(to.page)} sx={{ p: 2, textAlign: way === "Next" ? "right" : "left" }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "flex", alignItems: "center", gap: 0.5, justifyContent: way === "Next" ? "flex-end" : "flex-start" }}>
            {way === "Previous" && <ArrowBackIcon sx={{ fontSize: 14 }} />}
            {way} · {where}
            {way === "Next" && <ArrowForwardIcon sx={{ fontSize: 14 }} />}
          </Typography>
          <Typography sx={{ fontWeight: 600, color: "primary.main" }}>{nameOf(to.page, groups)}</Typography>
        </CardActionArea>
      </Card>
    );
  };
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
  const { id, section } = useParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
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

  // A doc is fetched once, whichever of its pages is open.
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

  const categories = useMemo(() => (docs ? contentsOf(docs) : []), [docs]);
  const served = useMemo(() => ({ ids: new Set([API_REFERENCE_ID, ...(docs?.map((d) => d.id) ?? [])]), doc: id ?? "" }), [docs, id]);
  const split = !!id && isSplit(categories, id);
  const place = id ? placeOf(categories, id, split ? section : undefined) : null;
  const current = id ? (split && section ? `${id}/${section}` : id) : undefined;
  // What this page shows: a long doc's one section, or a doc whole.
  const shown = !docs || content === null ? null : split ? pageOf(content, section) : content;
  // "On this page" takes a column only when there's a list for it; without one the page has the width (a figure's drawn full size).
  const aside = id !== API_REFERENCE_ID && !!shown && sectionsOf(shown).length >= 2;

  // A link into a long doc by a heading's anchor (search, the chat agent's
  // sources, a link between docs) opens the page that heading is on; one to
  // a section of a doc shown whole opens the doc.
  useEffect(() => {
    if (!id || !docs || content === null) return;
    if (!split && section) {
      void navigate(`/docs/${id}${hash}`, { replace: true });
      return;
    }
    if (split && !section && hash) {
      const holding = sectionHolding(content, decodeURIComponent(hash.slice(1)));
      if (holding) void navigate(`/docs/${id}/${holding}${hash === `#${holding}` ? "" : hash}`, { replace: true });
    }
  }, [id, section, hash, docs, content, split, navigate]);

  // A new page opens at its top, or at the heading it was linked to.
  useEffect(() => {
    if (shown === null) return;
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    // (Optional calls: a test's DOM has neither.)
    if (target) target.scrollIntoView?.();
    else window.scrollTo?.(0, 0);
  }, [shown, hash]);

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
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "264px minmax(0, 1fr)" },
          gap: { xs: 0, md: 4 },
          alignItems: "start",
        }}
      >
        <Box sx={{ display: { xs: "none", md: "block" }, position: "sticky", top: 16, maxHeight: "calc(100vh - 32px)", overflowY: "auto", pr: 0.5 }}>
          {docs ? (
            <DocsNav categories={categories} current={current} />
          ) : (
            <Box sx={{ p: 2, display: "flex", justifyContent: "center" }}>
              <CircularProgress size={24} aria-label="Loading" />
            </Box>
          )}
        </Box>
        <Box sx={{ minWidth: 0 }}>
          {docs && <DocsPicker categories={categories} current={current} />}
          {!id && docs && <DocsHome categories={categories} />}
          {id && (
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: aside ? "minmax(0, 1fr) 220px" : "minmax(0, 1fr)" }, gap: 4, alignItems: "start" }}>
              <Box sx={{ minWidth: 0 }}>
                <Breadcrumbs aria-label="Where this is" sx={{ mb: 2, fontSize: 14 }}>
                  <Link component={RouterLink} to="/docs" underline="hover" color="inherit">
                    Docs
                  </Link>
                  {place && <Typography sx={{ fontSize: "inherit" }}>{place.category.title}</Typography>}
                  {place?.groups.map((g) => {
                    const first = pagesOf(g.children)[0];
                    return first && first.key !== place.page.key ? (
                      <Link key={g.key} component={RouterLink} to={linkTo(first)} underline="hover" color="inherit">
                        {g.label}
                      </Link>
                    ) : (
                      <Typography key={g.key} sx={{ fontSize: "inherit" }}>
                        {g.label}
                      </Typography>
                    );
                  })}
                </Breadcrumbs>
                <Card variant="outlined" sx={{ p: { xs: 2, sm: 4 } }}>
                  {id === API_REFERENCE_ID && <ApiReference />}
                  {id !== API_REFERENCE_ID && (loadingContent || !docs || content === null) && (
                    <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                      <CircularProgress size={24} aria-label="Loading" />
                    </Box>
                  )}
                  {id !== API_REFERENCE_ID && !loadingContent && docs && content !== null && shown === null && (
                    <Alert severity="info">
                      This doc has no such section now. <Link component={RouterLink} to={`/docs/${id}`}>Its first page</Link> lists what it has.
                    </Alert>
                  )}
                  {id !== API_REFERENCE_ID && !loadingContent && shown !== null && (
                    <Box sx={PROSE}>
                      <Served.Provider value={served}>
                        <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={MARKDOWN_COMPONENTS}>
                          {shown}
                        </Markdown>
                      </Served.Provider>
                      {split && !section && place && <SectionList place={place} />}
                    </Box>
                  )}
                </Card>
                {place && <Onward place={place} />}
              </Box>
              {aside && shown && <OnThisPage markdown={shown} />}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

/** A long doc's first page ends with what's in it: its pages, as the contents group them. */
function SectionList({ place }: { place: NonNullable<ReturnType<typeof placeOf>> }) {
  const doc = place.groups.at(-1);
  if (!doc) return null;
  const list = (nodes: Node[]): React.ReactNode => (
    <ul>
      {nodes.map((n) =>
        n.kind === "page" ? (
          n.section ? (
            <li key={n.key}>
              <Link component={RouterLink} to={linkTo(n)}>
                {n.label}
              </Link>
            </li>
          ) : null
        ) : (
          <li key={n.key}>
            <strong>{n.label}</strong>
            {list(n.children)}
          </li>
        ),
      )}
    </ul>
  );
  return (
    <>
      <h2 id="in-this-doc">In this doc</h2>
      {list(doc.children)}
    </>
  );
}
