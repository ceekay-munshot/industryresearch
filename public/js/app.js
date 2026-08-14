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
  };

  /* ----------------------------------------------------------------------- *
   * Reusable pieces
   * ----------------------------------------------------------------------- */
  function sourceChip(src, opts) {
    if (!src || !src.url) return null;
    const full = src.label || 'Source';
    const iconOnly = opts && opts.icon;
    const label = iconOnly ? '' : ((opts && opts.short) ? 'Source' : full);
    return h('a', {
      class: 'source-chip' + (iconOnly ? ' source-chip-icon' : ''), href: src.url, target: '_blank', rel: 'noopener noreferrer',
      title: src.snippet ? `${full} — ${src.snippet}` : full,
    }, h('span', { html: I.link }), label ? h('span', { class: 'src-label' }, label) : null);
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

  function metricPill(label, value, sub, accent) {
    return h('div', { class: 'metric-pill' }, h('div', {},
      h('div', { class: 'kpi-label' }, label),
      h('div', { class: 'flex items-baseline gap-1.5' },
        h('span', { class: 'kpi-value text-[22px]', style: accent ? { color: accent } : null }, value),
        sub && h('span', { class: 'text-[11px] text-slate-400 font-medium' }, sub),
      ),
    ));
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

  function secSize(data) {
    const size = data.size;
    if (!has(size) || (!has(size.current) && !has(size.history))) return null;
    const hist = (size.history || []).filter((p) => p && p.value != null);
    const body = h('div', {},
      h('div', { class: 'flex flex-wrap items-end gap-3 mb-4' },
        has(size.current) && metricPill('Current size', formatSize(size.current), size.current.year ? 'FY' + String(size.current.year).slice(-2) : null, 'var(--chart-1)'),
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
    return card({ title: 'Market size over time', subtitle: has(size.current) && size.current.unit ? `in ${size.current.unit}` : null, source: size.source, section: 'size', body });
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
        h('div', { class: 'cell-primary' }, p.name),
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
    const tableCard = card({ title: 'Players', subtitle: `${players.length} companies`, className: 'min-w-0', section: 'players', body: tableBody });

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
      available: (d) => has(d.summary) || has(d.size) || has(d.segments),
      render: (root, d) => appendChildren(root, [
        secHeadline(d),
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
    const news = ((data.sources && data.sources.news) || []).filter((n) => has(n.title));
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

  function renderChat(root, data) {
    root.innerHTML = '';
    const log = h('div', { class: 'chat-log', id: 'chat-log' });
    const nm = (data.meta && data.meta.name) || 'this industry';
    log.appendChild(h('div', { class: 'msg bot' }, `Hi! Ask me anything about ${nm}. (This is a scaffold — replies come from a stub for now.)`));

    const input = h('input', { class: 'flex-1 min-w-0 border-0 outline-none bg-transparent text-[14px]', type: 'text', placeholder: 'Ask a question…', autocomplete: 'off' });
    const form = h('form', { class: 'searchbar mt-4', style: { borderRadius: '14px' } },
      input,
      h('button', { class: 'text-white font-semibold text-[13px] rounded-lg px-4 py-1.5 flex-shrink-0', style: { background: 'var(--primary)' }, type: 'submit' }, 'Send'),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendChat(log, text, data);
    });

    root.appendChild(card({ hoverable: false, title: 'Chat', subtitle: 'ask about this industry',
      body: h('div', {}, h('div', { class: 'rounded-xl bg-slate-50 border border-[var(--border)] p-4', style: { minHeight: '340px', maxHeight: '52vh', overflowY: 'auto' } }, log), form) }));
    input.focus();
  }

  async function sendChat(log, text, data) {
    log.appendChild(h('div', { class: 'msg user' }, text));
    const typing = h('div', { class: 'msg bot typing' }, 'Thinking…');
    log.appendChild(typing);
    log.scrollTop = log.scrollHeight;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, industry: data.meta && data.meta.slug }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      typing.remove();
      log.appendChild(h('div', { class: 'msg bot' }, json.reply || '(no reply)'));
    } catch (e) {
      typing.remove();
      log.appendChild(h('div', { class: 'msg bot' }, 'Chat backend isn’t reachable yet. Run “npm run dev” (wrangler) to serve the /api/chat stub. This is expected when opening the file directly.'));
    }
    log.scrollTop = log.scrollHeight;
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
            m.mock && h('span', { class: 'mock-flag' }, h('span', { class: 'w-1.5 h-1.5 rounded-full bg-current' }), 'Mock data'))),
        aliases.length ? h('div', { class: 'flex items-center gap-1.5 flex-wrap mt-3' },
          h('span', { class: 'text-[11px] font-semibold uppercase tracking-wide text-slate-400 mr-1' }, 'Also known as'),
          ...aliases.map((a) => h('span', { class: 'text-[11.5px] font-medium text-slate-500 bg-slate-100 rounded-md px-2 py-0.5' }, a))) : null,
      )));
    root.appendChild(renderFreshnessBar(data));
  }

  /* ======================================================================= *
   * TABS + STATE
   * ======================================================================= */
  const TABS = [
    { id: 'deep', label: 'Deep Research', icon: I.chart },
    { id: 'report', label: 'Report', icon: I.report },
    { id: 'youtube', label: 'YouTube', icon: I.video },
    { id: 'reports', label: 'Reports', icon: I.doc },
    { id: 'news', label: 'News', icon: I.news },
    { id: 'chat', label: 'Chat', icon: I.chat },
  ];
  const state = { data: null, slug: null, index: null, activeTab: 'deep', activeSub: null };
  const renderedTabs = new Set();
  const renderedSubs = new Set();

  function buildTabbar() {
    const bar = $('#tabbar');
    bar.innerHTML = '';
    TABS.forEach((t) => bar.appendChild(h('button', {
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
    if (id === 'report') return renderReport(panel, state.data);
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
      renderIndustryHeader(data);
      $('#search-input').value = (data.meta && data.meta.name) || '';
      $('#footer-note').textContent = (data.meta && data.meta.mock) ? 'Showing mock data for ' + (data.meta.name || slug) : 'Showing ' + (data.meta && data.meta.name || slug);
      showTab(state.activeTab || 'deep');
    } catch (e) {
      $('#panel-deep').innerHTML = '';
      $('#panel-deep').appendChild(card({ hoverable: false, body: emptyState('Could not load “' + slug + '”', 'Check that public/data/industries/' + slug + '.json exists.') }));
    }
  }

  function handleSearch(q) {
    const idx = state.index;
    if (!idx || !idx.industries) return;
    const query = q.trim().toLowerCase();
    let match = null;
    if (query) {
      match = idx.industries.find((it) => {
        const hay = [it.slug, it.name, ...(it.aliases || [])].filter(Boolean).map((s) => s.toLowerCase());
        return hay.some((s) => s.includes(query) || query.includes(s));
      });
    }
    const target = match ? match.slug : (idx.default || (idx.industries[0] && idx.industries[0].slug));
    if (!target) return;
    if (query && !match) $('#footer-note').textContent = 'Only ' + idx.industries.map((i) => i.name).join(', ') + ' available in this scaffold — showing the default.';
    loadIndustry(target);
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

    $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); handleSearch($('#search-input').value); });

    try {
      const res = await fetch('./data/industries/index.json', { cache: 'no-cache' });
      state.index = await res.json();
    } catch (e) {
      state.index = { default: 'mdf', industries: [{ slug: 'mdf', name: 'MDF Boards' }] };
    }
    const first = (state.index && state.index.default) || (state.index && state.index.industries[0] && state.index.industries[0].slug) || 'mdf';
    loadIndustry(first);

    // Re-flow charts on resize (Chart.js handles most, this covers orientation changes)
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => chartRegistry.forEach((c) => { try { c.resize(); } catch (e) {} }), 150); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
