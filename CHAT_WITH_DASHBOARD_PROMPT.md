# Master prompt — add "Chat with this dashboard" (grounded Q&A + web search)

Paste everything inside the block below into a fresh Claude Code session opened
on the target dashboard repo. It is stack-agnostic: it makes the agent read that
repo first and then build the same feature in that repo's own style.

---

```
You are adding a "Chat with this dashboard" feature to THIS repo. It already
exists in another dashboard of mine and I want the exact same behaviour here,
adapted to this repo's stack. Do NOT copy another repo's code blindly — read
THIS repo first and build it the way this repo is written.

========================================================
STEP 0 — READ THIS REPO END TO END BEFORE WRITING ANYTHING
========================================================
Figure out and tell me:
- Stack: framework / language, is the frontend static or SSR, is there a build
  step, how is it deployed (Cloudflare Pages/Workers, Vercel, Netlify, etc.).
- Data: what powers each dashboard/screen? Where does its data live (JSON files,
  an API, a DB), and what is its shape? What identifies ONE dashboard (a slug, an
  id, a route param)?
- Server: is there already a backend / serverless function / API route? If it's a
  static-only site, what's the smallest way to add ONE server endpoint on the
  current host (e.g. a Cloudflare Pages Function under /functions, a Next.js route
  handler, an Express route)?
- LLM: is any LLM already called anywhere? Which provider, which key/env var, what
  request shape? REUSE it. If none exists, pick one and document the env var.
- Web search: is there any existing search API / tool / token in the repo? REUSE
  it. If none, use a simple search API and document its key.
Confirm these findings back to me in a few lines before you build.

========================================================
STEP 1 — WHAT TO BUILD
========================================================
A chat panel where a user asks questions in plain English about the CURRENTLY
OPEN dashboard, and gets answers built ONLY from that dashboard's own data, with
clickable source links. Plus a "Search the web" toggle (OFF by default) that,
when ON, blends a few live web results as a SUPPLEMENT (the dashboard data still
leads). Two parts: one backend endpoint + one frontend panel. It must be generic
— work for ANY dashboard in this repo, nothing hard-coded to one.

========================================================
STEP 2 — BACKEND: one endpoint, e.g. POST /api/chat
========================================================
Input: { id/slug (which dashboard), question, history?, web? }.
Do this, in order:
1. Sanitise the id/slug so it can't traverse paths or hit anything outside the
   allowed data (whitelist chars; reject the rest).
2. Load THAT dashboard's own data (same source the UI renders from).
3. Build a compact GROUNDED CONTEXT string from the data: walk every section and
   render its key facts as short lines, and inline each fact's SOURCE URL next to
   it. Trim to a sane budget (~12k tokens / ~48k chars) so it never blows up.
4. Build an ALLOW-LIST of every source URL that appears in that data. This is the
   "never-invent" set.
5. If web === true: call the web search with the user's question, take ~6 results,
   append them to the context under a clearly-labelled "WEB SEARCH RESULTS
   (supplementary only — prefer the dashboard data; use these only to fill gaps or
   add recency)" block, and ADD those result URLs to the allow-list. Never-fail: no
   token / any error → just skip web and answer from the dashboard only.
6. Call the LLM with a strict system prompt (see STEP 3 wording) + the context,
   plus the recent history shaped into alternating user/assistant turns ending on
   the new question.
7. Parse the reply into { answer, sources:[{label,url}] }. Be robust: if it's
   wrapped in prose/fences, slice out the JSON; if JSON fails entirely, use the raw
   text as the answer and recover any allow-list URLs it mentions.
8. NEVER-INVENT: drop any returned source whose URL is not in the allow-list.
   De-dupe. Return { answer, sources }.

========================================================
STEP 3 — THE GROUNDING SYSTEM PROMPT (this is the heart of it)
========================================================
Tell the model, in words like these:
- "You are a research assistant for the '<dashboard name>' dashboard."
- Web OFF: "Answer using ONLY the dashboard data below. Do not use outside
  knowledge. If the answer isn't in the data, say so plainly (e.g. 'The dashboard
  data doesn't cover that.') — never guess or invent figures, names or sources."
- Web ON: "Use the dashboard data as your PRIMARY source. Live web results are
  also provided — use them only to supplement or add recency; no other outside
  knowledge. If neither covers it, say so plainly."
- "Cite the source URL for each claim, drawing the URL only from the provided
  data (or web results)."
- "Write in plain English, concise and direct. Prefer specific numbers from the
  data over vague statements."
- "Return ONLY strict JSON, no prose/fences:
  {\"answer\":\"...\",\"sources\":[{\"label\":\"...\",\"url\":\"...\"}],\"in_data\":true|false}.
  sources lists only what you actually used, URLs copied verbatim. If the answer
  isn't available, set in_data=false and sources=[]."

========================================================
STEP 4 — FRONTEND: a Chat panel in this repo's existing UI style
========================================================
Match how this repo builds UI (its components, its CSS). Add:
- A chat log with a friendly welcome bubble that says it answers from THIS
  dashboard's data and cites sources, and that "Search the web" adds live results.
- An input + Send; posts { id/slug, question, history, web } to the endpoint.
- 3-4 SUGGESTED STARTER questions derived from what data the current dashboard
  actually has (hide them after the first question).
- A "Search the web" toggle, OFF by default, with a hint "off = this dashboard
  only". Its state rides on each request as web:true/false.
- Bot answers render with a row of clickable SOURCE CHIPS (show the source
  label/publisher, open in a new tab).
- Keep conversation history in memory and send prior turns each time (follow-ups).
- If the endpoint is unreachable, show a calm inline message, never a crash.

========================================================
STEP 5 — HARD GUARANTEES (treat as acceptance criteria)
========================================================
1. GROUNDED + CITE-OR-ADMIT: answers only from the dashboard's data; every claim
   cites a source URL; out-of-scope → honest "not in the data".
2. NEVER-INVENT: any source URL not already in the data (or, when web is on, in
   the web results) is stripped before responding.
3. NEVER-FAIL: every error path (no key, bad id, unknown dashboard, LLM down,
   unparseable reply, web-search error) returns a friendly { answer } with HTTP
   200 — never a 500, never a stack trace to the user.
4. GENERIC: works for every dashboard in this repo; nothing hard-coded to one.
5. WEB TOGGLE: off = dashboard-only; on = dashboard-primary + web-supplement.
6. SAFE: the id/slug is sanitised; secrets are read from env, never committed.

========================================================
STEP 6 — TESTS
========================================================
Add small, dependency-free tests for the PURE logic: id/slug safety, that the
context carries real numbers + inline source URLs, the never-invent filter (keeps
a real URL, drops a fake one), out-of-scope → empty sources, and history shaping
(alternating, ends on the user turn). Make them runnable with one command.

========================================================
STEP 7 — CONFIG + DOCS
========================================================
In the README, document the env vars/secrets you used (LLM key + region/model if
relevant, web-search token), where to set them for local dev vs the deployed
host, and note that without the LLM key the chat degrades to a friendly "try
again" message while everything else keeps working.

========================================================
STEP 8 — SHIP IT (deployment must be automated)
========================================================
Wire this up so that once merged, every push to the default branch AUTO-DEPLOYS
via GitHub → Cloudflare Pages, with no manual deploy step ever again. If the
backend needs a server route and we're on Cloudflare Pages, implement it as a
Pages Function (e.g. /functions/api/chat) so it deploys with the site. The ONLY
human action is a ONE-TIME "connect this repo to Cloudflare Pages" (and setting
the secrets once in the Pages project). After that it's automatic forever — do
not ask me to deploy by hand each time; just tell me the one-time setup once.

Now: do STEP 0, confirm your findings, then build STEPS 1-8. Keep everything in
this repo's own style and keep all six guarantees.
```

---

## What this feature is (the version in the source repo)

- **Backend** `POST /api/chat` in the Cloudflare Worker: loads one industry's
  committed JSON, builds a grounded context with each fact's source URL inline,
  optionally blends live Muns web-search results (the `web` toggle), calls Claude
  on Bedrock with a strict "answer only from this data + cite or admit" system
  prompt, then strips any source URL not present in the data before returning
  `{ answer, sources }`. Every error path returns a friendly 200.
- **Frontend** `renderChat` in `public/js/app.js`: a Chat tab with starter
  questions, a "Search the web" toggle (off by default), source chips under each
  answer, and in-memory history for follow-ups.
- **Key files to look at if porting by hand:** `worker/index.js`
  (`handleChat`, `buildContext`, `collectSources`, `parseAnswer`, `munsWebSearch`,
  `callBedrock`), `public/js/app.js` (`renderChat`, `sendChat`, `sourceChip`),
  `public/index.html` (chat styles + `#panel-chat`), `scripts/test-chat.mjs`.
