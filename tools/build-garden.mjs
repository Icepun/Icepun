/**
 * A contribution graph grown as a garden.
 *
 * Every day you committed is a seed. A slow wave crosses the year from left to
 * right and each one opens — a shoot, then leaves, then a bloom, sized by how
 * much you did that day. The garden holds and breathes for a few seconds, then
 * closes again in the same direction, back to bare ground where the loop began.
 *
 * Idle days never grow, so they cost nothing: they ship as a static dot with no
 * animation at all. On a real calendar that is over half the board, which is
 * why this variant is a fraction of the size of the others — and why the
 * growth reads as *his* year rather than decoration.
 *
 * Two SMIL rules are load-bearing and both fail silently, rendering a perfect
 * still image that never moves:
 *   * keyTimes must be strictly increasing — timestamps therefore keep four
 *     decimals even though coordinates round to one.
 *   * every keySplines control point must sit inside 0..1; unlike CSS
 *     cubic-bezier an overshoot is rejected outright rather than clamped.
 * assertPlayable() refuses to write a file that breaks either.
 *
 *   node tools/build-garden.mjs --out dist [--data contributions.json]
 *                               [--snapshot 1,4,7,11]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────── layout
const COLS = 53, ROWS = 7;
const PITCH = 15.6;
const PAD_X = 22, PAD_TOP = 22, PAD_BOT = 26;
const W = COLS * PITCH + PAD_X * 2 - PITCH + 13;
const H = ROWS * PITCH + PAD_TOP + PAD_BOT - PITCH + 13;

const CYCLE = 15;
const BARE = 0.5;          // ground before anything opens
const GROW_SPAN = 5.4;     // the wave's crossing time
const OPEN = 0.9;          // how long one plant takes to open
const HOLD = 3.2;          // full garden, breathing
const CLOSE_SPAN = 4.2;

const GROW_AT = BARE;
const HOLD_AT = GROW_AT + GROW_SPAN + OPEN;
const CLOSE_AT = HOLD_AT + HOLD;

const THEMES = {
  dark: {
    bg: "#0D1117", soil: "#2B3440",
    lv: ["#2B3440", "#4FA96A", "#79C96C", "#E0C24C", "#F2795F"],
    core: "#FFFFFF", coreOp: 0.34, label: "#5E6472",
  },
  light: {
    bg: "#FFFFFF", soil: "#E3E7EC",
    lv: ["#E3E7EC", "#3E9557", "#5CAE52", "#CFA518", "#E0674D"],
    core: "#FFFFFF", coreOp: 0.55, label: "#8A8F9A",
  },
};

const cx = (c) => PAD_X + c * PITCH;
const cy = (r) => PAD_TOP + r * PITCH;
const n = (v) => Number(v.toFixed(1));

// ─────────────────────────────────────────────── contribution data
function synthetic() {
  let seed = 20260814;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: COLS }, () => {
    const burst = rnd() < 0.3 ? 3 : 1;
    return Array.from({ length: ROWS }, (_, r) => {
      const v = rnd() * burst * (r === 0 || r === 6 ? 0.4 : 1.7);
      return v < 0.4 ? 0 : Math.round(v * 3);
    });
  });
}

function loadData(file) {
  if (!file || !existsSync(file)) return synthetic();
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const src =
    raw?.data?.user?.contributionsCollection?.contributionCalendar?.weeks ?? raw?.weeks;
  if (!Array.isArray(src)) return synthetic();
  const weeks = src.slice(-COLS).map((w) => {
    const d = (w.contributionDays ?? w).map((x) =>
      typeof x === "number" ? x : x.contributionCount ?? 0);
    while (d.length < ROWS) d.push(0);
    return d.slice(0, ROWS);
  });
  while (weeks.length < COLS) weeks.unshift(new Array(ROWS).fill(0));
  return weeks;
}

/** Doubling scale anchored on the median active day; 0 means bare ground. */
function makeScale(values) {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!active.length) return () => 0;
  const anchor = Math.max(active[Math.floor(active.length / 2)] || 1, 1.35);
  return (count) =>
    count ? 1 + Math.max(0, Math.min(3, Math.floor(Math.log2((count / anchor) * 2)))) : 0;
}

