# Industry Research Dashboard

A generic, **source-backed** web dashboard that shows everything gathered about an
**industry** from the open internet — presented visually. Type an industry name
(e.g. _MDF boards_) and the dashboard renders its market size, segments, drivers,
value chain, players, supply/trade, plus YouTube, reports, news and a chat panel.

It is **industry-agnostic**: every screen is driven by a committed JSON file per
industry. The frontend holds no data of its own — drop in a new
`public/data/industries/<slug>.json` and it renders with **zero code changes**.

> **Status:** Scaffold with **mock data** (MDF, India). No scraping or external
> APIs yet — those arrive in later steps. The single MDF file is flagged
> `"mock": true`.

---

## Tech stack

| Layer      | Choice                                                        |
| ---------- | ------------------------------------------------------------ |
| Frontend   | Static `public/index.html` + `public/js/app.js` — plain JS, no framework, no build step |
| Styling    | Tailwind (CDN) + a small `<style>` block of design tokens    |
| Fonts      | Inter (UI/body) + Plus Jakarta Sans (headings) via Google Fonts |
| Charts     | Chart.js v4 (CDN) — bar / horizontal bar / stacked / doughnut / line-area only |
| Data       | Committed JSON per industry under `public/data/industries/`  |
| Backend    | `worker/index.js` — a Cloudflare Worker serving `./public` + a grounded `POST /api/chat` route |

---

## Project structure

```
.
├── public/
│   ├── index.html                     # App shell: top bar, tabs, panels
│   ├── js/
│   │   └── app.js                     # Small render functions, one per section
│   └── data/
│       └── industries/
│           ├── index.json             # List of available industries + default
│           └── mdf.json               # Mock MDF (India) data — "mock": true
├── lib/
│   ├── llm.mjs                        # The ONLY place we call Claude (Bedrock, raw HTTPS)
│   ├── muns.mjs                       # Muns fastapi wrappers (search / news / reader)
│   └── scrape.mjs                     # Firecrawl / Scrape.do / Mistral-OCR fetchers
├── scripts/
│   ├── test-bedrock.mjs               # Bedrock connectivity check
│   └── research-industry.mjs          # Deep-research pipeline → fills <slug>.json
├── .github/workflows/
│   ├── test-bedrock.yml               # Manual: validate Bedrock key/region/model
│   └── research-industry.yml          # Manual: run research + commit data
├── worker/
│   └── index.js                       # Serves ./public + POST /api/chat stub
├── wrangler.jsonc                     # Worker + static-assets config
├── package.json                       # `npm run dev` → wrangler dev
├── .gitignore
└── README.md
```

---

## Running locally

**Option A — full site (recommended, enables Chat):**

```bash
npm install
npm run dev        # → wrangler dev, serves ./public and the /api/chat route
```

Then open the URL Wrangler prints (usually `http://localhost:8787`).

For Chat to return **answers** locally (not just the friendly "try again" message)
the Worker needs a Bedrock key. Put it in a git-ignored `.dev.vars` file at the
repo root:

```
BEDROCK_API_KEY=your-bedrock-api-key
# optional overrides:
# BEDROCK_REGION=us-east-1
# BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-5
```

`wrangler dev` loads `.dev.vars` automatically. Without a key, every other route
still works and Chat degrades gracefully.

**Option B — quick look (no Worker):** open `public/index.html` in a browser, or
serve the folder with any static server (e.g. `npx serve public`). Everything
renders except the Chat tab, which needs the Worker route.

---

## Tabs

1. **Deep Research** — the core view, split into sub-tabs so it never becomes one
   long scroll: _Overview_ (headline, takeaways, market size, segments),
   _Growth & dynamics_ (drivers, tailwinds vs headwinds), _Value chain & channels_,
   _Players & supply_ (players table, market-share doughnut, optional Supply &
   Trade block), and _Full report_ (collapsible written summary).
2. **Report** — a consolidated, source-backed **written report** generated from the
   assembled data: section-by-section prose with highlighted key numbers, the
   dashboard charts embedded inline, per-section source chips, a "data as of"
   freshness line, and a Sources appendix. A **Download PDF** button prints it to a
   clean A4 hand-out (nav/tabs/controls hidden, charts kept).
