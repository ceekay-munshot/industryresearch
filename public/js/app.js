/* =============================================================================
 * Industry Research Dashboard — frontend renderer
 * -----------------------------------------------------------------------------
 * Plain JS, no framework, no build step. Everything is driven by the per-industry
 * JSON at ./data/industries/<slug>.json. This file holds NO industry data: each
 * render function reads a section of the JSON generically and skips anything that
 * is empty/missing, so a different industry file renders with zero code changes.
 * ========================================================================== */
(function () {
  'use strict';

  /* ----------------------------------------------------------------------- *
   * Tiny DOM helpers
   * ----------------------------------------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Hyperscript-style element builder. Strings become text nodes (safe). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;              // trusted content only
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
      }
    }
    appendChildren(el, children);
    return el;
  }
  function appendChildren(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false || c === '') continue;
      el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
  }

  /* ----------------------------------------------------------------------- *
   * Value / formatting helpers
   * ----------------------------------------------------------------------- */
  const has = (v) => {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.trim() !== '';
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v == null || isNaN(Number(v))) ? '—' : Number(v).toLocaleString('en-IN');
  const pct = (v) => (v == null || isNaN(Number(v))) ? '—' : `${Number(v)}%`;

  function formatSize(obj, abbrev) {
    if (!obj || obj.value == null) return '—';
    let unit = obj.unit || '';
    if (abbrev) unit = unit.replace(/crore/i, 'cr');
    const v = num(obj.value);
    if (/₹/.test(unit)) return '₹' + v + (unit.replace('₹', '').trim() ? ' ' + unit.replace('₹', '').trim() : '');
    return v + (unit ? ' ' + unit : '');
  }

  /* ----------------------------------------------------------------------- *
   * Freshness + coverage — two independent axes (never merged). Freshness =
   * "is this current?" (data age vs each section's natural cadence). Coverage =
   * "is this the whole picture?" (sections filled + source depth). Everything is
   * computed from data the JSON already carries (meta.coverage + section presence).
   * ----------------------------------------------------------------------- */
  // Per-section [warn, error] thresholds in DAYS (age past these = aging / stale).
  const FRESH_T = {
    news: [14, 30], youtube: [30, 90], players: [182, 365], reports: [182, 365],
    size: [365, 730], growth_drivers: [365, 730], margins: [365, 730], quant: [365, 730],
    segments: [548, 1095], value_chain: [548, 1095], channels: [548, 1095], _default: [365, 730],
  };
  const daysSince = (dateStr, now) => { const t = Date.parse(dateStr); return isNaN(t) ? null : Math.max(0, Math.round((now - t) / 86400000)); };
  const asOfYear = (asOf) => { const m = String(asOf || '').match(/(20\d\d|19\d\d)/); return m ? m[1] : null; };
  function freshnessTier(section, asOf, now) {
    const d = daysSince(asOf, now);
    if (d == null) return null;
    const [warn, err] = FRESH_T[section] || FRESH_T._default;
    if (d <= warn) return { tier: 'fresh', word: 'Current' };
    if (d <= err) return { tier: 'aging', word: 'Aging' };
    return { tier: 'stale', word: 'Outdated' };
  }
  function relativeTime(dateStr, now) {
    const d = daysSince(dateStr, now);
    if (d == null) return null;
    if (d < 1) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 14) return d + ' days ago';
    if (d < 60) return Math.round(d / 7) + ' weeks ago';
    if (d < 730) return Math.round(d / 30) + ' months ago';
    return Math.round(d / 365) + ' years ago';
  }
  const EXPECTED = [
    { key: 'size', label: 'Market size' }, { key: 'segments', label: 'Segments' },
    { key: 'growth_drivers', label: 'Growth drivers' }, { key: 'value_chain', label: 'Value chain' },
    { key: 'channels', label: 'Channels' }, { key: 'players', label: 'Players' }, { key: 'margins', label: 'Margins' },
  ];
  const SRC_EXPECTED = [{ key: 'news', label: 'News' }, { key: 'reports', label: 'Reports' }, { key: 'youtube', label: 'Videos' }];
  const MATERIAL = ['size', 'players', 'margins'];

  /** Look up per-section freshness/source metadata from meta.coverage. */
  function sectionCov(section) {
    const cov = state.data && state.data.meta && state.data.meta.coverage && state.data.meta.coverage.sections;
    return (cov && cov[section]) || null;
  }

  /** Compute the coverage + freshness model for the header strip. */
  function coverageModel(data) {
    const m = data.meta || {};
    const cov = (m.coverage && m.coverage.sections) || {};
    const now = Date.now();
    const exp = EXPECTED.slice();
    if (m.is_manufacturing) exp.push({ key: 'quant', label: 'Capacity & trade' });
    const present = (e, isSrc) => has(isSrc ? (data.sources || {})[e.key] : data[e.key]);
    const rank = { fresh: 0, aging: 1, stale: 2 };
    let filled = 0, depthSum = 0, depthN = 0, worst = null;
    const missing = [];
    const consider = (e, isSrc) => {
      const p = present(e, isSrc);
      const c = cov[e.key] || {};
      if (p) {
        filled++;
        if (c.sources) { depthSum += Math.min(c.sources, 3) / 3; depthN++; }
        if (MATERIAL.includes(e.key)) {
          const t = freshnessTier(e.key, c.as_of, now);
          if (t && (!worst || rank[t.tier] > rank[worst.tier])) worst = t;
        }
      } else { missing.push(e); }
    };
    exp.forEach((e) => consider(e, false));
    SRC_EXPECTED.forEach((e) => consider(e, true));
    const total = exp.length + SRC_EXPECTED.length;
    const depthBonus = depthN ? depthSum / depthN : 0;
    const score = Math.round(100 * (0.7 * (filled / total) + 0.3 * depthBonus));
    return { filled, total, missing, score, dot: worst, updated: relativeTime(m.updated_at || m.generated_at, now), updatedAbs: m.updated_at || m.generated_at };
  }

  /* ----------------------------------------------------------------------- *
   * Inline SVG icon set
   * ----------------------------------------------------------------------- */
  const I = {
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="7"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/></svg>',
    bench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><path d="M3 3v18h18"/><rect x="7" y="9" width="4" height="8" rx="1"/><rect x="14" y="5" width="4" height="12" rx="1"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><path d="M14 3v5h5"/><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M9 13h6M9 17h6"/></svg>',
    news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><path d="M4 5h13v14a2 2 0 0 1-2 2H5a2 2 0 0 1-1-3.9"/><path d="M17 7h2a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2"/><path d="M8 8h6M8 12h6M8 16h3"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
    factory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h20"/><path d="M4 20V9l5 4V9l5 4V9l5 4v7"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7"/><path d="M3 7l3-4h12l3 4"/><path d="M9 12h6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="m9 6 6 6-6 6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>',
    report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 11h8M8 15h8M8 19h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M12 5v14M5 12h14"/></svg>',
  };

  /* ----------------------------------------------------------------------- *
   * Reusable pieces
   * ----------------------------------------------------------------------- */
  /** A source is shown as a compact ICON that links straight to the source — no
   *  long label cluttering the UI. Hovering reveals the publisher + snippet.
   *  Pass { label: true } for the rare place a text label is genuinely wanted. */
  function sourceChip(src, opts) {
    if (!src || !src.url) return null;
    const full = src.label || 'Source';
    const showLabel = opts && opts.label;
    return h('a', {
      class: 'source-chip source-chip-icon' + (showLabel ? ' has-label' : ''),
      href: src.url, target: '_blank', rel: 'noopener noreferrer',
      title: (src.snippet ? `${full} — ${src.snippet}` : full) + ' · opens the source',
      'aria-label': 'Source: ' + full,
    }, h('span', { html: I.link }), showLabel ? h('span', { class: 'src-label' }, full) : null);
  }

  /** Per-section freshness ("as of <year>") + source-depth chips for a card head. */
  function sectionChips(section) {
    const c = sectionCov(section);
    if (!c) return [];
    const out = [];
    const yr = asOfYear(c.as_of);
    const t = freshnessTier(section, c.as_of, Date.now());
    if (yr && t) out.push(h('span', { class: `asof asof-${t.tier}`, title: `${t.word} — data as of ${yr}` }, 'as of ' + yr));
    if (c.sources) out.push(h('span', { class: 'srccount', title: `${c.sources} distinct source${c.sources > 1 ? 's' : ''} back this section` }, c.sources + (c.sources > 1 ? ' sources' : ' source')));
    return out;
  }

  function card(opts) {
    const { title, subtitle, badge, source, body, hoverable = true, className = '', section } = opts;
    const right = [];
    if (badge) right.push(badge);
    if (section) right.push(...sectionChips(section));
    if (source) right.push(sourceChip(source));
    const head = (title || right.length) ? h('div', { class: 'card-head' },
      h('div', { class: 'card-head-main min-w-0' },
        title && h('h3', { class: 'card-title' }, title),
        subtitle && h('p', { class: 'card-sub' }, subtitle),
      ),
      right.length ? h('div', { class: 'card-head-chips flex items-center gap-2 flex-wrap' }, ...right) : null,
    ) : null;
    return h('div', { class: `card ${hoverable ? 'hoverable' : ''} ${className}` }, head, h('div', { class: 'card-body' }, body));
  }

  function metricPill(label, value, sub, accent, trend) {
    return h('div', { class: 'metric-pill' }, h('div', {},
      h('div', { class: 'kpi-label' }, label),
      h('div', { class: 'flex items-baseline gap-1.5' },
        h('span', { class: 'kpi-value text-[22px]', style: accent ? { color: accent } : null }, value),
        sub && h('span', { class: 'text-[11px] text-slate-400 font-medium' }, sub),
        trend || null,
      ),
    ));
  }

  /* ---- Trends: read a {year,value} series and show direction + a sparkline ---- */
  function cleanSeries(series) {
    return (series || []).filter((p) => p && p.value != null && !isNaN(Number(p.value)))
      .map((p) => ({ year: Number(p.year) || 0, value: Number(p.value) }))
      .sort((a, b) => a.year - b.year);
  }
  function trendFrom(series) {
    const s = cleanSeries(series);
    if (s.length < 2) return null;
    const a = s[s.length - 2].value, b = s[s.length - 1].value;
    const dir = b > a ? 'up' : b < a ? 'down' : 'flat';
    const pct = a > 0 ? Math.round(((b - a) / a) * 100) : null;
    return { dir, pct };
  }
  function trendBadge(series, dirOverride) {
    const t = trendFrom(series);
    const dir = (t && t.dir) || (dirOverride === 'up' || dirOverride === 'down' || dirOverride === 'flat' ? dirOverride : null);
    if (!dir) return null;
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '▪';
    const pctTxt = t && t.pct != null ? (t.pct > 0 ? '+' : '') + t.pct + '%' : '';
    return h('span', { class: 'trend-badge trend-' + dir, title: 'Trend' + (pctTxt ? ' ' + pctTxt : '') },
      h('span', { class: 'trend-arrow' }, arrow), pctTxt ? h('span', {}, pctTxt) : null);
  }
  /** Tiny inline sparkline SVG from a {year,value} series. */
  function sparkline(series, stroke) {
    const s = cleanSeries(series);
    if (s.length < 2) return null;
    const w = 96, hgt = 28, pad = 3;
    const vals = s.map((p) => p.value);
    const mn = Math.min(...vals), mx = Math.max(...vals), span = (mx - mn) || 1;
    const pts = s.map((p, i) => {
      const x = pad + (i / (s.length - 1)) * (w - 2 * pad);
      const y = hgt - pad - ((p.value - mn) / span) * (hgt - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const col = stroke || (PALETTE[0] || '#7c3aed');
    const last = pts.split(' ').pop().split(',');
    return h('span', { class: 'spark', title: `${s[0].year}: ${num(s[0].value)} → ${s[s.length-1].year}: ${num(s[s.length-1].value)}`, html:
      `<svg viewBox="0 0 ${w} ${hgt}" width="${w}" height="${hgt}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2.4" fill="${col}"/></svg>` });
  }

  function emptyState(msg, hint) {
    return h('div', { class: 'empty-state' },
      h('span', { html: I.empty }),
      h('div', { class: 'text-sm font-semibold text-slate-500' }, msg),
      hint && h('div', { class: 'text-xs' }, hint),
    );
  }

  function badge(text, kind) {
    return h('span', { class: `badge badge-${kind}` }, h('span', { class: 'badge-dot' }), text);
  }

  /* ----------------------------------------------------------------------- *
   * Markdown → HTML (headings, bold, code, lists, paragraphs)
   * ----------------------------------------------------------------------- */
  function mdToHtml(md) {
    const inline = (t) => escapeHtml(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = String(md).split(/\r?\n/);
    let out = '', inList = false, para = [];
    const flushP = () => { if (para.length) { out += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
    const closeL = () => { if (inList) { out += '</ul>'; inList = false; } };
    for (const raw of lines) {
      const line = raw.trim();
      let m;
      if (!line) { flushP(); closeL(); continue; }
      if ((m = line.match(/^#{2,3}\s+(.*)/))) { flushP(); closeL(); out += '<h2>' + inline(m[1]) + '</h2>'; }
      else if ((m = line.match(/^#\s+(.*)/))) { flushP(); closeL(); out += '<h2>' + inline(m[1]) + '</h2>'; }
      else if ((m = line.match(/^[-*]\s+(.*)/))) { flushP(); if (!inList) { out += '<ul>'; inList = true; } out += '<li>' + inline(m[1]) + '</li>'; }
      else { closeL(); para.push(line); }
    }
    flushP(); closeL();
    return out;
  }

  /* ----------------------------------------------------------------------- *
   * Charts (Chart.js v4) — palette from CSS vars, lazy per visible panel
   * ----------------------------------------------------------------------- */
  let PALETTE = [];
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    PALETTE = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cs.getPropertyValue(`--chart-${i}`).trim());
  }
  const color = (i) => PALETTE[i % PALETTE.length];

  const chartRegistry = [];
  function newChart(canvas, cfg) { const c = new Chart(canvas, cfg); chartRegistry.push(c); return c; }
  function destroyCharts() { chartRegistry.splice(0).forEach((c) => { try { c.destroy(); } catch (e) {} }); }

  function chartBox(height) {
    const box = h('div', { class: 'chart-box', style: { height: height + 'px' } });
    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    return { box, canvas };
  }

  /** Draws value labels at the end of horizontal bars (or above vertical bars). */
  function valueLabels(formatter, axis) {
    return {
      id: 'valueLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets.forEach((ds, di) => {
          const meta = chart.getDatasetMeta(di);
          meta.data.forEach((el, i) => {
            const val = ds.data[i];
            if (val == null) return;
            ctx.save();
            ctx.font = '700 11px Inter, sans-serif';
            ctx.fillStyle = '#475569';
            ctx.textBaseline = 'middle';
            if (axis === 'y') { ctx.textAlign = 'left'; ctx.fillText(formatter(val), el.x + 8, el.y); }
            else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(formatter(val), el.x, el.y - 6); }
            ctx.restore();
          });
        });
      },
    };
  }

  function doughnutLegend(items) {
    return h('div', { class: 'flex-1 min-w-0' }, ...items.map((it, i) =>
      h('div', { class: 'legend-item' },
        h('span', { class: 'legend-swatch', style: { background: color(i) } }),
        h('div', { class: 'min-w-0 flex-1' },
          h('div', { class: 'flex items-center justify-between gap-2' },
            h('span', { class: 'legend-name' }, it.name),
            h('span', { class: 'text-[13px] font-bold tnum text-slate-900 flex-shrink-0' }, pct(it.value)),
          ),
          it.note && h('div', { class: 'text-[11px] text-slate-400 truncate' }, it.note),
        ),
        it.source ? sourceChip(it.source, { icon: true }) : null,
      )));
  }

  /* ======================================================================= *
   * DEEP RESEARCH — section renderers
   * ======================================================================= */

  function secHeadline(data) {
    const s = data.summary || {};
    if (!has(s.headline) && !has(s.key_takeaways)) return null;
    const meta = data.meta || {};
    const takeaways = (s.key_takeaways || []).filter(has);
    return card({
      hoverable: false, className: 'fade-in',
      body: h('div', {},
        h('div', { class: 'flex items-center gap-2 mb-2' },
          h('span', { class: 'section-label' }, meta.is_manufacturing ? 'Manufacturing industry' : 'Industry snapshot'),
        ),
        has(s.headline) && h('h2', { class: 'font-display text-[20px] sm:text-[23px] font-extrabold leading-snug text-slate-900 tracking-tight' }, s.headline),
        takeaways.length ? h('div', { class: 'flex flex-wrap gap-2 mt-4' },
          ...takeaways.map((t) => h('span', { class: 'chip' }, h('span', { class: 'w-3.5 h-3.5 text-brand-600', html: I.check }), t))) : null,
      ),
    });
  }

  /** Adaptive "Key metrics" strip — standout, industry-specific KPIs the fixed
   *  sections don't capture. Shows a value, a trend (when a series is given) and a
   *  source icon. Renders nothing when the data has none. */
  function secHighlights(data) {
    const items = (data.highlights || []).filter((x) => x && has(x.label) && (has(x.value) || (Array.isArray(x.series) && x.series.length)));
    if (!items.length) return null;
    const tiles = items.slice(0, 12).map((x) => {
      const series = Array.isArray(x.series) ? x.series : null;
      const valTxt = has(x.value) ? String(x.value) + (has(x.unit) ? ' ' + x.unit : '') : '';
      return h('div', { class: 'kpi-tile' },
        h('div', { class: 'kpi-tile-head' },
          h('span', { class: 'kpi-tile-label' }, x.label),
          x.source ? sourceChip(x.source) : null),
        h('div', { class: 'kpi-tile-valrow' },
          valTxt ? h('span', { class: 'kpi-tile-val' }, valTxt,
            has(x.year) ? h('span', { class: 'kpi-tile-year' }, ' ’' + String(x.year).slice(-2)) : null) : null,
          trendBadge(series, x.trend)),
        series ? h('div', { class: 'kpi-tile-spark' }, sparkline(series, color(0)))
          : (has(x.note) ? h('div', { class: 'kpi-tile-note' }, x.note) : null));
    });
    return card({ hoverable: false, title: 'Key metrics', subtitle: 'standout figures for this industry',
      body: h('div', { class: 'kpi-grid' }, ...tiles) });
  }

  function secSize(data) {
    const size = data.size;
    if (!has(size) || (!has(size.current) && !has(size.history))) return null;
    const hist = (size.history || []).filter((p) => p && p.value != null);
    const body = h('div', {},
      h('div', { class: 'flex flex-wrap items-end gap-3 mb-4' },
        has(size.current) && metricPill('Current size', formatSize(size.current), size.current.year ? 'FY' + String(size.current.year).slice(-2) : null, 'var(--chart-1)', trendBadge(hist)),
        size.cagr_pct != null && metricPill('CAGR', pct(size.cagr_pct), size.cagr_note || 'growth', 'var(--chart-3)'),
      ),
    );
    if (hist.length) {
      const { box, canvas } = chartBox(230);
      body.appendChild(box);
      requestAnimationFrame(() => newChart(canvas, {
        type: 'line',
        data: {
          labels: hist.map((p) => p.year),
          datasets: [{
            data: hist.map((p) => p.value),
            borderColor: color(0), borderWidth: 2.5, tension: 0.35,
            pointRadius: 3, pointBackgroundColor: color(0), pointBorderColor: '#fff', pointBorderWidth: 1.5,
            fill: true,
            backgroundColor: (ctx) => {
              const { ctx: c, chartArea } = ctx.chart;
              if (!chartArea) return 'rgba(124,58,237,0.12)';
              const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              g.addColorStop(0, 'rgba(124,58,237,0.26)'); g.addColorStop(1, 'rgba(124,58,237,0.01)');
              return g;
            },
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => formatSize({ value: c.parsed.y, unit: size.current && size.current.unit }) } } },
          scales: {
            x: { grid: { display: false }, border: { display: false } },
            y: { grid: { color: '#eef1f6' }, border: { display: false }, ticks: { callback: (v) => num(v) } },
          },
        },
      }));
    }
    return card({ title: 'Market size over time', subtitle: has(size.current) && size.current.unit ? `in ${size.current.unit}` : null, source: size.source, section: 'size', badge: editHead(size, editSize, 'Edit market size'), body });
  }

  /** Unique source objects (by url), for a compact shared "Sources" row. */
  function uniqueSources(list) {
    const seen = new Set(); const out = [];
    for (const s of (list || [])) { if (!s || !s.url || seen.has(s.url)) continue; seen.add(s.url); out.push(s); }
    return out;
  }

  function secSegments(data) {
    const segs = (data.segments || []).filter((s) => s && s.share_pct != null);
    if (!segs.length) return null;
    const sum = segs.reduce((a, s) => a + Number(s.share_pct || 0), 0);
    // A doughnut only reads honestly as a true parts-of-whole breakdown. When the
    // shares mix cuts (e.g. product + region) and sum past 100%, use a horizontal
    // bar instead — no false whole, and long names sit cleanly on the axis.
    const isBreakdown = segs.length <= 7 && sum >= 92 && sum <= 108;

    if (isBreakdown) {
      const { box, canvas } = chartBox(220);
      const body = h('div', { class: 'seg-grid' }, box,
        doughnutLegend(segs.map((s) => ({ name: s.name, value: s.share_pct, note: s.note, source: s.source }))));
      requestAnimationFrame(() => newChart(canvas, {
        type: 'doughnut',
        data: { labels: segs.map((s) => s.name), datasets: [{ data: segs.map((s) => s.share_pct), backgroundColor: segs.map((_, i) => color(i)), borderColor: '#fff', borderWidth: 2, hoverOffset: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed}%` } } } },
      }));
      return card({ title: 'Segments', subtitle: 'share of market', section: 'segments', body });
    }

    const height = Math.max(170, segs.length * 46 + 20);
    const { box, canvas } = chartBox(height);
    const srcs = uniqueSources(segs.map((s) => s.source));
    const body = h('div', {}, box,
      srcs.length ? h('div', { class: 'src-row' }, h('span', { class: 'src-row-label' }, 'Sources'), ...srcs.map((s) => sourceChip(s))) : null);
    const maxV = Math.max(...segs.map((s) => Number(s.share_pct)));
    requestAnimationFrame(() => newChart(canvas, {
      type: 'bar',
      data: { labels: segs.map((s) => s.name), datasets: [{ data: segs.map((s) => Number(s.share_pct)), backgroundColor: segs.map((_, i) => color(i)), borderRadius: 6, barThickness: 20 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        layout: { padding: { right: 46 } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed.x}%` } } },
        scales: {
          x: { display: false, grid: { display: false }, min: 0, max: maxV * 1.16 },
          y: { grid: { display: false }, border: { display: false }, ticks: { autoSkip: false, font: { size: 11.5 }, color: '#334155', callback: function (v) { const l = String(this.getLabelForValue(v)).replace(/\s*\([^)]*\)\s*$/, ''); return l.length > 22 ? l.slice(0, 21) + '…' : l; } } },
        },
      },
      plugins: [valueLabels((v) => v + '%', 'y')],
    }));
    return card({ title: 'Segments', subtitle: 'share by cut — product & region', section: 'segments', body });
  }

  function secGrowthDrivers(data) {
    const drivers = (data.growth_drivers || []).filter((d) => has(d.title) || has(d.detail));
    if (!drivers.length) return null;
    const grid = h('div', { class: 'grid-auto' }, ...drivers.map((d, i) =>
      h('div', { class: 'rounded-xl border border-[var(--border)] bg-gradient-to-b from-white to-[#fbfaff] p-4 flex flex-col gap-2' },
        h('div', { class: 'flex items-start gap-2.5' },
          h('span', { class: 'w-7 h-7 rounded-lg grid place-items-center flex-shrink-0 text-white', style: { background: color(i) }, html: I.up }),
          h('div', { class: 'font-display font-bold text-[14px] text-slate-800 leading-tight' }, d.title || `Driver ${i + 1}`),
        ),
        d.detail && h('p', { class: 'text-[13px] text-slate-500 leading-relaxed' }, d.detail),
        d.source ? h('div', {}, sourceChip(d.source)) : null,
      )));
    return card({ title: 'Growth drivers', subtitle: 'what is pulling demand', section: 'growth_drivers', body: grid });
  }

  function twList(items, kind) {
    const good = kind === 'good';
    return h('div', {},
      ...items.map((it) => h('div', { class: good ? 'tw-item' : 'hw-item' },
        h('span', { class: (good ? 'tw-mark' : 'hw-mark') + ' w-4 h-4', html: good ? I.check : I.warn }),
        h('div', { class: 'flex-1 min-w-0' },
          h('div', { class: 'text-[13.5px] text-slate-700 leading-snug' }, it.point),
          it.source ? h('div', { class: 'mt-1.5' }, sourceChip(it.source)) : null,
        ),
      )));
  }

  function secTailHead(data) {
    const tail = (data.tailwinds || []).filter((t) => has(t.point));
    const head = (data.headwinds || []).filter((t) => has(t.point));
    if (!tail.length && !head.length) return null;
    return h('div', { class: 'grid gap-4 md:grid-cols-2' },
      tail.length ? card({ title: 'Tailwinds', badge: badge('Supportive', 'good'), body: twList(tail, 'good') }) : null,
      head.length ? card({ title: 'Headwinds', badge: badge('Watch', 'warn'), body: twList(head, 'bad') }) : null,
    );
  }

  function secValueChain(data) {
    const stages = (data.value_chain || []).filter((s) => has(s.stage) || has(s.description));
    if (!stages.length) return null;
    const track = h('div', { class: 'vc-track' }, ...stages.map((s, i) =>
      h('div', { class: 'vc-stage' },
        h('div', { class: 'vc-card' },
          h('div', { class: 'flex items-center gap-2 mb-2' },
            h('span', { class: 'vc-index' }, i + 1),
            h('div', { class: 'font-display font-bold text-[13.5px] text-slate-800 leading-tight' }, s.stage || `Stage ${i + 1}`),
          ),
          s.description && h('p', { class: 'text-[12.5px] text-slate-500 leading-relaxed mb-2' }, s.description),
          s.margin_note && h('div', { class: 'inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--primary-text)] bg-[var(--primary-soft)] border border-[var(--primary-border)] rounded-md px-2 py-1' },
            h('span', { class: 'w-1.5 h-1.5 rounded-full bg-current' }), s.margin_note),
          s.source ? h('div', { class: 'mt-2' }, sourceChip(s.source)) : null,
        ),
      )));
    return card({ title: 'Value chain', subtitle: 'stage-by-stage, with a margin note each', section: 'value_chain', body: track });
  }

  function secMargins(data) {
    const m = data.margins;
    if (!has(m) || (m.manufacturer_pct == null && m.retailer_pct == null)) return null;
    const bar = (label, val, accent) => val == null ? null : h('div', { class: 'mb-3' },
      h('div', { class: 'flex items-center justify-between mb-1' },
        h('span', { class: 'text-[12.5px] font-semibold text-slate-600' }, label),
        h('span', { class: 'text-[13px] font-bold tnum text-slate-900' }, pct(val)),
      ),
      h('div', { class: 'h-2.5 rounded-full bg-slate-100 overflow-hidden' },
        h('div', { style: { width: Math.min(100, Number(val)) + '%', height: '100%', background: accent, borderRadius: '999px' } })),
    );
    return card({
      title: 'Margin pool', subtitle: 'where the rupee lands', source: m.source, section: 'margins',
      badge: editHead(m, editMargins, 'Edit margins'),
      body: h('div', {},
        bar('Manufacturer (EBITDA)', m.manufacturer_pct, 'var(--chart-1)'),
        bar('Retailer / dealer', m.retailer_pct, 'var(--chart-4)'),
        m.notes && h('p', { class: 'text-[12.5px] text-slate-500 leading-relaxed mt-1' }, m.notes),
      ),
    });
  }

  function secChannels(data) {
    const all = (data.channels || []).filter((c) => c && has(c.channel));
    if (!all.length) return null;
    const withShare = all.filter((c) => c.share_pct != null);

    // Quantified: a share bar. Only-qualitative (notes, no %): a clean list so the
    // channel intel is surfaced instead of silently dropped.
    if (withShare.length >= 2) {
      const ch = withShare;
      const { box, canvas } = chartBox(Math.max(160, ch.length * 46 + 30));
      requestAnimationFrame(() => newChart(canvas, {
        type: 'bar',
        data: { labels: ch.map((c) => c.channel), datasets: [{ data: ch.map((c) => c.share_pct), backgroundColor: ch.map((_, i) => color(i)), borderRadius: 7, borderSkipped: false, barThickness: 20 }] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          layout: { padding: { right: 44 } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.x}%` } } },
          scales: {
            x: { max: Math.min(100, Math.max(...ch.map((c) => c.share_pct)) + 12), grid: { color: '#eef1f6' }, border: { display: false }, ticks: { callback: (v) => v + '%' } },
            y: { grid: { display: false }, border: { display: false }, ticks: { font: { weight: '600' }, callback: function (v) { const l = String(this.getLabelForValue(v)); return l.length > 20 ? l.slice(0, 19) + '…' : l; } } },
          },
        },
        plugins: [valueLabels((v) => v + '%', 'y')],
      }));
      const src = (all.find((c) => c.source && c.source.url) || {}).source;
      return card({ title: 'Channel mix', subtitle: 'share of sales', source: src, section: 'channels', body: box });
    }

    const list = h('div', { class: 'flex flex-col gap-3' }, ...all.map((c, i) =>
      h('div', { class: 'flex items-start gap-3' },
        h('span', { class: 'w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5', style: { background: color(i) } }),
        h('div', { class: 'min-w-0 flex-1' },
          h('div', { class: 'font-semibold text-[13.5px] text-slate-800' }, c.channel),
          has(c.note) && h('div', { class: 'text-[12.5px] text-slate-500 leading-snug mt-0.5' }, c.note),
          c.source ? h('div', { class: 'mt-1.5' }, sourceChip(c.source, { short: true })) : null))));
    return card({ title: 'Channels', subtitle: 'routes to market', section: 'channels', body: list });
  }

  function secPlayers(data) {
    const players = (data.players || []).filter((p) => has(p.name));
    if (!players.length) return null;

    // Only render numeric columns that at least one player actually has — a whole
    // column of "—" is noise.
    const hasRev = players.some((p) => p.revenue != null);
    const hasEbitda = players.some((p) => p.ebitda_margin_pct != null);
    const hasShare = players.some((p) => p.market_share_pct != null);
    const cols = [{ label: 'Company' }, { label: 'Listed' }, { label: 'Segment' }];
    if (hasRev) cols.push({ label: 'Revenue', num: true });
    if (hasEbitda) cols.push({ label: 'EBITDA %', num: true });
    if (hasShare) cols.push({ label: 'Market share', num: true });
    cols.push({ label: 'Source' });

    const rowFor = (p, i) => h('tr', {},
      h('td', { class: 'cell-company' },
        h('div', { class: 'cell-primary-row' }, h('span', { class: 'cell-primary' }, p.name), p.analyst ? analystBadge() : null, editBtn(() => editPlayer(p), 'Edit ' + p.name)),
        p.note && h('div', { class: 'cell-note', title: p.note }, p.note)),
      h('td', {}, p.listed === true ? badge(p.ticker ? p.ticker : 'Listed', 'brand') : (p.listed === false ? h('span', { class: 'badge badge-neutral' }, 'Private') : '—')),
      h('td', {}, has(p.segment) ? h('span', { class: 'text-slate-600 whitespace-nowrap' }, p.segment) : '—'),
      hasRev ? h('td', { class: 'num' }, p.revenue != null ? h('span', {}, formatSize({ value: p.revenue, unit: p.revenue_unit }, true), p.revenue_year ? h('span', { class: 'text-slate-400 text-[11px]' }, ' ’' + String(p.revenue_year).slice(-2)) : null) : '—') : null,
      hasEbitda ? h('td', { class: 'num' }, p.ebitda_margin_pct != null ? pct(p.ebitda_margin_pct) : '—') : null,
      hasShare ? h('td', { class: 'num' }, p.market_share_pct != null
        ? h('div', {},
            h('div', { class: 'font-semibold' }, pct(p.market_share_pct)),
            h('div', { class: 'mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden', style: { minWidth: '54px' } },
              h('div', { style: { width: Math.min(100, Number(p.market_share_pct)) + '%', height: '100%', background: color(i) } })))
        : '—') : null,
      h('td', {}, p.source ? sourceChip(p.source, { short: true }) : '—'),
    );

    const CAP = 12;
    const tbody = h('tbody', {}, ...players.slice(0, CAP).map(rowFor));
    const table = h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
      tbody);
    const tableBody = h('div', {}, h('div', { class: 'table-scroll' }, table));
    if (players.length > CAP) {
      const btn = h('button', {
        class: 'show-all-btn',
        onClick: (e) => { players.slice(CAP).forEach((p, j) => tbody.appendChild(rowFor(p, CAP + j))); e.currentTarget.remove(); },
      }, `Show all ${players.length} companies`, h('span', { class: 'w-3.5 h-3.5', html: I.chevron }));
      tableBody.appendChild(btn);
    }
    const tableCard = card({ title: 'Players', subtitle: `${players.length} companies`, className: 'min-w-0', section: 'players', badge: addBtn('Add player', addPlayer), body: tableBody });

    // ----- Market-share doughnut -----
    const shareData = players.filter((p) => p.market_share_pct != null);
    let shareCard = null;
    if (shareData.length) {
      const { box, canvas } = chartBox(200);
      shareCard = card({
        title: 'Market share', subtitle: 'by revenue',
        body: h('div', {}, box, h('div', { class: 'mt-3' }, doughnutLegend(shareData.map((p) => ({ name: p.name, value: p.market_share_pct }))))),
      });
      requestAnimationFrame(() => newChart(canvas, {
        type: 'doughnut',
        data: { labels: shareData.map((p) => p.name), datasets: [{ data: shareData.map((p) => p.market_share_pct), backgroundColor: shareData.map((_, i) => color(i)), borderColor: '#fff', borderWidth: 2, hoverOffset: 6 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${c.parsed}%` } } } },
      }));
    }

    // Full-width table when there's no market-share chart; otherwise a 2:1 split.
    if (!shareCard) return h('div', {}, tableCard);
    return h('div', { class: 'grid gap-4 grid-cols-1 lg:grid-cols-3 items-start' },
      h('div', { class: 'lg:col-span-2 min-w-0' }, tableCard),
      h('div', { class: 'min-w-0' }, shareCard),
    );
  }

  function secQuant(data) {
    const q = data.quant;
    if (!has(q)) return null;
    const cards = [];

    // Capacity by player (horizontal bar)
    const cap = (q.capacity || []).filter((c) => c && c.capacity != null);
    if (cap.length) {
      const { box, canvas } = chartBox(Math.max(160, cap.length * 42 + 30));
      cards.push(card({
        title: 'Installed capacity', subtitle: cap[0].unit ? `by player (${cap[0].unit})` : 'by player', section: 'quant',
        body: h('div', {}, box, h('div', { class: 'mt-2 text-[11px] text-slate-400' }, cap.map((c) => c.region).filter(has).length ? 'Regions: ' + cap.map((c) => `${c.player} — ${c.region}`).filter((s) => !/undefined/.test(s)).join(' · ') : null)),
      }));
      requestAnimationFrame(() => newChart(canvas, {
        type: 'bar',
        data: { labels: cap.map((c) => c.player), datasets: [{ data: cap.map((c) => c.capacity), backgroundColor: cap.map((_, i) => color(i)), borderRadius: 7, borderSkipped: false, barThickness: 18 }] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          layout: { padding: { right: 70 } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => num(c.parsed.x) + (cap[0].unit ? ' ' + cap[0].unit : '') } } },
          scales: { x: { grid: { color: '#eef1f6' }, border: { display: false }, ticks: { callback: (v) => num(v) } }, y: { grid: { display: false }, border: { display: false }, ticks: { font: { weight: '600' }, callback: function (v) { const l = String(this.getLabelForValue(v)); return l.length > 18 ? l.slice(0, 17) + '…' : l; } } } },
        },
        plugins: [valueLabels((v) => num(v), 'y')],
      }));
    }

    // Imports trend (area)
    const imp = (q.imports || []).filter((r) => r && r.volume != null);
    if (imp.length) {
      const { box, canvas } = chartBox(190);
      cards.push(card({ title: 'Imports trend', subtitle: imp[0].unit ? `volume (${imp[0].unit})` : 'volume', body: box }));
      requestAnimationFrame(() => newChart(canvas, {
        type: 'line',
        data: { labels: imp.map((r) => r.year), datasets: [{ data: imp.map((r) => r.volume), borderColor: color(4), borderWidth: 2.5, tension: 0.35, pointRadius: 3, pointBackgroundColor: color(4), pointBorderColor: '#fff', pointBorderWidth: 1.5, fill: true, backgroundColor: 'rgba(244,63,94,0.10)' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => num(c.parsed.y) + (imp[0].unit ? ' ' + imp[0].unit : '') } } }, scales: { x: { grid: { display: false }, border: { display: false } }, y: { grid: { color: '#eef1f6' }, border: { display: false }, ticks: { callback: (v) => num(v) } } } },
      }));
    }

    // Utilisation + duty
    const side = [];
    if (q.utilisation_pct != null) {
      side.push(h('div', { class: 'mb-4' },
        h('div', { class: 'flex items-center justify-between mb-1.5' },
          h('span', { class: 'text-[12.5px] font-semibold text-slate-600' }, 'Capacity utilisation'),
          h('span', { class: 'text-[16px] font-extrabold tnum text-slate-900' }, pct(q.utilisation_pct))),
        h('div', { class: 'h-3 rounded-full bg-slate-100 overflow-hidden' },
          h('div', { style: { width: Math.min(100, Number(q.utilisation_pct)) + '%', height: '100%', background: 'linear-gradient(90deg,var(--chart-2),var(--chart-1))', borderRadius: '999px' } }))));
    }
    const duty = (q.duty || []).filter((d) => has(d.country) || has(d.note));
    if (duty.length) {
      side.push(h('div', {},
        h('div', { class: 'text-[12px] font-bold uppercase tracking-wide text-slate-400 mb-2' }, 'Trade duty'),
        ...duty.map((d) => h('div', { class: 'flex items-start gap-2 py-1.5 border-b border-dashed border-[var(--border)] last:border-0' },
          h('span', { class: 'badge badge-neutral flex-shrink-0' }, d.country || '—'),
          d.note && h('span', { class: 'text-[12.5px] text-slate-600 leading-snug' }, d.note)))));
    }
    if (side.length) cards.push(card({ title: 'Utilisation & trade', source: q.source, body: h('div', {}, ...side) }));

    if (!cards.length) return null;
    return h('div', {},
      h('div', { class: 'flex items-center gap-2 mb-3 mt-1' },
        h('span', { class: 'w-8 h-8 rounded-lg grid place-items-center text-white flex-shrink-0', style: { background: 'linear-gradient(135deg,var(--chart-1),var(--chart-7))' }, html: I.factory }),
        h('div', {}, h('div', { class: 'font-display font-extrabold text-[16px] text-slate-900' }, 'Supply & Trade'),
          h('div', { class: 'text-[12px] text-slate-400' }, 'capacity · utilisation · imports · duty'))),
      h('div', { class: 'grid gap-4 grid-cols-1 lg:grid-cols-2' }, ...cards));
  }

  function secReport(data) {
    const md = data.summary && data.summary.report_markdown;
    if (!has(md)) return null;
    const bodyWrap = h('div', { class: 'disclosure-body markdown', html: mdToHtml(md) });
    const wrap = h('div', { class: 'disclosure open' },
      h('button', { class: 'disclosure-btn', onClick: (e) => { e.currentTarget.closest('.disclosure').classList.toggle('open'); } },
        h('span', { class: 'disclosure-caret', html: I.chevron }),
        h('span', { class: 'font-display font-bold text-[15px] text-slate-900' }, 'Full written summary'),
      ),
      bodyWrap,
    );
    return card({ hoverable: false, body: wrap });
  }

  /* ======================================================================= *
   * DEEP RESEARCH — sub-tab wiring
   * ======================================================================= */
  const DEEP_SUBS = [
    {
      id: 'overview', label: 'Overview',
      available: (d) => has(d.summary) || has(d.size) || has(d.segments) || has(d.highlights),
      render: (root, d) => appendChildren(root, [
        secHeadline(d),
        secHighlights(d),
        gridStack([secSize(d), secSegments(d)], 'lg:grid-cols-2'),
      ]),
    },
    {
      id: 'dynamics', label: 'Growth & dynamics',
      available: (d) => has(d.growth_drivers) || has(d.tailwinds) || has(d.headwinds),
      render: (root, d) => appendChildren(root, [secGrowthDrivers(d), secTailHead(d)]),
    },
    {
      id: 'chain', label: 'Value chain & channels',
      available: (d) => has(d.value_chain) || has(d.channels) || has(d.margins),
      render: (root, d) => appendChildren(root, [
        secValueChain(d),
        gridStack([secChannels(d), secMargins(d)], 'lg:grid-cols-2'),
      ]),
    },
    {
      id: 'players', label: 'Players & supply',
      available: (d) => has(d.players) || has(d.quant),
      render: (root, d) => appendChildren(root, [secPlayers(d), secQuant(d)]),
    },
    {
      id: 'report', label: 'Full report',
      available: (d) => has(d.summary && d.summary.report_markdown),
      render: (root, d) => appendChildren(root, [secReport(d)]),
    },
  ];

  /** Wrap a set of section nodes into a responsive grid, dropping empties. */
  function gridStack(nodes, colsClass) {
    const items = nodes.filter(Boolean);
    if (!items.length) return null;
    if (items.length === 1) return h('div', { class: 'mt-4' }, items[0]);
    return h('div', { class: `grid gap-4 mt-4 grid-cols-1 ${colsClass || ''} items-start` }, ...items);
  }

  /* ======================================================================= *
   * OTHER TABS
   * ======================================================================= */
  /* ======================================================================= *
   * BENCHMARKING — peer financials, grouped by sub-segment with a median row
   * per group, plus revenue and EBITDA% bar charts. Listed peers carry real
   * screener financials; unlisted / not-yet-available peers show a clear
   * "Pending (Private Circle)" row — never a blank cell.
   * ======================================================================= */
  const BENCH_KEYS = ['revenue', 'revenue_cagr_3y_pct', 'ebitda_pct', 'pat_pct', 'roce_pct', 'roe_pct'];
  const hasAnyMetric = (p) => BENCH_KEYS.some((k) => p && p[k] != null);

  function revCell(p) {
    if (p.revenue == null) return '—';
    return h('span', {}, formatSize({ value: p.revenue, unit: p.revenue_unit }, true),
      p.revenue_year ? h('span', { class: 'text-slate-400 text-[11px]' }, ' ’' + String(p.revenue_year).slice(-2)) : null);
  }
  const BENCH_METRICS = [
    { key: 'revenue', label: 'Revenue', fmt: revCell },
    { key: 'revenue_cagr_3y_pct', label: 'Rev 3Y CAGR', fmt: (p) => pct(p.revenue_cagr_3y_pct) },
    { key: 'ebitda_pct', label: 'EBITDA %', fmt: (p) => pct(p.ebitda_pct) },
    { key: 'pat_pct', label: 'PAT %', fmt: (p) => pct(p.pat_pct) },
    { key: 'roce_pct', label: 'RoCE', fmt: (p) => pct(p.roce_pct) },
    { key: 'roe_pct', label: 'RoE', fmt: (p) => pct(p.roe_pct) },
  ];

  function groupPeers(peers) {
    const map = new Map();
    for (const p of peers) {
      const seg = (p.segment && String(p.segment).trim()) || 'Other';
      if (!map.has(seg)) map.set(seg, []);
      map.get(seg).push(p);
    }
    return [...map.entries()].map(([name, ps]) => ({ name, peers: ps }));
  }
  function medianLocal(nums) {
    const xs = (nums || []).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (!xs.length) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }
  const firstUnit = (peers) => { const p = (peers || []).find((x) => x.revenue_unit); return p ? p.revenue_unit : ''; };
  function benchListedCell(p) {
    if (p.listed === true) return badge(p.ticker ? p.ticker : 'Listed', 'brand');
    if (p.listed === false) return badge(p.status === 'unlisted-drhp' ? 'Unlisted' : 'Private', 'neutral');
    return '—';
  }
  function benchSourceCell(p) {
    if (p.source && p.source.url) return sourceChip(p.source, { short: true });
    if (p.prospectus && p.prospectus.url) return sourceChip({ label: p.prospectus.label || 'Prospectus', url: p.prospectus.url }, { short: true });
    return '—';
  }
  function benchBarCard(title, subtitle, peers, valOf, fmt) {
    const { box, canvas } = chartBox(Math.max(150, peers.length * 40 + 28));
    requestAnimationFrame(() => newChart(canvas, {
      type: 'bar',
      data: { labels: peers.map((p) => p.name), datasets: [{ data: peers.map(valOf), backgroundColor: peers.map((_, i) => color(i)), borderRadius: 7, borderSkipped: false, barThickness: 18 }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        layout: { padding: { right: 66 } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(c.parsed.x) } } },
        scales: {
          x: { grid: { color: '#eef1f6' }, border: { display: false }, ticks: { callback: (v) => fmt(v) } },
          y: { grid: { display: false }, border: { display: false }, ticks: { font: { weight: '600' }, callback: function (v) { const l = String(this.getLabelForValue(v)); return l.length > 22 ? l.slice(0, 21) + '…' : l; } } },
        },
      },
      plugins: [valueLabels((v) => fmt(v), 'y')],
    }));
    return card({ title, subtitle, className: 'min-w-0', body: box });
  }

  function renderBenchmarking(root, data) {
    root.innerHTML = '';
    const b = data.benchmarking;
    const peers = (b && Array.isArray(b.peers)) ? b.peers.filter((p) => p && p.name) : [];
    if (!peers.length) { root.appendChild(card({ hoverable: false, body: emptyState('No benchmarking yet', 'Peer financials appear here once a run gathers them.') })); return; }

    const groups = groupPeers(peers);
    const showGroupHead = groups.length > 1 || groups[0].name !== 'Other';
    const totalCols = 2 + BENCH_METRICS.length + 1;

    const thead = h('thead', {}, h('tr', {},
      h('th', {}, 'Company'), h('th', {}, 'Listed'),
      ...BENCH_METRICS.map((m) => h('th', { class: 'num' }, m.label)),
      h('th', {}, 'Source')));
    const tbody = h('tbody', {});

    const nameCell = (p) => h('td', { class: 'cell-company' },
      h('div', { class: 'cell-primary-row' }, h('span', { class: 'cell-primary' }, p.name), p.analyst ? analystBadge() : null, editBtn(() => editPeer(p), 'Edit ' + p.name)),
      p.forward_note ? h('div', { class: 'cell-note', title: p.forward_note }, p.forward_note) : null);

    const filledRow = (p) => h('tr', {},
      nameCell(p),
      h('td', {}, benchListedCell(p)),
      ...BENCH_METRICS.map((m) => h('td', { class: 'num' }, p[m.key] != null ? m.fmt(p) : '—')),
      h('td', {}, benchSourceCell(p)));

    const pendingRow = (p) => h('tr', { class: 'bench-pending' },
      nameCell(p),
      h('td', {}, benchListedCell(p)),
      h('td', { class: 'bench-pending-cell', colspan: String(BENCH_METRICS.length) },
        h('span', { class: 'bench-pill' }, 'Pending'),
        h('span', { class: 'bench-pending-note' }, p.pending_reason || 'Private Circle')),
      h('td', {}, benchSourceCell(p)));

    const medianRow = (ps) => {
      const withFin = ps.filter((p) => !p.pending && hasAnyMetric(p));
      if (withFin.length < 2) return null;                 // a "median" of one isn't meaningful
      return h('tr', { class: 'bench-median' },
        h('td', {}, h('span', { class: 'bench-median-label' }, 'Median'), h('span', { class: 'bench-median-count' }, ' · ' + withFin.length)),
        h('td', {}),
        ...BENCH_METRICS.map((m) => {
          const med = medianLocal(withFin.map((p) => p[m.key]).filter((v) => v != null && !isNaN(Number(v))));
          if (med == null) return h('td', { class: 'num' }, '—');
          return h('td', { class: 'num' }, m.key === 'revenue'
            ? formatSize({ value: med, unit: firstUnit(withFin) }, true)
            : pct(Math.round(med * 10) / 10));
        }),
        h('td', {}));
    };

    for (const g of groups) {
      if (showGroupHead) tbody.appendChild(h('tr', { class: 'bench-group' },
        h('td', { colspan: String(totalCols) },
          h('span', { class: 'bench-group-name' }, g.name),
          h('span', { class: 'bench-group-count' }, ' · ' + g.peers.length + (g.peers.length === 1 ? ' peer' : ' peers')))));
      const filled = g.peers.filter((p) => !p.pending && hasAnyMetric(p));
      const pend = g.peers.filter((p) => p.pending || !hasAnyMetric(p));
      filled.forEach((p) => tbody.appendChild(filledRow(p)));
      pend.forEach((p) => tbody.appendChild(pendingRow(p)));
      const mr = medianRow(g.peers);
      if (mr) tbody.appendChild(mr);
    }

    const table = h('table', { class: 'data-table bench-table' }, thead, tbody);
    const pendingCount = peers.filter((p) => p.pending || !hasAnyMetric(p)).length;
    const sub = `${peers.length} peer${peers.length === 1 ? '' : 's'}` + (pendingCount ? ` · ${pendingCount} pending (Private Circle)` : '');
    const legend = pendingCount ? h('p', { class: 'bench-caption' },
      h('span', { class: 'bench-pill' }, 'Pending'),
      ' rows are unlisted or not yet available — sourced from a prospectus / Private Circle, they fill in as data lands.') : null;
    root.appendChild(card({ title: 'Peer benchmarking', subtitle: sub, className: 'min-w-0', badge: addBtn('Add peer', addPeer),
      body: h('div', {}, h('div', { class: 'table-scroll' }, table), legend) }));

    // Charts — revenue by player + EBITDA% by player (peers that carry the metric).
    const charts = [];
    const revPeers = peers.filter((p) => p.revenue != null).sort((a, b) => Number(b.revenue) - Number(a.revenue)).slice(0, 12);
    if (revPeers.length >= 2) charts.push(benchBarCard('Revenue by player', firstUnit(revPeers) || 'latest FY', revPeers,
      (p) => Number(p.revenue), (v) => formatSize({ value: v, unit: firstUnit(revPeers) }, true)));
    const ebPeers = peers.filter((p) => p.ebitda_pct != null).sort((a, b) => Number(b.ebitda_pct) - Number(a.ebitda_pct)).slice(0, 12);
    if (ebPeers.length >= 2) charts.push(benchBarCard('EBITDA % by player', 'operating margin', ebPeers,
      (p) => Number(p.ebitda_pct), (v) => v + '%'));
    if (charts.length) root.appendChild(h('div', { class: 'grid gap-4 mt-4 grid-cols-1 lg:grid-cols-2 items-start' }, ...charts));
  }

  function renderYouTube(root, data) {
    root.innerHTML = '';
    const vids = ((data.sources && data.sources.youtube) || []).filter((v) => has(v.title) || has(v.url));
    if (!vids.length) { root.appendChild(card({ hoverable: false, body: emptyState('No videos yet', 'YouTube results will appear here once gathered.') })); return; }
    const grid = h('div', { class: 'grid gap-4', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' } },
      ...vids.map((v) => {
        const thumb = h('div', { class: 'yt-thumb' });
        if (has(v.thumbnail)) {
          const img = h('img', { src: v.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
          img.addEventListener('error', () => img.remove());
          thumb.appendChild(img);
        }
        thumb.appendChild(h('div', { class: 'yt-play' }, h('span', { html: I.play })));
        return h('a', { class: 'card hoverable overflow-hidden block', href: v.url || '#', target: '_blank', rel: 'noopener noreferrer' },
          thumb,
          h('div', { class: 'p-3.5' },
            h('div', { class: 'font-display font-bold text-[13.5px] text-slate-800 leading-snug line-clamp-2', style: { display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, v.title || 'Untitled'),
            h('div', { class: 'flex items-center gap-1.5 mt-1.5 text-[11.5px] text-slate-400' },
              has(v.channel) && h('span', { class: 'font-semibold text-slate-500' }, v.channel),
              has(v.channel) && has(v.published) && h('span', {}, '·'),
              has(v.published) && h('span', {}, v.published)),
            has(v.why_relevant) && h('div', { class: 'mt-2 text-[12px] text-slate-500 leading-snug bg-slate-50 rounded-lg px-2.5 py-1.5 clamp-3' }, v.why_relevant)),
        );
      }));
    root.appendChild(grid);
  }

  function renderReports(root, data) {
    root.innerHTML = '';
    const reports = ((data.sources && data.sources.reports) || []).filter((r) => has(r.title));
    if (!reports.length) { root.appendChild(card({ hoverable: false, body: emptyState('No reports yet', 'Broker and industry reports will be listed here.') })); return; }
    const list = h('div', { class: 'flex flex-col gap-3' },
      ...reports.map((r) => h('a', { class: 'card hoverable block', href: r.url || '#', target: '_blank', rel: 'noopener noreferrer' },
        h('div', { class: 'card-body flex items-start gap-3.5' },
          h('span', { class: 'w-10 h-10 rounded-xl grid place-items-center flex-shrink-0 text-[var(--primary-text)] bg-[var(--primary-soft)]', html: I.doc }),
          h('div', { class: 'min-w-0 flex-1' },
            h('div', { class: 'flex items-start justify-between gap-3 flex-wrap' },
              h('div', { class: 'font-display font-bold text-[14.5px] text-slate-800 leading-snug' }, r.title),
              has(r.type) && h('span', { class: 'badge badge-brand flex-shrink-0' }, r.type)),
            h('div', { class: 'flex items-center gap-1.5 mt-1 text-[12px] text-slate-400' },
              has(r.publisher) && h('span', { class: 'font-semibold text-slate-500' }, r.publisher),
              has(r.publisher) && has(r.date) && h('span', {}, '·'),
              has(r.date) && h('span', {}, r.date)),
            has(r.summary) && h('p', { class: 'text-[13px] text-slate-500 leading-relaxed mt-1.5' }, r.summary)),
        ))));
    root.appendChild(list);
  }

  function renderNews(root, data) {
    root.innerHTML = '';
    const newsTs = (n) => { const t = Date.parse(n.published || n.date || ''); return isNaN(t) ? -Infinity : t; };
    const news = ((data.sources && data.sources.news) || []).filter((n) => has(n.title))
      .slice().sort((a, b) => newsTs(b) - newsTs(a));   // most recent headlines first
    if (!news.length) { root.appendChild(card({ hoverable: false, body: emptyState('No news yet', 'Recent headlines will appear here.') })); return; }
    const sentiment = (s) => {
      const k = String(s || '').toLowerCase();
      if (k === 'positive') return badge('Positive', 'good');
      if (k === 'negative') return badge('Negative', 'bad');
      if (k === 'neutral') return badge('Neutral', 'neutral');
      return has(s) ? badge(s, 'neutral') : null;
    };
    const list = h('div', { class: 'grid gap-3 md:grid-cols-2 items-start' },
      ...news.map((n) => h('a', { class: 'card hoverable block', href: n.url || '#', target: '_blank', rel: 'noopener noreferrer' },
        h('div', { class: 'card-body' },
          h('div', { class: 'flex items-start justify-between gap-3' },
            h('div', { class: 'font-display font-bold text-[14px] text-slate-800 leading-snug flex-1 min-w-0 clamp-2' }, n.title),
            sentiment(n.sentiment)),
          h('div', { class: 'flex items-center gap-1.5 mt-1 text-[12px] text-slate-400' },
            has(n.publisher) && h('span', { class: 'font-semibold text-slate-500 truncate max-w-[60%]' }, n.publisher),
            has(n.publisher) && has(n.date) && h('span', { class: 'flex-shrink-0' }, '·'),
            has(n.date) && h('span', { class: 'flex-shrink-0' }, n.date)),
          has(n.snippet) && h('p', { class: 'text-[13px] text-slate-500 leading-relaxed mt-1.5 clamp-2' }, n.snippet)),
      )));
    root.appendChild(list);
  }

  /* ======================================================================= *
   * REPORT TAB — the consolidated written report (with inline charts + PDF)
   * ======================================================================= */
  function reportAllSources(data) {
    const rep = data.summary && data.summary.report;
    const secs = (rep && rep.sections) || [];
    const seen = new Set(); const out = [];
    for (const s of secs) for (const r of (s.source_refs || [])) { if (r && r.url && !seen.has(r.url)) { seen.add(r.url); out.push(r); } }
    return out;
  }

  /** The dashboard chart that belongs inline with a report section, so the report
   *  is visual, not text-only. Reuses the exact section renderers. */
  function reportChart(heading, data) {
    const t = String(heading || '').toLowerCase();
    try {
      if (/market size|size &|growth/.test(t) && has(data.size)) return secSize(data);
      if (/segment/.test(t)) return secSegments(data);
      if (/value chain/.test(t)) return secValueChain(data);
      if (/distribution|channel/.test(t)) return secChannels(data);
      if (/player|positioning|competit/.test(t)) return secPlayers(data);
      if (/margin/.test(t)) return secMargins(data);
      if (/supply|capacity/.test(t)) return secQuant(data);
    } catch (e) { return null; }
    return null;
  }

  function reportSection(s, data) {
    const isSources = /^\s*sources\b/i.test(s.heading);
    const kids = [h('h2', { class: 'report-h' }, s.heading)];
    if (s.key_numbers && s.key_numbers.length) {
      kids.push(h('div', { class: 'report-keynums' }, ...s.key_numbers.map((k) =>
        h('div', { class: 'report-kn' },
          k.label ? h('span', { class: 'report-kn-label' }, k.label) : null,
          h('span', { class: 'report-kn-value tnum' }, k.value)))));
    }
    for (const p of (s.prose || [])) kids.push(h('p', { class: 'report-p' }, p));
    if (isSources) {
      const refs = (s.source_refs && s.source_refs.length) ? s.source_refs : reportAllSources(data);
      kids.push(h('ol', { class: 'report-src-list' }, ...refs.map((r) =>
        h('li', {}, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.label || 'Source'),
          h('span', { class: 'report-src-url' }, r.url)))));
    } else {
      const chart = reportChart(s.heading, data);
      if (chart) kids.push(h('div', { class: 'report-chart' }, chart));
      if (s.source_refs && s.source_refs.length) {
        kids.push(h('div', { class: 'report-srcrow' }, h('span', { class: 'report-srcrow-label' }, 'Sources'),
          ...s.source_refs.map((r) => sourceChip(r))));
      }
    }
    return h('section', { class: 'report-section' }, ...kids);
  }

  function renderReport(root, data) {
    root.innerHTML = '';
    const m = data.meta || {};
    const rep = data.summary && data.summary.report;
    let sections = (rep && Array.isArray(rep.sections)) ? rep.sections.filter((s) => s && s.heading && Array.isArray(s.prose) && s.prose.length) : [];

    let body;
    if (sections.length) {
      body = sections.map((s) => reportSection(s, data));
    } else if (has(data.summary && data.summary.report_markdown)) {
      body = [h('section', { class: 'report-section' }, h('div', { class: 'markdown', html: mdToHtml(data.summary.report_markdown) }))];
    } else {
      root.appendChild(card({ hoverable: false, body: emptyState('Report is being written', 'The consolidated report will appear here once it is generated from the data.') }));
      return;
    }

    const cm = coverageModel(data);
    const dot = cm.dot || { tier: 'fresh', word: 'Current' };
    const asOf = (rep && rep.generated_at) || m.updated_at || m.generated_at;
    const header = h('div', { class: 'report-head' },
      h('div', { class: 'min-w-0' },
        h('div', { class: 'report-eyebrow' }, m.is_manufacturing ? 'Industry report · manufacturing' : 'Industry report'),
        h('h1', { class: 'report-title' }, m.name || 'Industry'),
        h('div', { class: 'report-metaline' },
          asOf ? h('span', {}, 'Data as of ' + asOf) : null,
          asOf ? h('span', { class: 'report-sep' }, '·') : null,
          h('span', { class: 'inline-flex items-center gap-1.5' }, h('span', { class: 'fb-dot dot-' + dot.tier }), dot.word + ' data'),
          h('span', { class: 'report-sep' }, '·'),
          h('span', {}, cm.filled + '/' + cm.total + ' sections covered'),
          (rep && rep.kind === 'fallback') ? h('span', { class: 'report-badge', title: 'A deterministic summary built from the data; the full narrative is written on the next research run.' }, 'auto-summary') : null)),
      h('button', { class: 'report-print-btn no-print', onClick: () => window.print() },
        h('span', { class: 'w-4 h-4', html: I.download }), 'Download PDF'));

    root.appendChild(h('div', { class: 'report-doc', id: 'report-doc' }, header, h('div', { class: 'report-body' }, ...body)));
  }

  /** Starter questions, filtered to the sections this industry actually has —
   *  so we never suggest a question the data can't answer. Generic for any industry. */
  function starterQuestions(data) {
    const cand = [
      { need: () => has(data.size), q: 'How big is the market and how fast is it growing?' },
      { need: () => has(data.segments), q: 'What are the main segments?' },
      { need: () => has(data.players), q: 'Who are the top players?' },
      { need: () => has(data.channels), q: 'How is it sold and distributed?' },
      { need: () => has(data.growth_drivers) || has(data.tailwinds), q: "What's driving growth?" },
      { need: () => has(data.headwinds), q: 'What are the key risks?' },
      { need: () => has(data.margins), q: 'What do margins look like across the chain?' },
      { need: () => has(data.value_chain), q: 'Walk me through the value chain.' },
    ];
    const picked = cand.filter((c) => c.need()).map((c) => c.q);
    return (picked.length ? picked : ['Give me a quick overview of this industry.']).slice(0, 4);
  }

  function renderChat(root, data) {
    root.innerHTML = '';
    const nm = (data.meta && data.meta.name) || 'this industry';
    const slug = (data.meta && data.meta.slug) || state.slug;
    // Conversation memory for follow-up questions (sent to the worker each turn).
    const history = [];

    const log = h('div', { class: 'chat-log', id: 'chat-log' });
    log.appendChild(h('div', { class: 'msg bot' },
      `Hi! Ask me anything about ${nm}. I answer only from the gathered dashboard data and cite the sources — if something isn't in the data, I'll say so.`));

    const input = h('input', { class: 'flex-1 min-w-0 border-0 outline-none bg-transparent text-[14px]', type: 'text', placeholder: 'Ask a question…', autocomplete: 'off' });
    const sendBtn = h('button', { class: 'text-white font-semibold text-[13px] rounded-lg px-4 py-1.5 flex-shrink-0', style: { background: 'var(--primary)' }, type: 'submit' }, 'Send');
    const form = h('form', { class: 'searchbar mt-4', style: { borderRadius: '14px' } }, input, sendBtn);

    const ctx = { log, history, data, slug, input, sendBtn, busy: false };

    // Suggested starter questions — clickable, disappear once the chat gets going.
    const starters = h('div', { class: 'chat-starters', id: 'chat-starters' },
      h('span', { class: 'chat-starters-label' }, 'Try asking'),
      ...starterQuestions(data).map((q) =>
        h('button', { class: 'chat-starter', type: 'button', onClick: () => { if (!ctx.busy) submit(ctx, q); } }, q)));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submit(ctx, input.value);
    });

    root.appendChild(card({ hoverable: false, title: 'Chat', subtitle: `ask about ${nm}`,
      body: h('div', {},
        h('div', { class: 'chat-window', style: { minHeight: '340px', maxHeight: '52vh', overflowY: 'auto' } }, log),
        starters, form) }));
    input.focus();
  }

  function submit(ctx, raw) {
    const text = String(raw || '').trim();
    if (!text || ctx.busy) return;
    ctx.input.value = '';
    const starters = document.getElementById('chat-starters');
    if (starters) starters.remove();               // hide suggestions after the first question
    sendChat(ctx, text);
  }

  /** Append a bot answer bubble plus a source-chip row (grounded citations). */
  function botAnswer(answer, sources) {
    const bubble = h('div', { class: 'msg bot', style: { whiteSpace: 'pre-wrap' } }, answer);
    const group = h('div', { class: 'msg-group' }, bubble);
    const chips = (sources || []).map((s) => sourceChip(s)).filter(Boolean);
    if (chips.length) group.appendChild(h('div', { class: 'chat-src-row' },
      h('span', { class: 'chat-src-label' }, 'Sources'), ...chips));
    return group;
  }

  async function sendChat(ctx, text) {
    const { log, history, data, slug } = ctx;
    log.appendChild(h('div', { class: 'msg user' }, text));
    const typing = h('div', { class: 'msg bot typing' }, 'Thinking…');
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;

    ctx.busy = true; ctx.sendBtn.disabled = true; ctx.input.disabled = true;
    ctx.sendBtn.style.opacity = '.6';
    // Prior turns only — the worker appends this question itself.
    const priorHistory = history.slice();
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, question: text, history: priorHistory }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      typing.remove();
      const answer = (json && typeof json.answer === 'string' && json.answer.trim())
        ? json.answer.trim() : '(no answer)';
      log.appendChild(botAnswer(answer, json && json.sources));
      history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
    } catch (e) {
      typing.remove();
      log.appendChild(h('div', { class: 'msg bot' },
        'Chat isn’t reachable right now. On the deployed site this is served by the Cloudflare Worker (/api/chat); locally run “npm run dev” (wrangler) with the BEDROCK_API_KEY secret set. Opening the HTML file directly won’t reach the worker.'));
    } finally {
      ctx.busy = false; ctx.sendBtn.disabled = false; ctx.input.disabled = false;
      ctx.sendBtn.style.opacity = '';
      ctx.input.focus();
      log.scrollTop = log.scrollHeight;
    }
  }

  /* ======================================================================= *
   * INDUSTRY HEADER
   * ======================================================================= */
  /** The freshness + coverage strip: two independent axes, plus what's still
   *  gathering — so stale or thin data is visible, never a silent blank. */
  function renderFreshnessBar(data) {
    const cm = coverageModel(data);
    const segs = [];
    for (let i = 0; i < cm.total; i++) segs.push(h('i', { class: 'cov-seg' + (i < cm.filled ? '' : ' off') }));
    const dot = cm.dot || { tier: 'fresh', word: 'Current' };
    const chips = [];
    if (cm.updated) chips.push(h('span', { class: 'fb-chip', title: cm.updatedAbs ? 'Data updated ' + cm.updatedAbs : '' },
      h('span', { class: 'fb-ic', html: I.refresh }), 'Updated ' + cm.updated));
    chips.push(h('span', { class: 'fb-chip' }, 'Coverage', h('span', { class: 'cov-meter' }, ...segs), h('b', { class: 'tabnum' }, cm.filled + '/' + cm.total)));
    chips.push(h('span', { class: 'fb-chip' }, h('span', { class: 'fb-dot dot-' + dot.tier }), dot.word,
      h('span', { class: 'fb-score' }, '· ' + cm.score + '/100')));
    const wrap = h('div', { class: 'fade-in' }, h('div', { class: 'freshbar' }, ...chips));
    if (cm.missing.length) wrap.appendChild(h('div', { class: 'fb-gather' },
      h('span', { class: 'gskel' }), h('span', { class: 'gather-label' }, 'Still gathering:'),
      ...cm.missing.map((e) => h('span', { class: 'gchip' }, e.label))));
    return wrap;
  }

  function renderIndustryHeader(data) {
    const root = $('#industry-header');
    root.innerHTML = '';
    const m = data.meta || {};
    const aliases = (m.aliases || []).filter(has);

    // Update control: re-run research for THIS industry (same slug) and reload
    // when the data changes. Uses meta.query so slugify(query) === this slug.
    const refreshBtn = h('button', {
      class: 'hdr-refresh', type: 'button', title: 'Re-run research to bring this industry up to date',
      onClick: () => runResearch({ query: (m.query || m.name || m.slug), slug: m.slug, isRefresh: true }),
    }, h('span', { class: 'w-3.5 h-3.5', html: I.refresh }), 'Update');

    // The full written report is a DOWNLOAD, not a tab — one clickable button.
    const rep = data.summary && data.summary.report;
    const hasReport = (rep && Array.isArray(rep.sections) && rep.sections.length) || (data.summary && has(data.summary.report_markdown));
    const downloadBtn = h('button', {
      class: 'hdr-download', type: 'button', title: 'Download the full written report (PDF)',
      onClick: downloadReport,
    }, h('span', { class: 'w-3.5 h-3.5', html: I.download }), 'Download report');

    root.appendChild(h('div', { class: 'card fade-in relative overflow-hidden' },
      h('div', { class: 'absolute left-0 top-0 bottom-0 w-1.5', style: { background: 'linear-gradient(180deg,var(--chart-1),var(--chart-2))' } }),
      h('div', { class: 'card-body pl-6' },
        h('div', { class: 'flex items-start justify-between gap-3 flex-wrap' },
          h('div', { class: 'min-w-0' },
            h('div', { class: 'flex items-center gap-2.5 flex-wrap' },
              h('h1', { class: 'font-display font-extrabold text-[24px] sm:text-[27px] text-slate-900 tracking-tight leading-none' }, m.name || 'Industry'),
              m.is_manufacturing && h('span', { class: 'badge badge-brand' }, I ? h('span', { class: 'w-3 h-3', html: I.factory }) : null, 'Manufacturing')),
            has(m.definition) && h('p', { class: 'text-[13.5px] text-slate-500 leading-relaxed mt-2 max-w-3xl' }, m.definition)),
          h('div', { class: 'flex flex-col items-end gap-2 flex-shrink-0' },
            m.mock && h('span', { class: 'mock-flag' }, h('span', { class: 'w-1.5 h-1.5 rounded-full bg-current' }), 'Mock data'),
            m.mock ? null : h('div', { class: 'flex items-center gap-2 flex-wrap justify-end no-print' },
              hasReport ? downloadBtn : null, refreshBtn))),
        aliases.length ? h('div', { class: 'flex items-center gap-1.5 flex-wrap mt-3' },
          h('span', { class: 'text-[11px] font-semibold uppercase tracking-wide text-slate-400 mr-1' }, 'Also known as'),
          ...aliases.map((a) => h('span', { class: 'text-[11.5px] font-medium text-slate-500 bg-slate-100 rounded-md px-2 py-0.5' }, a))) : null,
      )));
    root.appendChild(renderFreshnessBar(data));
  }

  /** The written report is download-only: render it into the (screen-hidden)
   *  report panel, let the inline charts paint, then print. The print stylesheet
   *  shows only #panel-report, so the browser's "Save as PDF" captures the report. */
  function downloadReport() {
    if (!state.data) return;
    renderReport($('#panel-report'), state.data);
    setTimeout(() => { try { window.print(); } catch (e) {} }, 450);
  }

  /* ======================================================================= *
   * TABS + STATE
   * ======================================================================= */
  const TABS = [
    { id: 'deep', label: 'Deep Research', icon: I.chart },
    { id: 'benchmarking', label: 'Benchmarking', icon: I.bench, available: (d) => d && d.benchmarking && Array.isArray(d.benchmarking.peers) && d.benchmarking.peers.length > 0 },
    { id: 'youtube', label: 'YouTube', icon: I.video },
    { id: 'reports', label: 'Reports', icon: I.doc },
    { id: 'news', label: 'News', icon: I.news },
    { id: 'chat', label: 'Chat', icon: I.chat },
  ];
  const tabAvailable = (t) => (typeof t.available === 'function' ? t.available(state.data) : true);
  const state = { data: null, slug: null, index: null, activeTab: 'deep', activeSub: null };
  const renderedTabs = new Set();
  const renderedSubs = new Set();

  function buildTabbar() {
    const bar = $('#tabbar');
    bar.innerHTML = '';
    // A tab may declare availability (e.g. Benchmarking only when peers exist).
    if (!TABS.find((t) => t.id === state.activeTab && tabAvailable(t))) state.activeTab = 'deep';
    TABS.filter(tabAvailable).forEach((t) => bar.appendChild(h('button', {
      class: 'tab-btn' + (t.id === state.activeTab ? ' active' : ''), 'data-tab': t.id, role: 'tab',
      onClick: () => showTab(t.id),
    }, h('span', { html: t.icon }), t.label)));
  }

  function showTab(id) {
    state.activeTab = id;
    $$('#tabbar .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    TABS.forEach((t) => $('#panel-' + t.id).classList.toggle('hidden', t.id !== id));
    if (!renderedTabs.has(id)) { renderTab(id); renderedTabs.add(id); }
  }

  function renderTab(id) {
    const panel = $('#panel-' + id);
    if (id === 'deep') return renderDeepShell();
    if (id === 'benchmarking') return renderBenchmarking(panel, state.data);
    if (id === 'youtube') return renderYouTube(panel, state.data);
    if (id === 'reports') return renderReports(panel, state.data);
    if (id === 'news') return renderNews(panel, state.data);
    if (id === 'chat') return renderChat(panel, state.data);
  }

  function renderDeepShell() {
    const panel = $('#panel-deep');
    panel.innerHTML = '';
    const subs = DEEP_SUBS.filter((s) => s.available(state.data));
    if (!subs.length) { panel.appendChild(card({ hoverable: false, body: emptyState('Nothing to show yet', 'Deep research sections will populate from the industry file.') })); return; }
    if (!subs.find((s) => s.id === state.activeSub)) state.activeSub = subs[0].id;
    panel.appendChild(h('div', { class: 'subtabbar mb-1', id: 'deep-subtabbar' },
      ...subs.map((s) => h('button', { class: 'subtab-btn', 'data-sub': s.id, onClick: () => showSub(s.id) }, s.label))));
    panel.appendChild(h('div', { id: 'deep-subpanels', class: 'mt-3' },
      ...subs.map((s) => h('div', { class: 'deep-subpanel hidden fade-in', id: 'sub-' + s.id }))));
    showSub(state.activeSub);
  }

  function showSub(id) {
    state.activeSub = id;
    $$('#deep-subtabbar .subtab-btn').forEach((b) => b.classList.toggle('active', b.dataset.sub === id));
    $$('#deep-subpanels .deep-subpanel').forEach((p) => p.classList.toggle('hidden', p.id !== 'sub-' + id));
    if (!renderedSubs.has(id)) {
      const def = DEEP_SUBS.find((s) => s.id === id);
      if (def) def.render($('#sub-' + id), state.data);
      renderedSubs.add(id);
    }
  }

  /* ======================================================================= *
   * DATA LOADING
   * ======================================================================= */
  function showSkeleton() {
    const panel = $('#panel-deep');
    panel.innerHTML = '';
    panel.appendChild(h('div', { class: 'grid gap-4' },
      h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'shimmer h-6 w-2/3 mb-3' }), h('div', { class: 'shimmer h-4 w-1/2' }))),
      h('div', { class: 'grid gap-4 lg:grid-cols-2' },
        h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'shimmer h-52 w-full' }))),
        h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'shimmer h-52 w-full' }))))));
  }

  async function loadIndustry(slug) {
    stopRun();
    setView('dashboard');
    destroyCharts();
    renderedTabs.clear();
    renderedSubs.clear();
    TABS.forEach((t) => { if (t.id !== 'deep') $('#panel-' + t.id).innerHTML = ''; });
    showSkeleton();
    try {
      const res = await fetch(`./data/industries/${slug}.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.data = data; state.slug = slug;
      recordView(slug, (data.meta && data.meta.name) || slug);
      setIndustryLock((data.meta && data.meta.name) || slug);
      renderIndustryHeader(data);
      buildTabbar();   // rebuild with data-aware availability (e.g. Benchmarking only when peers exist)
      $('#footer-note').textContent = 'Showing ' + ((data.meta && data.meta.name) || slug);
      showTab(state.activeTab || 'deep');
    } catch (e) {
      $('#panel-deep').innerHTML = '';
      $('#panel-deep').appendChild(card({ hoverable: false, body: emptyState('Could not load “' + slug + '”', 'Check that public/data/industries/' + slug + '.json exists.') }));
    }
  }

  /* ======================================================================= *
   * SMART INPUT — the search box accepts an industry OR a company name, and
   * handles a not-yet-researched industry gracefully.
   *   1. Ask the Worker /api/resolve to classify + match.
   *   2. matched  → load it. not matched → offer to research it.
   *   3. If the Worker is unreachable (static-file view), fall back to a local
   *      index match; unknown queries still show the graceful card.
   * ======================================================================= */
  function slugifyLocal(s) {
    return String(s).toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-') || 'industry';
  }

  /** Local index match (real entries before mock), for the no-Worker fallback. */
  function localMatch(idx, q) {
    if (!idx || !Array.isArray(idx.industries) || !q) return null;
    const query = q.toLowerCase();
    const test = (it) => [it.slug, it.name, ...(it.aliases || [])].filter(Boolean).map((s) => s.toLowerCase())
      .some((s) => s === query || (query.length >= 3 && (s.includes(query) || query.includes(s))));
    return idx.industries.filter((it) => it && !it.mock).find(test)
      || idx.industries.filter((it) => it && it.mock).find(test) || null;
  }

  /* ---- View management: home (search + history) / dashboard / progress ---- */
  function setView(view) {
    $('#home-view').classList.toggle('hidden', view !== 'home');
    $('#progress-view').classList.toggle('hidden', view !== 'progress');
    const dash = view === 'dashboard';
    $('#industry-header').classList.toggle('hidden', !dash);
    $('#tabbar').classList.toggle('hidden', !dash);
    if (!dash) TABS.forEach((t) => $('#panel-' + t.id).classList.add('hidden'));
    // Topbar: a Back-to-search button on any non-home view; the locked industry
    // label (a static title, NOT a search box) only while viewing an industry.
    $('#back-btn').classList.toggle('hidden', view === 'home');
    $('#industry-lock').classList.toggle('hidden', !dash);
  }
  function setIndustryLock(name) {
    const el = $('#industry-lock');
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(h('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' }));
    el.appendChild(h('span', { class: 'lk-name' }, name || 'Industry'));
    el.title = name || '';
  }

  function goHome() {
    stopRun();
    $('#footer-note').textContent = 'Search an industry or company to begin';
    renderHome();
  }

  function handleSearch(q) {
    const query = String(q || '').trim();
    if (!query) return;
    resolveAndRoute(query);
  }

  async function resolveAndRoute(query, opts) {
    opts = opts || {};
    stopRun();
    $('#footer-note').textContent = 'Looking up “' + query + '”…';
    let info = null;
    try {
      const payload = { query };
      if (opts.sector) payload.sector = opts.sector;   // autocomplete hint: company's sector → industry
      const res = await fetch('/api/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (res.ok) info = await res.json();
    } catch (e) { info = null; }

    if (!info) {
      // No Worker reachable (opened as a file / offline) — match locally, else try to research.
      const m = localMatch(state.index, query);
      if (m) { $('#footer-note').textContent = ''; return loadIndustry(m.slug); }
      return runResearch({ query, slug: slugifyLocal(query), isRefresh: false, offline: true });
    }
    // Already researched → open it. Otherwise research it right away — the user
    // already clicked "Research it", so don't ask the same question again. The
    // company→industry detection (if any) is shown on the progress screen.
    if (info.matched && info.slug) { $('#footer-note').textContent = ''; return loadIndustry(info.slug); }
    runResearch({ query: info.industry_name, slug: info.slug, isRefresh: false, company: info.company });
  }

  /* ---- Runs: research (new) or update (refresh), with a friendly progress UI ---- */
  let runTimer = null, runActive = false;
  function stopRun() { if (runTimer) { clearInterval(runTimer); runTimer = null; } runActive = false; }

  /* No-interruption layer: an in-flight run is persisted, so a refresh / closing
   * the tab never loses it. On the next load we resume tracking (or surface the
   * finished result on the home page). Serializable by design — a run record is
   * { slug, name, since, sig, isRefresh, company, startedMs }. */
  const PENDING_KEY = 'irx-pending-v1';
  function readPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function writePending(p) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch (e) { /* private mode */ } }
  function setPending(rec) { const p = readPending(); p[rec.slug] = rec; writePending(p); }
  function clearPending(slug) { const p = readPending(); if (p[slug]) { delete p[slug]; writePending(p); } }
  function listPending() {
    const p = readPending(); const now = Date.now(); let changed = false;
    for (const k of Object.keys(p)) { if (!p[k] || now - (p[k].startedMs || 0) > 120 * 60000) { delete p[k]; changed = true; } }
    if (changed) writePending(p);
    return Object.values(p).sort((a, b) => (b.startedMs || 0) - (a.startedMs || 0));
  }
  /** Has a pending run's result actually landed on the deployed site yet? */
  async function isRunReady(rec) {
    try {
      const res = await fetch('./data/industries/' + rec.slug + '.json?t=' + Date.now(), { cache: 'no-cache' });
      if (!res.ok) return false;
      const text = await res.text();
      if (!rec.sig) return text.length > 200;               // new industry: it now exists with data
      return String(text.length) !== rec.sig;               // update: content changed
    } catch (e) { return false; }
  }

  const STAGES = [
    'Starting up…',
    'Fetching sources across the web',
    'Reading industry reports & PDFs',
    'Finding relevant YouTube videos',
    'Checking players, segments & margins',
    'Writing the summary report',
    'Finishing up…',
  ];

  /** Trigger a run and show the progress screen. cfg: { query, slug, isRefresh, offline } */
  async function runResearch(cfg) {
    stopRun();
    const name = cfg.query;
    const slug = cfg.slug || slugifyLocal(cfg.query);

    // For an update, remember the current file's fingerprint so we can detect a
    // REAL change (length differs). Stored in the run record so it survives a refresh.
    let since = '', sig = '';
    if (cfg.isRefresh) {
      try {
        const res = await fetch('./data/industries/' + slug + '.json?t=' + Date.now(), { cache: 'no-cache' });
        if (res.ok) { const text = await res.text(); sig = String(text.length);
          try { since = (JSON.parse(text).meta || {}).updated_at || ''; } catch (e) { /* ignore */ } }
      } catch (e) { /* no baseline -> first change reloads */ }
    }

    const ui = renderProgress({ name, isRefresh: cfg.isRefresh, company: cfg.company, slug });
    setView('progress');

    if (cfg.offline) return progressManual(ui, name, null);

    let resp = null;
    try {
      const r = await fetch('/api/research', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ industry: name }),
      });
      if (r.ok) resp = await r.json();
    } catch (e) { resp = null; }

    if (!resp || !resp.dispatched) return progressManual(ui, name, resp && resp.message);
    const rec = { slug: resp.slug || slug, name, since, sig, isRefresh: !!cfg.isRefresh, company: cfg.company || '', startedMs: Date.now() };
    setPending(rec);                       // persist so a refresh never loses the run
    startProgressLoop({ ui, ...rec });
  }

  /** Re-enter the progress screen for an already-dispatched run (after a refresh)
   *  WITHOUT re-triggering the workflow. */
  function resumeRun(rec) {
    const ui = renderProgress({ name: rec.name, isRefresh: rec.isRefresh, company: rec.company, slug: rec.slug });
    setView('progress');
    startProgressLoop({ ui, ...rec });
  }

  /** In-DOM confirm — a native confirm() is blocked inside a cross-origin iframe
   *  (and shows the worker's domain), so we render our own modal. Returns a Promise. */
  function confirmDialog(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const overlay = h('div', { class: 'modal-overlay' });
      let closed = false;
      const done = (v) => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); overlay.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); else if (e.key === 'Enter') done(true); };
      const okBtn = h('button', { class: 'modal-btn danger', type: 'button', onClick: () => done(true) }, opts.okText || 'Yes, cancel');
      overlay.appendChild(h('div', { class: 'modal-box', role: 'alertdialog', 'aria-modal': 'true' },
        opts.title ? h('div', { class: 'modal-title' }, opts.title) : null,
        h('div', { class: 'modal-msg' }, message),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'modal-btn ghost', type: 'button', onClick: () => done(false) }, opts.cancelText || 'Keep running'),
          okBtn)));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }

  /* ======================================================================= *
   * ANALYST ADD / EDIT — correct or add data from the dashboard. Each change
   * is persisted as an authoritative override (POST /api/edit) that the pipeline
   * replays LAST, so automated refreshes never clobber it; the edit also applies
   * optimistically in-memory so it shows instantly. Iframe-safe (in-DOM modal +
   * toast, no native dialogs). Never-fail: if saving isn't configured, the edit
   * still applies locally and a toast explains it won't persist yet.
   * ======================================================================= */
  const LOCAL_NUMERIC = new Set(['value', 'year', 'cagr_pct', 'share_pct', 'market_share_pct', 'revenue', 'revenue_year', 'revenue_cagr_3y_pct', 'ebitda_pct', 'ebitda_margin_pct', 'pat_pct', 'roce_pct', 'roe_pct', 'manufacturer_pct', 'retailer_pct', 'utilisation_pct']);
  const LOCAL_BENCH_METRICS = new Set(['revenue', 'revenue_cagr_3y_pct', 'ebitda_pct', 'pat_pct', 'roce_pct', 'roe_pct']);
  function coerceLocal(field, value) {
    if (LOCAL_NUMERIC.has(field)) { const n = Number(String(value).replace(/[,%\s₹$]/g, '')); if (isFinite(n)) return n; }
    return typeof value === 'string' ? value.trim() : value;
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const prev = $('.toast'); if (prev) prev.remove();
    const el = h('div', { class: 'toast' + (kind ? ' ' + kind : '') }, msg);
    document.body.appendChild(el);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { try { el.remove(); } catch (e) {} }, 6000);
  }

  function analystBadge() { return h('span', { class: 'analyst-badge', title: 'Added or corrected by an analyst — kept through automated refreshes' }, 'analyst'); }
  function editBtn(onClick, label) {
    return h('button', { class: 'edit-btn', type: 'button', title: label || 'Edit', 'aria-label': label || 'Edit',
      onClick: (e) => { e.stopPropagation(); onClick(); } }, h('span', { html: I.pencil }));
  }
  function addBtn(label, onClick) { return h('button', { class: 'add-btn', type: 'button', onClick }, h('span', { html: I.plus }), label); }
  /** Card-head cluster: an "analyst" badge (when the section was analyst-touched) + a pencil. */
  function editHead(obj, onEdit, label) { return h('span', { class: 'inline-flex items-center' }, obj && obj.analyst ? analystBadge() : null, editBtn(onEdit, label)); }

  /** A form modal. fields: [{key,label,value,kind:'number'|'text',placeholder,full}].
   *  Resolves { values:{key:{value,changed}}, source_url, note } or null. */
  function editModal(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const overlay = h('div', { class: 'modal-overlay' });
      let closed = false;
      const done = (v) => { if (closed) return; closed = true; document.removeEventListener('keydown', onKey); overlay.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      const inputs = {};
      const fieldEls = (opts.fields || []).map((f) => {
        const inp = h('input', { class: 'modal-input', type: f.kind === 'number' ? 'number' : 'text', step: f.kind === 'number' ? 'any' : null,
          value: f.value == null ? '' : String(f.value), placeholder: f.placeholder || '' });
        inputs[f.key] = { inp, orig: (f.value == null ? '' : String(f.value)).trim() };
        return h('label', { class: 'modal-field' + (f.full ? ' full' : '') }, h('span', { class: 'modal-flabel' }, f.label), inp);
      });
      let srcInp = null, noteInp = null;
      if (opts.allowSource) { srcInp = h('input', { class: 'modal-input', type: 'url', placeholder: 'https://… (optional)' }); fieldEls.push(h('label', { class: 'modal-field full' }, h('span', { class: 'modal-flabel' }, 'Source URL'), srcInp)); }
      if (opts.allowNote) { noteInp = h('input', { class: 'modal-input', type: 'text', placeholder: 'short note (optional)' }); fieldEls.push(h('label', { class: 'modal-field full' }, h('span', { class: 'modal-flabel' }, 'Note'), noteInp)); }
      const save = h('button', { class: 'modal-btn primary', type: 'button', onClick: () => {
        const values = {};
        for (const [k, o] of Object.entries(inputs)) { const val = o.inp.value.trim(); values[k] = { value: val, changed: val !== o.orig }; }
        done({ values, source_url: srcInp ? srcInp.value.trim() : '', note: noteInp ? noteInp.value.trim() : '' });
      } }, opts.saveText || 'Save');
      overlay.appendChild(h('div', { class: 'modal-box modal-box-form', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'modal-title' }, opts.title || 'Edit'),
        opts.subtitle ? h('div', { class: 'modal-sub' }, opts.subtitle) : null,
        h('div', { class: 'modal-form' }, ...fieldEls),
        h('div', { class: 'modal-actions' }, h('button', { class: 'modal-btn ghost', type: 'button', onClick: () => done(null) }, 'Cancel'), save)));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      const first = overlay.querySelector('.modal-input'); if (first) first.focus();
    });
  }

  /** Persist a batch of edits (optimistic apply already done by the caller). */
  async function submitEdits(edits) {
    if (!edits || !edits.length) return;
    let resp = null;
    try {
      const r = await fetch('/api/edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: state.slug, edits }) });
      if (r.ok) resp = await r.json();
    } catch (e) { resp = null; }
    if (resp && resp.saved) toast('Saved — committed to the repo. Your edit is kept through automated refreshes.');
    else if (resp && resp.configured === false) toast('Applied here. To persist it, set GITHUB_TOKEN / GITHUB_REPO on the Worker — it isn’t configured yet.', 'warn');
    else toast('Applied here, but saving to the repo failed — it may not persist.', 'err');
  }

  /** Re-render the current view from the mutated state.data (charts rebuilt cleanly). */
  function rerenderAfterEdit() {
    destroyCharts();
    renderedTabs.clear(); renderedSubs.clear();
    buildTabbar();
    showTab(TABS.find((t) => t.id === state.activeTab && tabAvailable(t)) ? state.activeTab : 'deep');
  }

  const pruneEdit = (e) => { const o = { section: e.section, target: e.target, field: e.field, value: e.value }; if (e.source_url) o.source_url = e.source_url; if (e.note) o.note = e.note; return o; };

  /** Build edits from a modal result, optimistically mutate `obj`, re-render, persist.
   *  opts: { skipKeys, pathMap (scalar routing), onEmpty }. Returns true if anything changed. */
  function applyEdits(section, target, obj, res, opts) {
    opts = opts || {};
    const edits = [];
    for (const [k, o] of Object.entries(res.values)) {
      if (opts.skipKeys && opts.skipKeys.includes(k)) continue;
      if (!o.changed || o.value === '') continue;               // never erase via a blank
      edits.push(pruneEdit({ section, target, field: k, value: o.value, source_url: res.source_url, note: res.note }));
      const val = coerceLocal(k, o.value);
      const path = opts.pathMap && opts.pathMap[k];
      if (path) { obj[path[0]] = obj[path[0]] || {}; obj[path[0]][path[1]] = val; }
      else obj[k] = val;
    }
    if (!edits.length) { if (opts.onEmpty) opts.onEmpty(); return false; }
    obj.analyst = true;
    obj.analyst_fields = Array.isArray(obj.analyst_fields) ? obj.analyst_fields : [];
    edits.forEach((e) => { if (!obj.analyst_fields.includes(e.field)) obj.analyst_fields.push(e.field); });
    if (res.source_url) obj.source = { label: res.note || 'Analyst edit', url: res.source_url };
    if (section === 'benchmarking') edits.forEach((e) => { if (LOCAL_BENCH_METRICS.has(e.field)) { obj.pending = false; if (obj.listed === undefined) obj.listed = true; } });
    rerenderAfterEdit();
    submitEdits(edits);
    return true;
  }

  /* ---- Edit entry points, one per editable target ---- */
  const PEER_FIELDS = () => ([
    { key: 'revenue', label: 'Revenue', kind: 'number' }, { key: 'revenue_unit', label: 'Revenue unit', kind: 'text' },
    { key: 'revenue_year', label: 'Revenue year', kind: 'number' }, { key: 'revenue_cagr_3y_pct', label: 'Rev 3Y CAGR %', kind: 'number' },
    { key: 'ebitda_pct', label: 'EBITDA %', kind: 'number' }, { key: 'pat_pct', label: 'PAT %', kind: 'number' },
    { key: 'roce_pct', label: 'RoCE %', kind: 'number' }, { key: 'roe_pct', label: 'RoE %', kind: 'number' },
  ]);
  async function editPeer(peer) {
    const res = await editModal({ title: 'Edit ' + peer.name, subtitle: 'Correct financials — analyst edits are badged and survive automated refreshes.',
      fields: PEER_FIELDS().map((f) => ({ ...f, value: peer[f.key] })), allowSource: true, allowNote: true });
    if (res) applyEdits('benchmarking', peer.name, peer, res);
  }
  async function addPeer() {
    const res = await editModal({ title: 'Add a peer', subtitle: 'Add a company to the benchmarking table.',
      fields: [{ key: 'name', label: 'Company name', kind: 'text', full: true }, { key: 'segment', label: 'Sub-segment', kind: 'text' }, { key: 'revenue', label: 'Revenue', kind: 'number' }, { key: 'revenue_unit', label: 'Revenue unit', kind: 'text', value: 'Rs Cr' }, { key: 'ebitda_pct', label: 'EBITDA %', kind: 'number' }, { key: 'roce_pct', label: 'RoCE %', kind: 'number' }],
      allowSource: true, allowNote: true, saveText: 'Add peer' });
    if (!res) return;
    const name = (res.values.name.value || '').trim();
    if (!name) return toast('A company name is required.', 'warn');
    const bench = state.data.benchmarking = (state.data.benchmarking && typeof state.data.benchmarking === 'object') ? state.data.benchmarking : {};
    if (!Array.isArray(bench.peers)) bench.peers = [];
    const peer = { name, added_by: 'analyst', listed: true, pending: false, segment: '' };
    bench.peers.push(peer);
    applyEdits('benchmarking', name, peer, res, { skipKeys: ['name'], onEmpty: () => {
      const i = bench.peers.indexOf(peer); if (i >= 0) bench.peers.splice(i, 1);
      toast('Add at least one value (e.g. revenue or sub-segment).', 'warn');
    } });
  }
  async function editPlayer(player) {
    const res = await editModal({ title: 'Edit ' + player.name, subtitle: 'Correct this player — analyst edits survive automated refreshes.',
      fields: [{ key: 'segment', label: 'Segment', kind: 'text', value: player.segment }, { key: 'market_share_pct', label: 'Market share %', kind: 'number', value: player.market_share_pct }, { key: 'revenue', label: 'Revenue', kind: 'number', value: player.revenue }, { key: 'revenue_unit', label: 'Revenue unit', kind: 'text', value: player.revenue_unit }, { key: 'ebitda_margin_pct', label: 'EBITDA %', kind: 'number', value: player.ebitda_margin_pct }, { key: 'note', label: 'Note', kind: 'text', value: player.note, full: true }],
      allowSource: true, allowNote: true });
    if (res) applyEdits('players', player.name, player, res);
  }
  async function addPlayer() {
    const res = await editModal({ title: 'Add a player', subtitle: 'Add a company to the players table.',
      fields: [{ key: 'name', label: 'Company name', kind: 'text', full: true }, { key: 'segment', label: 'Segment', kind: 'text' }, { key: 'market_share_pct', label: 'Market share %', kind: 'number' }, { key: 'note', label: 'Note', kind: 'text', full: true }],
      allowSource: true, allowNote: true, saveText: 'Add player' });
    if (!res) return;
    const name = (res.values.name.value || '').trim();
    if (!name) return toast('A company name is required.', 'warn');
    if (!Array.isArray(state.data.players)) state.data.players = [];
    const player = { name, added_by: 'analyst' };
    state.data.players.push(player);
    applyEdits('players', name, player, res, { skipKeys: ['name'], onEmpty: () => {
      const i = state.data.players.indexOf(player); if (i >= 0) state.data.players.splice(i, 1);
      toast('Add at least one value (e.g. segment or market share).', 'warn');
    } });
  }
  async function editSize() {
    const s = state.data.size = (state.data.size && typeof state.data.size === 'object') ? state.data.size : {};
    const cur = s.current = (s.current && typeof s.current === 'object') ? s.current : {};
    const res = await editModal({ title: 'Edit market size', subtitle: 'Correct the headline size / CAGR.',
      fields: [{ key: 'value', label: 'Current size', kind: 'number', value: cur.value }, { key: 'unit', label: 'Unit', kind: 'text', value: cur.unit }, { key: 'year', label: 'Year', kind: 'number', value: cur.year }, { key: 'cagr_pct', label: 'CAGR %', kind: 'number', value: s.cagr_pct }],
      allowSource: true });
    if (res) applyEdits('size', '', s, res, { pathMap: { value: ['current', 'value'], unit: ['current', 'unit'], year: ['current', 'year'] } });
  }
  async function editMargins() {
    const m = state.data.margins = (state.data.margins && typeof state.data.margins === 'object') ? state.data.margins : {};
    const res = await editModal({ title: 'Edit margins', subtitle: 'Correct the margin pool.',
      fields: [{ key: 'manufacturer_pct', label: 'Manufacturer %', kind: 'number', value: m.manufacturer_pct }, { key: 'retailer_pct', label: 'Retailer %', kind: 'number', value: m.retailer_pct }, { key: 'notes', label: 'Notes', kind: 'text', value: m.notes, full: true }],
      allowSource: true });
    if (res) applyEdits('margins', '', m, res);
  }

  /** Cancel a running research/update: stop the GitHub run (via the Worker) and
   *  stop tracking it locally. Never-fail: if the Worker can't cancel it, we still
   *  stop tracking and point the user to GitHub Actions. */
  async function cancelRun(rec) {
    if (!rec || !rec.slug) return;
    const yes = await confirmDialog('Cancel the research run for ' + (rec.name || 'this industry') + '? The gathered-so-far data is kept.',
      { title: 'Cancel run?', okText: 'Yes, cancel', cancelText: 'Keep running' });
    if (!yes) return;
    stopRun();
    let resp = null;
    try {
      const r = await fetch('/api/research-cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: rec.slug }),
      });
      if (r.ok) resp = await r.json();
    } catch (e) { resp = null; }
    clearPending(rec.slug);          // stop tracking here regardless of the server result
    goHome();
    $('#footer-note').textContent = (resp && resp.cancelled)
      ? 'Cancelled the run for ' + (rec.name || 'this industry') + '.'
      : ((resp && resp.message) || 'Stopped tracking this run. To fully stop it, cancel it in GitHub → Actions.');
  }

  /** Build the progress screen; returns handles the loop updates. */
  function renderProgress(o) {
    const host = $('#progress-view'); host.innerHTML = '';
    const bar = h('div', { class: 'prog-bar' });
    const pct = h('div', { class: 'prog-pct' }, '0%');
    const elapsed = h('div', { class: 'prog-elapsed' }, '0:00 elapsed');
    const stageNow = h('div', { class: 'prog-stage-now' }, STAGES[0]);
    const stages = h('ul', { class: 'prog-stages' }, ...STAGES.map((s) => h('li', {}, h('span', { class: 'st-dot' }), s)));
    const title = (o.isRefresh ? 'Updating ' : 'Researching ') + (o.name || 'this industry');
    const card = h('div', { class: 'prog-card' },
      h('div', { class: 'prog-head' }, h('div', { class: 'prog-spin' }),
        h('div', { class: 'min-w-0' },
          h('div', { class: 'prog-title' }, title),
          o.company ? h('div', { class: 'prog-detected' }, 'detected from “' + o.company + '”') : null,
          elapsed)),
      h('div', { class: 'prog-barwrap' }, bar), pct,
      stageNow, h('div', { class: 'prog-reassure' }, 'This usually takes a few minutes — you can leave this open, it updates on its own.'),
      stages,
      o.slug ? h('div', { class: 'prog-cancel-row' },
        h('button', { class: 'prog-cancel', type: 'button', onClick: () => cancelRun({ slug: o.slug, name: o.name }) }, 'Cancel run')) : null);
    host.appendChild(h('div', { class: 'prog-wrap' }, card));
    return { host, card, bar, pct, stageNow, stages, elapsed };
  }

  function startProgressLoop(o) {
    stopRun(); runActive = true;
    const TAU = o.isRefresh ? 45000 : 100000;     // asymptotic time constant (refresh is faster)
    let runDoneAt = 0, pollBusy = false, lastPoll = 0, displayPct = 0;
    const isNew = !o.sig;                          // no baseline fingerprint => a brand-new industry

    const fmt = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const setStage = (idx) => {
      const lis = o.ui.stages.querySelectorAll('li');
      lis.forEach((li, i) => {
        li.classList.toggle('st-done', i < idx);
        li.classList.toggle('st-active', i === idx);
        if (i < idx) li.querySelector('.st-dot').innerHTML = '<span style="font-size:10px;line-height:1">✓</span>';
        else li.querySelector('.st-dot').innerHTML = '';
      });
      o.ui.stageNow.textContent = STAGES[Math.min(idx, STAGES.length - 1)];
    };
    const finish = () => {
      stopRun(); clearPending(o.slug);
      o.ui.bar.style.width = '100%'; o.ui.pct.textContent = '100%';
      o.ui.stages.querySelectorAll('li').forEach((li) => {
        li.classList.remove('st-active'); li.classList.add('st-done');
        li.querySelector('.st-dot').innerHTML = '<span style="font-size:10px;line-height:1">✓</span>';
      });
      o.ui.stageNow.textContent = 'Complete';
      setTimeout(() => loadIndustry(o.slug), 650);
    };
    const fail = () => { stopRun(); clearPending(o.slug); progressFail(o.ui, o.name, () => runResearch({ query: o.name, slug: o.slug, isRefresh: o.isRefresh })); };

    const tick = async () => {
      const elapsed = Date.now() - o.startedMs;
      o.ui.elapsed.textContent = fmt(elapsed) + ' elapsed';
      const target = 90 * (1 - Math.exp(-elapsed / TAU));   // eases toward, never past, 90%
      displayPct = Math.max(displayPct, target);

      if (!pollBusy && Date.now() - lastPoll > 11000) {
        pollBusy = true; lastPoll = Date.now();
        try {
          // (a) the honest signal: can the frontend load the finished data now?
          const res = await fetch('./data/industries/' + o.slug + '.json?t=' + Date.now(), { cache: 'no-cache' });
          if (res.ok) {
            const text = await res.text();
            if (isNew ? text.length > 200 : String(text.length) !== o.sig) { pollBusy = false; return finish(); }
          }
          // (b) friendly run state — to detect failure, or a finished run whose data
          //     is still being published (deploy lag) / a no-op update.
          const qs = 'slug=' + encodeURIComponent(o.slug) + '&t=' + o.startedMs +
            (o.since ? '&since=' + encodeURIComponent(o.since) : '') + (o.sig ? '&sig=' + encodeURIComponent(o.sig) : '');
          const sres = await fetch('/api/research-status?' + qs, { cache: 'no-cache' });
          if (sres.ok) {
            const st = (await sres.json()).state;
            if (st === 'failed') { pollBusy = false; return fail(); }
            if (st === 'done' && !runDoneAt) runDoneAt = Date.now();
          }
        } catch (e) { /* keep going */ }
        pollBusy = false;
      }

      // Once the run itself has finished, hold near the top and say we're
      // publishing — the bar reaches 100% only when the data is really loadable.
      if (runDoneAt) { displayPct = Math.max(displayPct, 95); }
      o.ui.bar.style.width = displayPct.toFixed(1) + '%';
      o.ui.pct.textContent = Math.round(displayPct) + '%';
      setStage(Math.min(STAGES.length - 1, Math.floor((displayPct / 90) * (STAGES.length - 1))));
      if (runDoneAt) o.ui.stageNow.textContent = 'Publishing results…';
      else if (displayPct >= 88) o.ui.stageNow.textContent = STAGES[STAGES.length - 1] + '  still working…';

      // An update whose run finished but changed nothing (already current): end after a short grace.
      if (!isNew && runDoneAt && Date.now() - runDoneAt > 75000) return finish();
    };
    runTimer = setInterval(tick, 1000);
    tick();
  }

  function progressFail(ui, name, onRetry) {
    stopRun();
    ui.host.innerHTML = '';
    ui.host.appendChild(h('div', { class: 'prog-wrap' }, h('div', { class: 'prog-card' },
      h('div', { class: 'prog-fail' },
        h('div', { class: 'prog-fail-icon', html: I.warn }),
        h('div', { class: 'prog-fail-title' }, 'Something went wrong'),
        h('p', { class: 'prog-fail-sub' }, 'We couldn’t finish researching ' + (name || 'this industry') + ' this time. Please try again.'),
        h('div', { class: 'flex items-center gap-2.5' },
          h('button', { class: 'prog-btn', type: 'button', onClick: onRetry }, h('span', { class: 'w-4 h-4', html: I.refresh }), 'Try again'),
          h('button', { class: 'prog-btn ghost', type: 'button', onClick: goHome }, 'Back'))))));
  }

  function progressManual(ui, name, message) {
    stopRun();
    ui.host.innerHTML = '';
    const steps = message || ('Automatic research isn’t set up on this site yet, so this can’t run in one click. Once it’s configured, “Research it” and “Update” will start a run automatically.');
    ui.host.appendChild(h('div', { class: 'prog-wrap' }, h('div', { class: 'prog-card' },
      h('div', { class: 'prog-fail' },
        h('div', { class: 'prog-fail-icon', html: I.warn }),
        h('div', { class: 'prog-fail-title' }, 'Couldn’t start automatically'),
        h('p', { class: 'prog-fail-sub' }, steps),
        h('button', { class: 'prog-btn ghost', type: 'button', onClick: goHome }, 'Back to search')))));
  }

  /* ======================================================================= *
   * HISTORY — a record of every researched industry (index.json + each file's
   * meta), newest first. Click to open, Refresh to re-run. Your own recently-
   * viewed order is remembered locally (per browser).
   * ======================================================================= */
  const HISTORY_KEY = 'irx-history-v1';
  function readLocalHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function recordView(slug, name) {
    if (!slug) return;
    try {
      const hh = readLocalHistory();
      hh[slug] = { name: name || (hh[slug] && hh[slug].name) || slug, viewedAt: Date.now(), views: ((hh[slug] && hh[slug].views) || 0) + 1 };
      localStorage.setItem(HISTORY_KEY, JSON.stringify(hh));
    } catch (e) { /* localStorage unavailable — history still works from the index */ }
  }

  const industryDataCache = new Map();   // slug -> full data (fetched lazily for the list)
  async function fetchIndustry(slug) {
    if (industryDataCache.has(slug)) return industryDataCache.get(slug);
    let data = null;
    try {
      const res = await fetch('./data/industries/' + slug + '.json', { cache: 'no-cache' });
      if (res.ok) data = await res.json();
    } catch (e) { data = null; }
    industryDataCache.set(slug, data);
    return data;
  }

  /** Company autocomplete: a debounced assist under the home search. As the user
   *  types, /api/stock-search returns matching listed companies; picking one feeds
   *  the SAME resolve/research flow as typing (company + sector → industry). Plain
   *  industry-name search is untouched — the dropdown just closes on submit. Fully
   *  never-fail: if the endpoint errors or MUNS_TOKEN is unset, no dropdown shows. */
  function attachAutocomplete(input, wrap) {
    let dd = null, items = [], active = -1, seq = 0, timer = null;

    function close() { if (dd) { dd.remove(); dd = null; } items = []; active = -1; }
    function ensure() { if (!dd) { dd = h('div', { class: 'ac-dropdown', role: 'listbox' }); wrap.appendChild(dd); } return dd; }
    function choose(it) {
      input.value = it.name || it.ticker || '';
      close();
      resolveAndRoute(input.value, { sector: it.sector, company: it.name });
    }
    function render() {
      const el = ensure(); el.innerHTML = '';
      items.forEach((it, i) => {
        const meta = [it.sector, it.country].filter(Boolean).join(' · ');
        const row = h('div', { class: 'ac-item' + (i === active ? ' active' : ''), role: 'option' },
          h('div', { class: 'ac-text' },
            h('div', { class: 'ac-name' }, it.name || it.ticker || '—'),
            meta ? h('div', { class: 'ac-meta' }, meta) : null),
          it.ticker ? h('span', { class: 'ac-tick' }, it.ticker) : null);
        // mousedown (not click) so selection wins the race against input blur.
        row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
        el.appendChild(row);
      });
    }
    async function fetchList(q) {
      const my = ++seq;
      let data = null;
      try {
        const res = await fetch('/api/stock-search', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q }),
        });
        if (res.ok) data = await res.json();
      } catch (e) { data = null; }
      if (my !== seq) return;                                  // a newer keystroke superseded this
      items = data && Array.isArray(data.results) ? data.results : [];
      active = -1;
      if (items.length) render(); else close();
    }
    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (timer) clearTimeout(timer);
      if (q.length < 2) { seq++; close(); return; }            // seq++ voids any in-flight response
      timer = setTimeout(() => fetchList(q), 250);
    });
    input.addEventListener('keydown', (e) => {
      if (!dd || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); choose(items[active]); } }
      else if (e.key === 'Escape') { close(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150)); // let a click/tap land first
    return { close };
  }

  /** The search-first home: hero search + "Research it" + your research history. */
  function renderHome() {
    stopRun();
    setView('home');
    $('#footer-note').textContent = 'Search an industry or company to begin';
    const host = $('#home-view'); host.innerHTML = '';

    const input = h('input', { class: 'flex-1 min-w-0 border-0 outline-none bg-transparent text-[15px]', type: 'text',
      placeholder: 'Type an industry or company…', autocomplete: 'off', 'aria-label': 'Search industry or company' });
    const searchbar = h('div', { class: 'searchbar' },
      h('span', { class: 'flex-shrink-0', html: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>' }),
      input);
    const acWrap = h('div', { class: 'ac-wrap' }, searchbar);
    const ac = attachAutocomplete(input, acWrap);
    const form = h('form', { class: 'home-search', role: 'search' }, acWrap,
      h('button', { class: 'home-search-btn', type: 'submit' }, h('span', { class: 'w-4 h-4', html: I.refresh }), 'Research it'));
    form.addEventListener('submit', (e) => { e.preventDefault(); ac.close(); handleSearch(input.value); });

    host.appendChild(h('div', { class: 'home-hero' },
      h('h1', { class: 'home-title' }, 'What industry do you want to understand?'),
      h('p', { class: 'home-sub' }, 'Search any industry or company. If we haven’t researched it yet, start a run in one click.'),
      form,
      h('p', { class: 'home-hint' }, 'Try “MDF boards, India”, “Asian Paints”, or “solar rooftop EPC”.')));

    // In-flight / just-finished runs — so nothing is ever lost across a refresh.
    const pendingHost = h('div', { class: 'pending-wrap' });
    host.appendChild(pendingHost);
    renderPendingCards(pendingHost);

    const listHost = h('div', { class: 'hist-list' }, h('div', { class: 'hist-loading' }, 'Loading your research…'));
    const countEl = h('div', { class: 'home-section-count' }, '');
    host.appendChild(h('div', {},
      h('div', { class: 'home-section-head' }, h('div', { class: 'home-section-title' }, 'Your research'), countEl),
      listHost));
    input.focus();
    populateHistory(listHost, countEl);
  }

  /** Render any in-flight / just-finished runs at the top of home, so a refresh
   *  never leaves the user stranded — they can resume progress or open the result. */
  async function renderPendingCards(host) {
    host.innerHTML = '';
    const pend = listPending();
    if (!pend.length) return;
    for (const rec of pend) {
      const card = h('div', { class: 'pending-card' });
      host.appendChild(card);
      renderPendingRunning(card, rec);
      isRunReady(rec).then((ready) => { if (ready) renderPendingReady(card, rec); });
    }
  }
  function renderPendingRunning(card, rec) {
    const mins = Math.max(0, Math.floor((Date.now() - (rec.startedMs || Date.now())) / 60000));
    card.className = 'pending-card';
    card.innerHTML = '';
    card.appendChild(h('div', { class: 'pending-main' },
      h('span', { class: 'nr-spinner' }),
      h('div', { class: 'min-w-0' },
        h('div', { class: 'pending-name' }, (rec.isRefresh ? 'Updating ' : 'Researching ') + rec.name),
        h('div', { class: 'pending-sub' }, 'In progress' + (mins ? ' · started ' + mins + ' min ago' : '') + ' — this can take a few minutes.'))));
    card.appendChild(h('div', { class: 'pending-actions' },
      h('button', { class: 'pending-btn ghost', type: 'button', onClick: () => cancelRun(rec) }, 'Cancel'),
      h('button', { class: 'pending-btn', type: 'button', onClick: () => resumeRun(rec) }, 'View progress')));
  }
  function renderPendingReady(card, rec) {
    card.className = 'pending-card pending-done';
    card.innerHTML = '';
    card.appendChild(h('div', { class: 'pending-main' },
      h('span', { class: 'pending-check', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' }),
      h('div', { class: 'min-w-0' },
        h('div', { class: 'pending-name' }, rec.name + ' is ready'),
        h('div', { class: 'pending-sub' }, (rec.isRefresh ? 'Updated' : 'Research finished') + ' — open it to see the latest.'))));
    card.appendChild(h('button', { class: 'pending-btn primary', type: 'button',
      onClick: () => { clearPending(rec.slug); loadIndustry(rec.slug); } }, 'Open'));
  }

  async function populateHistory(listHost, countEl) {
    industryDataCache.clear();               // always reflect the latest committed files
    const idx = state.index;
    // Only real researched industries — leftover mock scaffolding never shows here.
    const entries = (idx && Array.isArray(idx.industries)) ? idx.industries.filter((e) => e && !e.mock) : [];
    if (!entries.length) {
      listHost.innerHTML = '';
      listHost.appendChild(emptyState('No research yet', 'Search an industry or company above to get started.'));
      return;
    }
    const local = readLocalHistory();
    const datas = await Promise.all(entries.map((e) => fetchIndustry(e.slug)));
    const now = Date.now();
    const rows = entries.map((e, i) => {
      const data = datas[i];
      const meta = (data && data.meta) || {};
      const when = meta.updated_at || meta.generated_at || null;
      const lv = local[e.slug];
      return { e, meta, cm: data ? coverageModel(data) : null, when, whenT: Date.parse(when || '') || 0, viewedAt: (lv && lv.viewedAt) || 0 };
    });
    rows.sort((a, b) => (b.whenT - a.whenT) || (b.viewedAt - a.viewedAt)); // newest research first, then your recent views
    if (countEl) countEl.textContent = entries.length + (entries.length === 1 ? ' industry' : ' industries');
    listHost.innerHTML = '';
    rows.forEach((r) => listHost.appendChild(historyRow(r, now)));
  }

  function historyRow(r, now) {
    const { e, meta, cm, when, viewedAt } = r;
    const slug = e.slug;
    const name = (meta && meta.name) || e.name || slug;
    const isCurrent = state.slug === slug;

    const bits = [];
    if (when) bits.push(h('span', { title: 'Data as of ' + when }, 'Updated ' + relativeTime(when, now)));
    else bits.push(h('span', { class: 'hist-dim' }, 'details unavailable'));
    if (cm) bits.push(h('span', {}, cm.filled + '/' + cm.total + ' sections'));
    if (cm && cm.score != null) bits.push(h('span', {}, cm.score + '/100'));
    if (viewedAt) bits.push(h('span', { class: 'hist-you' }, 'You viewed ' + relativeTime(new Date(viewedAt).toISOString(), now)));
    if (meta && meta.mock) bits.push(h('span', { class: 'hist-mock' }, 'mock'));

    const query = (meta && (meta.query || meta.name)) || name;
    const viewBtn = h('button', { class: 'hist-btn hist-view', type: 'button', title: 'Open the already-saved data (no waiting)', onClick: () => loadIndustry(slug) },
      h('span', { class: 'w-3.5 h-3.5', html: I.open }), 'View saved output');
    const updateBtn = h('button', { class: 'hist-btn hist-update', type: 'button', title: 'Re-run research to bring this up to date',
      onClick: () => runResearch({ query, slug, isRefresh: true }) },
      h('span', { class: 'w-3.5 h-3.5', html: I.refresh }), 'Update');

    return h('div', { class: 'hist-row' + (isCurrent ? ' hist-current' : '') },
      h('div', { class: 'hist-row-top' },
        h('div', { class: 'hist-main', onClick: () => loadIndustry(slug) },
          h('div', { class: 'hist-name' }, name, isCurrent ? h('span', { class: 'hist-badge' }, 'viewing') : null),
          bits.length ? h('div', { class: 'hist-meta' }, ...interpose(bits, '·')) : null),
        h('div', { class: 'hist-actions' }, viewBtn, updateBtn)));
  }

  function interpose(arr, sep) {
    const out = [];
    arr.forEach((x, i) => { if (i) out.push(h('span', { class: 'hist-sep' }, sep)); out.push(x); });
    return out;
  }

  async function init() {
    readPalette();
    if (window.Chart) {
      Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
      Chart.defaults.font.size = 12;
      Chart.defaults.color = '#64748b';
      Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15,23,42,0.92)';
      Chart.defaults.plugins.tooltip.padding = 10;
      Chart.defaults.plugins.tooltip.cornerRadius = 8;
      Chart.defaults.plugins.tooltip.titleFont = { weight: '700' };
    }
    buildTabbar();

    // Back to the search-first home: the brand block and the explicit Back button.
    const brand = $('#brand-home');
    if (brand) {
      brand.addEventListener('click', goHome);
      brand.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });
    }
    const backBtn = $('#back-btn');
    if (backBtn) backBtn.addEventListener('click', goHome);

    try {
      const res = await fetch('./data/industries/index.json', { cache: 'no-cache' });
      state.index = await res.json();
    } catch (e) {
      state.index = { default: 'mdf', industries: [{ slug: 'mdf', name: 'MDF Boards' }] };
    }
    // Default view is the search-first home — NOT an auto-loaded industry.
    renderHome();

    // Re-flow charts on resize (Chart.js handles most, this covers orientation changes)
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => chartRegistry.forEach((c) => { try { c.resize(); } catch (e) {} }), 150); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