// ─────────────────────────────────────────────── bloom shapes
/** Petals ring a lit centre; the whole thing is drawn once and reused. */
function bloomDefs(t) {
  const petal = (px, py, r) => `<circle cx="${n(px)}" cy="${n(py)}" r="${r}"/>`;
  const ring = (count, dist, r) =>
    Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      return petal(Math.cos(a) * dist, Math.sin(a) * dist, r);
    }).join("");
  const core = (r) => `<circle r="${r}" fill="${t.core}" opacity="${t.coreOp}"/>`;

  // Petals overlap the centre rather than orbiting it. Spaced further out they
  // read as a plus sign or an asterisk at this size, not as a flower.
  return [
    // 1 — a shoot
    `<g id="g1"><circle r="2.6"/>${core(1.0)}</g>`,
    // 2 — first leaves
    `<g id="g2"><circle r="2.9"/>${petal(-3.4, 0.5, 2.0)}${petal(3.4, 0.5, 2.0)}${core(1.2)}</g>`,
    // 3 — four petals, turned so it reads as a bloom rather than a cross
    `<g id="g3" transform="rotate(45)"><circle r="3.0"/>${ring(4, 3.7, 2.5)}${core(1.5)}</g>`,
    // 4 — full bloom
    `<g id="g4"><circle r="3.2"/>${ring(6, 4.1, 2.5)}${core(1.9)}</g>`,
  ].join("");
}

// ─────────────────────────────────────────────── svg
function render(theme, grid, { animated = true } = {}) {
  const t = THEMES[theme];
  const T = `${CYCLE}s`;

  const kt = (a) => {
    const EPS = 1e-4;
    const out = [];
    let prev = -1;
    for (const v of a) {
      let x = Number(Math.max(0, Math.min(1, v / CYCLE)).toFixed(4));
      if (x <= prev) x = Number((prev + EPS).toFixed(4));
      out.push(x); prev = x;
    }
    out[out.length - 1] = 1;
    for (let i = out.length - 2; i >= 0 && out[i] >= out[i + 1]; i--) {
      out[i] = Number((out[i + 1] - EPS).toFixed(4));
    }
    return out.join(";");
  };

  const o = [];
  const add = (s) => o.push(s);
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}" role="img" aria-label="My GitHub contribution graph grown as a garden — every day I committed opens into a bloom">`);
  add(`<style>@media (prefers-reduced-motion:reduce){.fx{display:none}}</style>`);
  add(`<rect width="${n(W)}" height="${n(H)}" fill="${t.bg}"/>`);
  add(`<defs>${bloomDefs(t)}</defs>`);

  // bare ground under everything — idle days are only ever this
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS; r++)
      add(`<circle cx="${n(cx(c))}" cy="${n(cy(r))}" r="1.7" fill="${t.soil}"/>`);

  if (!animated) {
    for (let c = 0; c < COLS; c++)
      for (let r = 0; r < ROWS; r++) {
        const lv = grid[c][r];
        if (lv) add(`<use href="#g${lv}" transform="translate(${n(cx(c))},${n(cy(r))})" fill="${t.lv[lv]}"/>`);
      }
    add(`</svg>`);
    return o.join("");
  }

  const EASE_OPEN = ".2 .7 .3 1", EASE_CLOSE = ".5 0 .7 .25", FLAT = "0 0 1 1";

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const lv = grid[c][r];
      if (!lv) continue;   // bare ground never animates

      // the wave crosses by column, with a small offset down the week so a
      // column opens as a ripple rather than a single block
      const open = GROW_AT + (c / (COLS - 1)) * GROW_SPAN + r * 0.045;
      const close = CLOSE_AT + (c / (COLS - 1)) * CLOSE_SPAN + r * 0.03;

      const times = [0, open, open + OPEN, open + OPEN + 0.9, HOLD_AT + HOLD * 0.55, close, close + 0.7, CYCLE];
      const vals = ["0.001", "0.001", "1", "1.07", "1", "1", "0.001", "0.001"];
      const eases = [FLAT, EASE_OPEN, ".4 0 .5 1", ".4 0 .5 1", FLAT, EASE_CLOSE, FLAT];

      add(`<use class="fx" href="#g${lv}" transform="translate(${n(cx(c))},${n(cy(r))})" fill="${t.lv[lv]}">`);
      add(`<animateTransform attributeName="transform" type="scale" additive="sum" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt(times)}" values="${vals.join(";")}" keySplines="${eases.join(";")}"/>`);
      add(`</use>`);
    }
  }

  add(`<text x="${PAD_X - 4}" y="${n(H - 8)}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">EVERY DAY I COMMITTED, GROWN</text>`);
  add(`<text x="${n(W - PAD_X + 4)}" y="${n(H - 8)}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">CASUAL &#183; IDLE</text>`);
  add(`</svg>`);
  return o.join("");
}

