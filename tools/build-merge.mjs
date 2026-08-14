/**
 * A contribution graph that merges itself.
 *
 * Adjacent days of equal weight slide together and fuse into one brighter
 * tile, the way a merge puzzle consolidates a board. Waves of merges ripple
 * across the year, the graph quietly tidies itself into fewer and stronger
 * marks, and then settles back to the opening arrangement so the loop does
 * not cut.
 *
 * There is no gravity here, which is the whole reason this variant is cheap:
 * only the cells a merge actually touched need restoring at the end, so most
 * of the 371 tiles ship as a static <use> with no animation at all.
 *
 * Two SMIL rules are load-bearing and both fail silently — the file renders a
 * perfect still image and never moves:
 *   * keyTimes must be strictly increasing, so timestamps keep four decimals
 *     even though coordinates round to one.
 *   * every keySplines control point must sit inside 0..1; unlike CSS
 *     cubic-bezier, an overshoot is rejected rather than clamped.
 * assertPlayable() refuses to write a file that breaks either.
 *
 *   node tools/build-merge.mjs --out dist [--data contributions.json]
 *                              [--snapshot 2.5,6,10]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────── layout
const COLS = 53, ROWS = 7;
const CELL = 12, GAP = 3.4, PITCH = CELL + GAP;
const PAD_X = 20, PAD_TOP = 20, PAD_BOT = 26;
const W = COLS * PITCH - GAP + PAD_X * 2;
const H = ROWS * PITCH - GAP + PAD_TOP + PAD_BOT;

const CYCLE = 14;
const SETTLE = 0.9;
const WAVES = 5;
const WAVE = 1.9;
const PER_WAVE = 9;        // merges in flight per wave
const STAGGER = 0.075;     // between merges inside a wave
const SLIDE = 0.52;        // travel time of the absorbed tile
const RESET_AT = SETTLE + WAVES * WAVE + 0.5;

const THEMES = {
  dark: {
    bg: "#0D1117",
    tiles: ["#39424E", "#3FC7BC", "#5CB8FF", "#FFC94A", "#FF7B96"],
    gloss: "#FFFFFF", glossOp: 0.16, label: "#5E6472",
  },
  light: {
    bg: "#FFFFFF",
    tiles: ["#D3DAE3", "#31B5AA", "#3D9DE0", "#F2AE1F", "#F26178"],
    gloss: "#FFFFFF", glossOp: 0.42, label: "#8A8F9A",
  },
};

const tileX = (c) => PAD_X + c * PITCH;
const tileY = (r) => PAD_TOP + r * PITCH;
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

/** Doubling scale anchored on the median active day; 0 means an idle day. */
function makeScale(values) {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!active.length) return () => 0;
  const anchor = Math.max(active[Math.floor(active.length / 2)] || 1, 1.35);
  return (count) => {
    if (!count) return 0;
    return 1 + Math.max(0, Math.min(3, Math.floor(Math.log2((count / anchor) * 2))));
  };
}

// ─────────────────────────────────────────────── simulation
function simulate(weeks) {
  const level = makeScale(weeks.flat());
  const grid = Array.from({ length: COLS }, (_, c) =>
    Array.from({ length: ROWS }, (_, r) => level(weeks[c][r])));
  const original = grid.map((col) => col.slice());

  let id = 0;
  const tiles = [];
  const at = Array.from({ length: COLS }, () => new Array(ROWS));
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const t = { id: id++, c, r, color: grid[c][r], born: 0, died: null, slide: null, pop: false };
      tiles.push(t);
      at[c][r] = t;
    }
  }

  const merges = [];
  const touched = new Set();
  const key = (c, r) => `${c}:${r}`;

  /** Adjacent same-weight pairs that are worth fusing, strongest first. */
  function candidates() {
    const out = [];
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const v = grid[c][r];
        if (!v || v >= 4) continue;
        for (const [dc, dr] of [[1, 0], [0, 1]]) {
          const c2 = c + dc, r2 = r + dr;
          if (c2 >= COLS || r2 >= ROWS) continue;
          if (grid[c2][r2] !== v) continue;
          out.push({ from: [c2, r2], to: [c, r], v });
        }
      }
    }
    return out;
  }

  for (let w = 0; w < WAVES; w++) {
    const tWave = SETTLE + w * WAVE;
    const pool = candidates().sort((a, b) => b.v - a.v);
    const used = new Set();
    let placed = 0;

    for (const cand of pool) {
      if (placed >= PER_WAVE) break;
      const [fc, fr] = cand.from, [tc, tr] = cand.to;
      if (used.has(key(fc, fr)) || used.has(key(tc, tr))) continue;
      // keep the wave spread out rather than clustered in one week
      if ([...used].some((k) => Math.abs(Number(k.split(":")[0]) - tc) < 3)) continue;

      const t = tWave + placed * STAGGER;
      const src = at[fc][fr], dst = at[tc][tr];

      src.slide = { t, toC: tc, toR: tr };
      src.died = t + SLIDE;
      dst.died = t + SLIDE;

      const fused = {
        id: id++, c: tc, r: tr, color: Math.min(4, cand.v + 1),
        born: t + SLIDE, died: null, slide: null, pop: true,
      };
      const emptied = {
        id: id++, c: fc, r: fr, color: 0,
        born: t + SLIDE + 0.06, died: null, slide: null, pop: false,
      };
      tiles.push(fused, emptied);
      at[tc][tr] = fused;
      at[fc][fr] = emptied;
      grid[tc][tr] = fused.color;
      grid[fc][fr] = 0;

      used.add(key(fc, fr)); used.add(key(tc, tr));
      touched.add(key(fc, fr)); touched.add(key(tc, tr));
      merges.push({ t, from: [fc, fr], to: [tc, tr], color: fused.color });
      placed++;
    }
  }

  // ── settle back
  // Only cells a merge actually touched are restored; with no gravity in this
  // variant nothing else ever moved, so the rest of the board stays static.
  for (const k of touched) {
    const [c, r] = k.split(":").map(Number);
    const cur = at[c][r];
    const out = RESET_AT + 0.012 * c;
    cur.died = out + 0.5;
    const back = {
      id: id++, c, r, color: original[c][r],
      born: out + 0.42, died: null, slide: null, pop: false, gentle: true,
    };
    tiles.push(back);
    at[c][r] = back;
  }

  return { tiles, merges, original, touched };
}

