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
| Backend    | `worker/index.js` — a minimal Cloudflare Worker serving `./public` + one stub route |

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

**Option A — full site (recommended, enables the chat stub):**

```bash
npm install
npm run dev        # → wrangler dev, serves ./public and the /api/chat route
```

Then open the URL Wrangler prints (usually `http://localhost:8787`).

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
2. **YouTube** — grid of relevant video cards.
3. **Reports** — broker / industry / policy reports.
4. **News** — recent headlines with sentiment badges.
5. **Chat** — simple chat UI that calls `POST /api/chat` (stub reply for now).

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
2. **Research Industry** — enter an industry (default `MDF boards, India`). It
   writes `public/data/industries/<slug>.json`, updates `index.json`, and commits
   the change to the default branch.

Both workflows are `workflow_dispatch` only (nothing runs automatically) and use
Node 22 with no `npm install` (global `fetch` + stdlib only).
