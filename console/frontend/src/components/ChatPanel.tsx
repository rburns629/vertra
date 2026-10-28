// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import { ApiError, askChat, type ChatAnswer } from "../api";
import { useAuth } from "../auth/AuthContext";
import { cart, useCart } from "../cart";

type Turn = { role: "user"; content: string } | ({ role: "assistant"; content: string } & Omit<ChatAnswer, "text">);

const TOOL_NAMES: Record<string, string> = {
  search_docs: "searched the docs",
  read_doc_section: "read a doc",
  find_offerings: "looked in the catalog",
  describe_offering: "read an offering",
  list_team_resources: "looked at what the team has",
  get_run: "looked at a run",
  plan_order: "planned the order",
  propose_cart: "filled a cart",
};

function Answer({ turn, onOpenCart }: { turn: Extract<Turn, { role: "assistant" }>; onOpenCart: (c: NonNullable<ChatAnswer["cart"]>) => void }) {
  const looked = [...new Set(turn.steps.map((s) => TOOL_NAMES[s.tool] ?? s.tool))];
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <Box sx={{ "& p": { my: 0.75 }, "& pre": { overflowX: "auto" }, fontSize: 14, lineHeight: 1.55, overflowWrap: "anywhere" }}>
        <Markdown remarkPlugins={[remarkGfm]}>{turn.content}</Markdown>
      </Box>
      {turn.uncited && (
        <Typography variant="caption" color="warning.main">
          Not from the docs: it searched them and cites nothing it found. Check before relying on it.
        </Typography>
      )}
      {turn.citations.length > 0 && (
        <Box component="ol" sx={{ m: 0, pl: 2.5, fontSize: 13 }} aria-label="Sources">
          {turn.citations.map((c) => (
            <li key={c.id}>
              <Link component={RouterLink} to={c.link}>
                [{c.id}] {c.title} · {c.heading}
              </Link>
              {c.kind === "history" && (
                <Typography component="span" variant="caption" color="text.secondary">
                  {" "}
                  (design history: why, not how it works now)
                </Typography>
              )}
            </li>
          ))}
        </Box>
      )}
      {turn.cart && (
        <Card variant="outlined" sx={{ p: 1.5, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography variant="body2" sx={{ flex: "1 1 180px" }}>
            A cart for {turn.cart.team}: {turn.cart.actions.join(", ")}. You make its choices and place the order.
          </Typography>
          <Button size="small" variant="contained" onClick={() => { if (turn.cart) onOpenCart(turn.cart); }}>
            Open in cart
          </Button>
        </Card>
      )}
      {looked.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          It {looked.join(", ")}.
        </Typography>
      )}
    </Box>
  );
}

/**
 * The chat agent's panel (decision 24): ask about Vertra and get answers
 * from its docs (cited, each linked to its section), or say what you need
 * and get a cart to open and place yourself. The conversation is kept on
 * this page only; each question sends it whole (ChatService/Ask keeps
 * nothing).
 */
export function ChatPanel({ model, onClose }: { model: string; onClose: () => void }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const teams = user?.teamNames ?? [];
  const cartTeam = useCart().team;
  const [team, setTeam] = useState<string>(() => (cartTeam && teams.includes(cartTeam) ? cartTeam : (teams[0] ?? "")));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [turns, busy]);

  async function send(): Promise<void> {
    const question = draft.trim();
    if (!question || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: question }];
    setTurns(next);
    setDraft("");
    setBusy(true);
    setError(null);
    try {
      const answer = await askChat(team || null, next.map((t) => ({ role: t.role, content: t.content })));
      setTurns([...next, { role: "assistant", content: answer.text, citations: answer.citations, uncited: answer.uncited, cart: answer.cart, steps: answer.steps }]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't get an answer.");
    } finally {
      setBusy(false);
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Box sx={{ width: { xs: "100vw", sm: 440 }, height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600 }}>Ask Vertra</Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            Answers from the docs and your catalog · {model}
          </Typography>
        </Box>
        <IconButton aria-label="Close" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </Box>
      {teams.length > 1 && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <TextField select size="small" label="For team" value={team} onChange={(e) => { setTeam(e.target.value); }} fullWidth>
            {teams.map((t) => (
              <MenuItem key={t} value={t}>
                {t}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      )}
      <Box sx={{ flexGrow: 1, overflowY: "auto", px: 2, py: 1.5, display: "flex", flexDirection: "column", gap: 2 }} aria-live="polite">
        {turns.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            Ask how something works (&ldquo;how do I give my product a secret?&rdquo;), or say what you need (&ldquo;app hosting on GCP for shop-api&rdquo;):
            it looks in the docs, your catalog and what your team already has, and fills a cart for you to place.
          </Typography>
        )}
        {turns.map((t, i) =>
          t.role === "user" ? (
            <Box key={i} sx={{ alignSelf: "flex-end", bgcolor: "action.selected", px: 1.5, py: 1, borderRadius: 2, maxWidth: "85%", whiteSpace: "pre-wrap", fontSize: 14 }}>
              {t.content}
            </Box>
          ) : (
            <Answer
              key={i}
              turn={t}
              onOpenCart={(c) => {
                cart.replace(c.team, c.actions);
                navigate("/catalog/cart");
                // The cart is the page now; the conversation stays for Ask.
                onClose();
              }}
            />
          ),
        )}
        {busy && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "text.secondary" }}>
            <CircularProgress size={16} />
            <Typography variant="body2">Thinking… a model can take a minute to answer.</Typography>
          </Box>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        <div ref={end} />
      </Box>
      <Box sx={{ p: 1.5, borderTop: 1, borderColor: "divider", display: "flex", gap: 1, alignItems: "flex-end" }}>
        <TextField
          multiline
          maxRows={5}
          size="small"
          fullWidth
          placeholder="Ask, or say what you need"
          slotProps={{ htmlInput: { "aria-label": "Your question", maxLength: 4000 } }}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); }}
          onKeyDown={onKey}
        />
        <Button variant="contained" disabled={busy || !draft.trim()} onClick={() => { void send(); }}>
          Send
        </Button>
      </Box>
    </Box>
  );
}