/** Refuse to ship a file whose animations a browser will silently discard. */
function assertPlayable(svg, label) {
  const problems = [];
  for (const tag of svg.match(/<animate[A-Za-z]*\b[^>]*>/g) || []) {
    const kt = /keyTimes="([^"]+)"/.exec(tag);
    const vals = /values="([^"]+)"/.exec(tag);
    const spl = /keySplines="([^"]+)"/.exec(tag);
    if (!kt || !vals) continue;
    const T = kt[1].split(";").map(Number);
    const V = vals[1].split(";");
    if (T.some((x, i) => i && x <= T[i - 1])) problems.push(`keyTimes not increasing: ${kt[1]}`);
    if (T[0] !== 0 || T[T.length - 1] !== 1) problems.push(`keyTimes must span 0..1: ${kt[1]}`);
    if (T.length !== V.length) problems.push(`keyTimes/values mismatch (${T.length} vs ${V.length})`);
    if (spl) {
      const g = spl[1].split(";");
      if (g.length !== T.length - 1) problems.push(`keySplines count ${g.length}, expected ${T.length - 1}`);
      for (const s of g) {
        const cp = s.trim().split(/[\s,]+/).map(Number);
        if (cp.length !== 4 || cp.some((v) => !(v >= 0 && v <= 1)))
          problems.push(`keySplines outside 0..1: "${s.trim()}"`);
      }
    }
  }
  if (problems.length) {
    console.error(`\n  ${label}: ${problems.length} broken animation(s), e.g.`);
    for (const p of problems.slice(0, 3)) console.error(`    ${p}`);
    throw new Error(`${label} would render as a still image`);
  }
  return (svg.match(/<animate/g) || []).length;
}

// ─────────────────────────────────────────────── main
const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const outDir = argOf("--out", "dist");
mkdirSync(outDir, { recursive: true });

const weeks = loadData(argOf("--data", null));
const level = makeScale(weeks.flat());
const grid = Array.from({ length: COLS }, (_, c) =>
  Array.from({ length: ROWS }, (_, r) => level(weeks[c][r])));

/** Still of the garden at `time`; SMIL cannot be seeked outside a browser. */
function snapshot(theme, time) {
  const t = THEMES[theme];
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}">`,
    `<rect width="${n(W)}" height="${n(H)}" fill="${t.bg}"/>`, `<defs>${bloomDefs(t)}</defs>`];
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS; r++)
      o.push(`<circle cx="${n(cx(c))}" cy="${n(cy(r))}" r="1.7" fill="${t.soil}"/>`);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const lv = grid[c][r];
      if (!lv) continue;
      const open = GROW_AT + (c / (COLS - 1)) * GROW_SPAN + r * 0.045;
      const close = CLOSE_AT + (c / (COLS - 1)) * CLOSE_SPAN + r * 0.03;
      let s = 0;
      if (time >= open && time < open + OPEN) s = Math.min(1, (time - open) / OPEN);
      else if (time >= open + OPEN && time < close) s = 1;
      else if (time >= close && time < close + 0.7) s = Math.max(0, 1 - (time - close) / 0.7);
      if (s > 0.02)
        o.push(`<use href="#g${lv}" transform="translate(${n(cx(c))},${n(cy(r))}) scale(${n(s)})" fill="${t.lv[lv]}"/>`);
    }
  }
  o.push(`<text x="${n(W - PAD_X)}" y="14" text-anchor="end" font-family="monospace" font-size="9" fill="${t.label}">t = ${time.toFixed(1)}s</text></svg>`);
  return o.join("");
}

const snapAt = argOf("--snapshot", null);
if (snapAt) {
  for (const time of snapAt.split(",").map(Number)) {
    for (const theme of ["dark", "light"]) {
      const f = join(outDir, `gsnap-${theme}-${time.toFixed(1).replace(".", "_")}.svg`);
      writeFileSync(f, snapshot(theme, time), "utf8");
      console.log(`  ${f}`);
    }
  }
}

for (const theme of ["dark", "light"]) {
  const svg = render(theme, grid);
  const file = join(outDir, `garden-${theme}.svg`);
  const anims = assertPlayable(svg, `garden-${theme}.svg`);
  writeFileSync(file, svg, "utf8");
  console.log(`  ${file}  ${svg.length.toLocaleString()} B  ${anims} animations verified`);
}

const active = grid.flat().filter(Boolean).length;
console.log(`  ${active} plants, ${COLS * ROWS - active} bare cells (no animation), ${CYCLE}s loop`);