3. **YouTube** — grid of relevant video cards.
4. **Reports** — broker / industry / policy reports.
5. **News** — recent headlines with sentiment badges.
6. **Chat** — ask questions about the current industry in plain English. The
   Worker answers **only** from that industry's gathered data, **cites the source
   URL** for each claim, and says "not in the data" rather than guessing when a
   question is out of scope. Suggested starter questions get you going; answers
   show source chips beneath them. See [Chat backend](#chat-backend-apichat).

Every fact with a source shows a small clickable **source chip**. Any empty or
missing JSON field is hidden gracefully — no blank boxes, no `undefined`.

A **freshness + coverage strip** under the header shows how current and how
complete the data is — two independent axes, never merged: a relative "Updated N
ago", a coverage meter (`filled / expected` sections), and a freshness dot driven
by the stalest material figure. Each section card carries an **"as of &lt;year&gt;"**
chip (coloured by how fast that section ages) and a **source-count** chip, and any
expected-but-missing section is listed as **"Still gathering"** rather than hidden.
All of it is computed from `meta.coverage` + `meta.updated_at`, which the pipeline
writes automatically.

---

## Data contract

Each industry lives at `public/data/industries/<slug>.json`. All rendering is
generic and defensive: sections render only when present, in a fixed order.

```jsonc
{
  "meta":     { "slug", "name", "aliases": [], "definition", "is_manufacturing", "generated_at", "updated_at", "mock",
                "coverage": { "sections": { "<section>": { "sources", "confidence", "as_of" } } } },
  "summary":  { "headline", "key_takeaways": ["…"], "report_markdown": "## …" },
  "size":     { "current": { "value", "unit", "year" }, "cagr_pct", "history": [ { "year", "value" } ], "source": {} },
  "segments": [ { "name", "share_pct", "note", "source": {} } ],
  "growth_drivers": [ { "title", "detail", "source": {} } ],
  "tailwinds":      [ { "point", "source": {} } ],
  "headwinds":      [ { "point", "source": {} } ],
  "value_chain":    [ { "stage", "description", "margin_note", "source": {} } ],
  "channels":       [ { "channel", "share_pct", "source": {} } ],
  "players":        [ { "name", "listed", "ticker", "segment", "revenue", "revenue_unit", "revenue_year", "ebitda_margin_pct", "market_share_pct", "note", "source": {} } ],
  "margins":  { "manufacturer_pct", "retailer_pct", "notes", "source": {} },
  "quant":    { "capacity": [ { "player", "region", "capacity", "unit", "year" } ], "utilisation_pct", "imports": [ { "year", "volume", "unit" } ], "duty": [ { "country", "note" } ], "source": {} },
  "sources": {
    "reports": [ { "title", "publisher", "date", "url", "type", "summary" } ],
    "youtube": [ { "title", "channel", "url", "published", "why_relevant", "thumbnail" } ],
    "news":    [ { "title", "publisher", "date", "url", "sentiment", "snippet" } ]
  }
}
```

- Every fact object may carry `source: { label, url, snippet? }`. If `url` is
  missing, the source chip is simply omitted.
- The **`quant`** block (capacity / utilisation / imports / duty) is optional and
  renders only when present — most non-manufacturing industries won't have it.
- Add a new industry by dropping in its JSON file and adding an entry to
  `index.json`. No JavaScript changes required.

---

## Design notes

- **Colorful but coordinated:** a categorical chart palette (violet / sky /
  emerald / amber / rose / teal / indigo / pink) is defined once as CSS variables
  (`--chart-1…8`) and reused across every chart, legend and accent. Primary accent
  is indigo/violet.
- **Consistent type scale;** all numbers use `tabular-nums` so columns align.
- **Visual-heavy:** charts and clean tables over walls of text.
- **Never breaks:** tables scroll horizontally inside their own container; the page
  body never scrolls sideways; chart value labels are drawn with padding so they
  don't clip.

---

## Data pipeline (research)

Real, source-backed data is gathered by a manually-triggered GitHub Action that
fills the **same** industry JSON schema: the Deep Research / Overview data (size,
growth, segments, value chain, channels, players, margins, and — for
manufacturing — capacity/imports) plus the **news**, **YouTube** and **reports**
source tabs.

**Pieces:**

- `lib/llm.mjs` — the only place we call Claude. Uses Claude on **AWS Bedrock**
  via raw HTTPS (`bedrock-runtime.<region>.amazonaws.com/model/<model>/invoke`),
  authenticated with a Bedrock API key as a bearer token. No npm dependencies.
- `lib/muns.mjs` — wrappers for the Muns fastapi tools (`web-search`,
  `news-search`, `web-reader`) with defensive normalizers and continue-on-error.
- `lib/scrape.mjs` — richer fetchers: **Firecrawl** (clean markdown),
  **Scrape.do** (rendered HTML fallback / JS-heavy pages like YouTube results),
  and **Mistral OCR** (PDF → text). Same defensive/continue-on-error discipline.
- `scripts/research-industry.mjs` — builds a checklist of queries, searches +
  reads generic web pages **and** broker / industry / government **report PDFs**
  (OCR via Mistral, falling back to Firecrawl when OCR can't fetch the PDF) so
  segments, value chain, channels, margins and player market share have quotable
  numbers. Also discovers YouTube videos and report candidates and fills the
  **YouTube** and **Reports** tabs. Every fact carries a
  `source: {label, url, snippet}` with a supporting quote. The **News** tab is
  filled from the Muns news API, and — because that index is sparse for niche
  industries — falls back to news-outlet hits among the web results plus
  company-specific queries once the player list is known.

  Two design rules drive it:

  - **Never fail.** Every external call (Muns, Firecrawl, Scrape.do, Mistral,
    Bedrock) retries with backoff and then skips-and-continues — one bad source
    can't crash the run. Partial data is fine: whatever was gathered is always
    written and committed. The run aborts (writing nothing) *only* if literally
    nothing at all was gathered.
  - **Maximum data, no trimming.** Every report and page is read in **full** and,
    if large, **chunked** so nothing is skipped. Extraction is a two-stage
    map-reduce: **Stage A** distils each source/chunk into a small list of clean
    checklist facts with one focused Claude call per piece (a failed piece is
    skipped, the rest kept); **Stage B** fills the schema from all the distilled
    facts plus search/news snippets. Because Stage A compacts everything first,
    Stage B always gets a small, clean input no matter how much raw text was read.
  - **Additive & incremental (only-improve).** The dashboard JSON is a *derived*
    artifact. The source of truth is an append-only **fact ledger**
    (`data/store/<slug>/facts.jsonl`) that accumulates every fact with provenance,
    first/last-seen and a corroboration count; a content-addressed **cache**
    (`data/cache/<slug>/`) skips re-fetching and re-extracting unchanged sources,
    so re-runs cost few or no model calls. Assembly is **write-if-better**: a
    section is only replaced when the new one is at least as strong, so a weaker
    run can never blank or regress a filled section — the output only holds or
    improves. Confidence is noisy-OR over *distinct* sources
    (`1 − Π(1 − quality_i)`). Seed the ledger from an existing file with
    `node scripts/migrate-store.mjs <slug>`; the pipeline also auto-seeds on the
    first run. Guarantees are covered by `node scripts/test-store.mjs`.
  - **Consolidated report (derived, cached).** After assembly, one Bedrock call
    (`lib/report.mjs`) writes a structured, section-by-section report grounded
    **only** in the assembled facts (every source_ref must already exist in the
    data — invented ones are dropped). It's **cached** by a hash of the fields it
    depends on (news refreshes don't count), so warm runs don't re-pay; on failure
    the previous report is kept, or a **deterministic** template report (pure
    restatement of the data) is produced, so there is always a report. Seed one
    from existing data with `node scripts/seed-report.mjs <slug>`; guarantees are
    covered by `node scripts/test-report.mjs`.

**Required GitHub secrets:**

| Secret | Purpose | Default if unset |
| --- | --- | --- |
| `BEDROCK_API_KEY` | Bedrock API key (bearer token) — **required** | — (errors) |
| `BEDROCK_REGION` | Bedrock region | `us-east-1` |
| `BEDROCK_MODEL_ID` | Model id | `us.anthropic.claude-sonnet-5` |
| `MUNS_TOKEN` | Muns fastapi bearer token | — (research only) |
| `FIRECRAWL_API_KEY` | Firecrawl scrape (report pages) | — (skipped if unset) |
| `SCRAPEDO_API_KEY` | Scrape.do rendered HTML (YouTube, fallback) | — (skipped if unset) |
| `MISTRAL_API_KEY` | Mistral OCR (report PDFs) | — (skipped if unset) |

**How to run (GitHub → Actions):**

1. **Test Bedrock** — validates the key/region/model. If it fails, set
   `BEDROCK_REGION` to your key's region and/or `BEDROCK_MODEL_ID` to one of
   `us.anthropic.claude-sonnet-5`, `anthropic.claude-sonnet-5`,
   `us.anthropic.claude-opus-4-8`, `anthropic.claude-opus-4-8`.
2. **Research Industry (full rebuild)** — enter an industry (default
   `MDF boards, India`). It writes `public/data/industries/<slug>.json`, updates
   `index.json` + the fact store, and commits to the default branch.

**Automated refresh (two tiers, off one committed `sources.json`):**

- **Refresh Recency** (`.github/workflows/refresh-recency.yml`) — a fast, cheap
  pass every ~4h that appends only **news** newer than each source's watermark
  (no LLM, no rebuild). Recency backbone is free and ToS-clean: Google News RSS,
  GDELT, publisher RSS (ET / Moneycontrol / PIB) filtered by industry keyword +
  player names, with change-detection via feed dates + HTTP conditional GET.
- **Research Industry (full rebuild)** — also runs **weekly** (`Mon 03:00 UTC =
  08:30 IST`) to re-derive the analytical sections; because the pipeline is
  incremental + write-if-better, the weekly run is cheap and only-improves.

Both write jobs share a `concurrency` group with `cancel-in-progress: false`
(queue, never cancel) and commit with rebase-pull-push + a true no-op when nothing
changed. Cron times are **UTC** (IST is +5:30). `sources.json` also documents the
sources deliberately kept **out** of automation: NSE (blocks cloud IPs — prefer
BSE), and Screener / Trendlyne / Tickertape (ToS forbids scraping).

All workflows use Node 22 with no `npm install` (global `fetch` + stdlib only).
Guarantees for the store and the feed parsers are covered by
`node scripts/test-store.mjs` and `node scripts/test-feeds.mjs`.

---

## Chat backend (`/api/chat`)

The **Chat** tab is a grounded, source-backed Q&A over one industry's committed
data — it runs in the Cloudflare **Worker** (`worker/index.js`), not the research
pipeline, and touches no scraping.

**How it works.** `POST /api/chat` accepts `{ slug, question, history? }`. The
Worker:

1. Loads `public/data/industries/<slug>.json` from static assets
   (`env.ASSETS.fetch`). The slug is sanitised (`[a-z0-9-]` only) so it can't
   escape the industries directory.
2. Builds a compact **grounded context** from the assembled data — summary, and
   the key facts per section with each fact's **source URL inline** — trimmed to a
   token budget.
3. Calls Claude on Bedrock (raw HTTPS + bearer token, the same shape as
   `lib/llm.mjs`) with a system prompt that says: *answer using ONLY this data,
   cite the source URL for each claim, and if the answer isn't in the data say so
   — never guess.*
4. Returns `{ answer, sources: [{label, url}] }`.

**Guarantees (same spirit as the rest of the app):**

- **Grounded + cite-or-admit** — answers come only from the loaded data; every
  claim is asked to cite a source URL; out-of-scope questions get an honest
  "not in the data".
- **Never-invent** — any source the model returns whose URL is **not already in
  the data** is dropped before the response is sent.
- **Never-fail** — every error path (no key, bad slug, unknown industry, Bedrock
  down, unparseable reply) returns a friendly `{ answer }` with HTTP 200, never a
  500.
- **Generic** — works for any industry present in `index.json`; nothing is
  hard-coded to MDF.

Covered by `node scripts/test-chat.mjs` (pure logic: grounding, never-invent,
slug safety, history shaping) and `node scripts/test-chat-worker.mjs` (the full
`fetch` handler with mocked assets + Bedrock).

### Worker secrets (set these on the deployed Worker)

The Chat backend reads its Bedrock config from the **Worker** environment. These
are **Cloudflare Worker secrets — separate from the GitHub Actions secrets** used
by the research pipeline. Setting them in GitHub does **not** make them available
to the deployed Worker, and vice-versa; the Chat tab stays in its friendly
"try again" state until the Worker has `BEDROCK_API_KEY`.

| Worker var | Purpose | Default if unset |
| --- | --- | --- |
| `BEDROCK_API_KEY` | Bedrock API key (bearer token) — **required for Chat** | — (Chat returns the friendly fallback) |
| `BEDROCK_REGION` | Bedrock region | `us-east-1` |
| `BEDROCK_MODEL_ID` | Model id | `us.anthropic.claude-sonnet-5` |

**Set the secret (CLI):**

```bash
# from the repo root, against the deployed Worker:
npx wrangler secret put BEDROCK_API_KEY
# paste the key when prompted. Optional overrides:
npx wrangler secret put BEDROCK_REGION      # e.g. us-east-1
npx wrangler secret put BEDROCK_MODEL_ID    # e.g. us.anthropic.claude-sonnet-5
```

**Set the secret (Cloudflare dashboard):** Workers &amp; Pages → your Worker
(`industry-research-dashboard`) → **Settings → Variables and Secrets** → add
`BEDROCK_API_KEY` as an **encrypted** secret (and, if needed, `BEDROCK_REGION` /
`BEDROCK_MODEL_ID` as plain variables) → **Deploy**.

**Local dev:** put the same keys in a git-ignored `.dev.vars` file (see
[Running locally](#running-locally)); `wrangler dev` loads it automatically.

---

## Smart Input (`/api/resolve` + `/api/research`)

The search box accepts an **industry name OR a company name**, and handles an
industry that hasn't been researched yet.

**`POST /api/resolve` `{ query }`** — resolves intent:

1. Normalises the query and matches it against `index.json` (exact + fuzzy, real
   entries preferred over mock). A hit returns `{ type:"industry", slug,
   matched:true }` and the dashboard loads it.
2. Otherwise Claude classifies it as a **company** or an **industry**; for a
   company it infers the primary industry as a short canonical name. The inferred
   industry is re-checked against the index (a company may map to an industry we
   already have). Returns `{ type, company?, industry_name, slug, matched:false }`.
3. **Never-fail** — on any error (including no Bedrock key) it treats the raw
   query as a literal industry name. When the Worker is unreachable (opening the
   file directly), the frontend falls back to a local index match.

When nothing matches, the UI shows a small card — *"We haven't researched
&lt;industry&gt; yet"* (plus *"Detected industry for &lt;company&gt;:
&lt;industry&gt;"* when it came from a company) — with a **Research it** button.

**`POST /api/research` `{ industry }`** (optional) — dispatches the existing
**Research Industry (full rebuild)** GitHub workflow via `workflow_dispatch`
(`inputs.industry`), then the frontend polls `data/industries/<slug>.json` every
~20s and loads it when it appears. If the GitHub token isn't configured, it
returns clear **manual steps** instead — the button never dead-ends.

Covered by `node scripts/test-resolve.mjs` (pure: slug parity with the pipeline,
index matching, real-over-mock) and `node scripts/test-resolve-worker.mjs` (the
full handlers with mocked assets + Bedrock + the GitHub dispatch API).

### Recent runs + Refresh

A **Recent** button next to the search box opens a dropdown of every researched
industry (from `index.json` + each file's `meta`) — name, when it was last
researched/updated, coverage, and, per browser, when *you* last viewed it —
newest first. Click a row to open it. Each row, and the loaded industry header,
carries a **Refresh** that re-runs research for that industry **in place**: it
re-uses `/api/research` and then reloads when the file's content changes (a
whole-body compare, so same-day re-runs are caught). Because the pipeline is
additive / write-if-better, a refresh only improves the data. Refresh sends
`meta.query` — the exact input that produced the slug — so the re-run targets the
**same** file rather than a drifted one (the pipeline records `meta.query` for
this; guarded by `scripts/test-resolve.mjs`).

### Optional Worker secrets for one-click research

One-click **Research it** needs the Worker to be able to trigger the workflow.
These are **optional** — without them everything else works, and the button
falls back to on-screen manual steps. Like the Bedrock keys, they are
**Cloudflare Worker secrets, separate from the GitHub Actions secrets**.

| Worker var | Purpose | Default if unset |
| --- | --- | --- |
| `GITHUB_TOKEN` | Fine-grained PAT with **Actions: write** on this repo | — (button shows manual steps) |
| `GITHUB_REPO` | `owner/name` of this repo (e.g. `ceekay-munshot/industryresearch`) | — (button shows manual steps) |
| `GITHUB_REF` | Branch to dispatch the workflow on | `main` |

**Create the token:** GitHub → **Settings → Developer settings → Fine-grained
personal access tokens** → new token scoped to **this repository only**, with
**Repository permissions → Actions: Read and write** (Contents can stay
read-only). Copy the token.

**Set the secrets (CLI):**

```bash
npx wrangler secret put GITHUB_TOKEN     # paste the fine-grained PAT
npx wrangler secret put GITHUB_REPO      # e.g. ceekay-munshot/industryresearch
# optional, only if you dispatch off a non-default branch:
npx wrangler secret put GITHUB_REF       # e.g. main
```

**Or the dashboard:** Workers &amp; Pages → your Worker → **Settings → Variables
and Secrets** → add `GITHUB_TOKEN` as an **encrypted** secret and `GITHUB_REPO`
as a plain variable → **Deploy**.

Without these, the flow still works end-to-end — "Research it" simply shows the
manual "run the workflow with this industry name" instructions.
