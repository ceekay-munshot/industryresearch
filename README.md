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

---

## Data contract

Each industry lives at `public/data/industries/<slug>.json`. All rendering is
generic and defensive: sections render only when present, in a fixed order.

```jsonc
{
  "meta":     { "slug", "name", "aliases": [], "definition", "is_manufacturing", "generated_at", "mock" },
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