// ─────────────────────────────────────────────── svg
function render(theme, sim, { animated = true } = {}) {
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
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="My GitHub contribution graph, merging itself into fewer and brighter marks">`);
  add(`<style>@media (prefers-reduced-motion:reduce){.fx{display:none}}</style>`);
  add(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  add(`<defs><g id="tl"><rect width="${CELL}" height="${CELL}" rx="3.6"/><rect x="1.4" y="1.4" width="${n(CELL - 2.8)}" height="${n(CELL * 0.42)}" rx="2.2" fill="${t.gloss}" opacity="${t.glossOp}"/></g></defs>`);

  if (!animated) {
    for (let c = 0; c < COLS; c++)
      for (let r = 0; r < ROWS; r++)
        add(`<use href="#tl" x="${n(tileX(c))}" y="${n(tileY(r))}" fill="${t.tiles[sim.original[c][r]]}"/>`);
    add(`</svg>`);
    return o.join("");
  }

  const EASE = ".35 0 .2 1", HOLD = "0 0 1 1";

  for (const tl of sim.tiles) {
    const x = tileX(tl.c), y = tileY(tl.r);
    const fill = t.tiles[tl.color];

    if (tl.born === 0 && tl.died == null && !tl.slide) {
      add(`<use href="#tl" x="${n(x)}" y="${n(y)}" fill="${fill}"/>`);
      continue;
    }

    // opacity: appear, then leave
    const oT = [0], oV = [tl.born > 0 ? 0 : 1];
    if (tl.born > 0) { oT.push(tl.born - 0.01, tl.born + (tl.gentle ? 0.3 : 0.14)); oV.push(0, 1); }
    if (tl.died != null) {
      oT.push(Math.max(0.02, tl.died - (tl.slide ? 0.14 : 0.3)), tl.died, CYCLE);
      oV.push(1, 0, 0);
    } else { oT.push(CYCLE); oV.push(1); }
    const fade = `<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" keyTimes="${kt(oT)}" values="${oV.join(";")}"/>`;

    if (tl.slide) {
      // the absorbed tile travels into its partner and is gone on arrival
      const s = tl.slide;
      const tx = tileX(s.toC), ty = tileY(s.toR);
      const times = [0, Math.max(0.001, s.t), s.t + SLIDE, CYCLE];
      const ax = `<animate attributeName="x" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt(times)}" values="${n(x)};${n(x)};${n(tx)};${n(tx)}" keySplines="${HOLD};${EASE};${HOLD}"/>`;
      const ay = `<animate attributeName="y" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt(times)}" values="${n(y)};${n(y)};${n(ty)};${n(ty)}" keySplines="${HOLD};${EASE};${HOLD}"/>`;
      add(`<use class="fx" href="#tl" x="${n(x)}" y="${n(y)}" fill="${fill}">${ax}${ay}${fade}</use>`);
      continue;
    }

    if (tl.pop) {
      // the fused tile swells once as it takes on the higher weight
      const b = tl.born;
      const sc = `<animateTransform attributeName="transform" type="scale" additive="sum" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt([0, Math.max(0.01, b - 0.02), b + 0.16, b + 0.42, CYCLE])}" values="1;1;1.22;1;1" keySplines="${HOLD};.25 .7 .35 1;.4 0 .25 1;${HOLD}"/>`;
      add(`<g class="fx" transform="translate(${n(x + CELL / 2)},${n(y + CELL / 2)})">${sc}<use href="#tl" x="${n(-CELL / 2)}" y="${n(-CELL / 2)}" fill="${fill}">${fade}</use></g>`);
      continue;
    }

    add(`<use class="fx" href="#tl" x="${n(x)}" y="${n(y)}" fill="${fill}">${fade}</use>`);
  }

  // a soft ring where each fusion lands
  for (const m of sim.merges) {
    const cx = tileX(m.to[0]) + CELL / 2, cy = tileY(m.to[1]) + CELL / 2;
    const k = m.t + SLIDE;
    add(`<g class="fx"><circle cx="${n(cx)}" cy="${n(cy)}" fill="none" stroke="${t.tiles[m.color]}" stroke-width="1.6" opacity="0">`);
    add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" keyTimes="${kt([0, k, k + 0.02, k + 0.5, CYCLE])}" values="0;0;.5;0;0"/>`);
    add(`<animate attributeName="r" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt([0, k, k + 0.5, CYCLE])}" values="5;5;14;14" keySplines="${HOLD};.15 .7 .3 1;${HOLD}"/>`);
    add(`</circle></g>`);
  }

  add(`<text x="${PAD_X}" y="${H - 8}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">A YEAR OF COMMITS, MERGING ITSELF</text>`);
  add(`<text x="${W - PAD_X}" y="${H - 8}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">CASUAL &#183; MOBILE</text>`);
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
    if (T.length !== V.length) problems.push(`keyTimes/values mismatch`);
    if (spl) {
      const groups = spl[1].split(";");
      if (groups.length !== T.length - 1) problems.push(`keySplines count wrong`);
      for (const g of groups) {
        const cp = g.trim().split(/[\s,]+/).map(Number);
        if (cp.length !== 4 || cp.some((v) => !(v >= 0 && v <= 1)))
          problems.push(`keySplines outside 0..1: "${g.trim()}"`);
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

const sim = simulate(loadData(argOf("--data", null)));

/** A still of the board at `time` — SMIL cannot be seeked outside a browser. */
function snapshot(theme, time) {
  const t = THEMES[theme];
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `<rect width="${W}" height="${H}" fill="${t.bg}"/>`,
    `<defs><g id="tl"><rect width="${CELL}" height="${CELL}" rx="3.6"/><rect x="1.4" y="1.4" width="${n(CELL - 2.8)}" height="${n(CELL * 0.42)}" rx="2.2" fill="${t.gloss}" opacity="${t.glossOp}"/></g></defs>`];
  for (const tl of sim.tiles) {
    if (time < tl.born) continue;
    if (tl.died != null && time >= tl.died) continue;
    let x = tileX(tl.c), y = tileY(tl.r), s = 1;
    if (tl.slide && time > tl.slide.t) {
      const k = Math.min(1, (time - tl.slide.t) / SLIDE);
      x += (tileX(tl.slide.toC) - x) * k;
      y += (tileY(tl.slide.toR) - y) * k;
    }
    if (tl.pop && time > tl.born && time < tl.born + 0.42) {
      const k = (time - tl.born) / 0.42;
      s = 1 + 0.22 * (k < 0.38 ? k / 0.38 : (1 - (k - 0.38) / 0.62));
    }
    if (s === 1) o.push(`<use href="#tl" x="${n(x)}" y="${n(y)}" fill="${t.tiles[tl.color]}"/>`);
    else o.push(`<g transform="translate(${n(x + CELL / 2)},${n(y + CELL / 2)}) scale(${n(s)})"><use href="#tl" x="${n(-CELL / 2)}" y="${n(-CELL / 2)}" fill="${t.tiles[tl.color]}"/></g>`);
  }
  o.push(`<text x="${W - PAD_X}" y="14" text-anchor="end" font-family="monospace" font-size="9" fill="${t.label}">t = ${time.toFixed(1)}s</text></svg>`);
  return o.join("");
}

const snapAt = argOf("--snapshot", null);
if (snapAt) {
  for (const time of snapAt.split(",").map(Number)) {
    const f = join(outDir, `msnap-${time.toFixed(1).replace(".", "_")}.svg`);
    writeFileSync(f, snapshot("dark", time), "utf8");
    console.log(`  ${f}`);
  }
}

for (const theme of ["dark", "light"]) {
  const svg = render(theme, sim);
  const file = join(outDir, `merge-${theme}.svg`);
  const anims = assertPlayable(svg, `merge-${theme}.svg`);
  writeFileSync(file, svg, "utf8");
  console.log(`  ${file}  ${svg.length.toLocaleString()} B  ${anims} animations verified`);
}

const statics = sim.tiles.filter((t) => t.born === 0 && t.died == null && !t.slide).length;
console.log(`  ${sim.tiles.length} tiles (${statics} static), ${sim.merges.length} merges, ${CYCLE}s loop`);
