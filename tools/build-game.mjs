/**
 * A contribution graph, played as a casual blast puzzle.
 *
 * The grid is the real calendar — activity level picks each tile's colour, so
 * busy stretches stay legible as clusters. Groups of matching tiles clear, the
 * column above collapses under gravity, fresh tiles drop in from the top, and
 * when a refill lands on another match it chains. The cycle closes with a full
 * board sweep that restores the opening arrangement, so the loop is seamless
 * rather than cutting.
 *
 * The whole run is simulated at build time and emitted as fixed keyframes:
 * every animation shares one duration, and tiles that never move and never
 * clear ship as plain rects with no animation at all, which keeps the file to
 * roughly the size of a screenshot.
 *
 * No script, no webfont, no external reference — the constraints that let it
 * survive being served as an <img> from raw.githubusercontent.com.
 *
 *   node tools/build-game.mjs --out dist [--data contributions.json]
 *                             [--snapshot 3.5,7,11]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────── layout
const COLS = 53, ROWS = 7;
const CELL = 12, GAP = 3.4, PITCH = CELL + GAP;
const PAD_X = 20, PAD_TOP = 20, PAD_BOT = 26;
const GRID_W = COLS * PITCH - GAP;
const GRID_H = ROWS * PITCH - GAP;
const W = GRID_W + PAD_X * 2;
const H = GRID_H + PAD_TOP + PAD_BOT;

const CYCLE = 14;   // reset lands ~11.8s; the rest is a breath before the loop
const SETTLE = 1.2;        // beat before the first clear
const ROUND = 1.8;         // one clear, collapse and refill
const ROUNDS = 4;
const RESET_AT = SETTLE + ROUNDS * ROUND + 0.4;
const RESET_LEN = 3.0;

// within a round
const T_SELECT = 0.0, T_POP = 0.36, T_FALL = 0.72, T_LAND = 1.34;
const CASCADE_DELAY = 0.55;

const THEMES = {
  dark: {
    bg: "#0D1117",
    tiles: ["#39424E", "#3FC7BC", "#5CB8FF", "#FFC94A", "#FF7B96"],
    gloss: "#FFFFFF", glossOp: 0.16,
    edge: "#000000", edgeOp: 0.14,
    spark: "#FFFFFF", label: "#5E6472",
  },
  light: {
    bg: "#FFFFFF",
    tiles: ["#D3DAE3", "#31B5AA", "#3D9DE0", "#F2AE1F", "#F26178"],
    gloss: "#FFFFFF", glossOp: 0.42,
    edge: "#000000", edgeOp: 0.10,
    spark: "#FFFFFF", label: "#8A8F9A",
  },
};

const tileX = (c) => PAD_X + c * PITCH;
const tileY = (r) => PAD_TOP + r * PITCH;
const n = (v) => Number(v.toFixed(1));

// ─────────────────────────────────────────────── contribution data
function synthetic() {
  let seed = 20260814;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const weeks = [];
  for (let c = 0; c < COLS; c++) {
    const days = [];
    const burst = rnd() < 0.3 ? 3 : 1;
    for (let r = 0; r < ROWS; r++) {
      const weekend = r === 0 || r === 6;
      const v = rnd() * burst * (weekend ? 0.4 : 1.7);
      days.push(v < 0.4 ? 0 : Math.round(v * 3));
    }
    weeks.push(days);
  }
  return weeks;
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

/**
 * Colour index from a doubling scale anchored on the median active day.
 * A ratio against the busiest day collapses an ordinary week into one bucket
 * as soon as there is a single outlier; value quartiles fail too, because most
 * active days share the same small count and the boundaries land on top of
 * each other. Index 0 is reserved for days with nothing on them.
 */
function makeScale(values) {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!active.length) return () => 0;
  const anchor = Math.max(active[Math.floor(active.length / 2)] || 1, 1.35);
  return (count) => {
    if (!count) return 0;
    const step = Math.floor(Math.log2((count / anchor) * 2));
    return 1 + Math.max(0, Math.min(3, step));
  };
}

// ─────────────────────────────────────────────── simulation
let nextId = 0;
const mkTile = (col, color, row) => ({
  id: nextId++,
  col, color,
  moves: [{ t: 0, row }],   // (time, row) keyframes; x never changes
  born: 0,                  // visible from
  died: null,               // cleared at
  spawn: null,              // dropped in from above at
});

function connectedGroup(grid, sc, sr, seen) {
  const color = grid[sc][sr];
  const out = [];
  const stack = [[sc, sr]];
  const key = (c, r) => c * ROWS + r;
  while (stack.length) {
    const [c, r] = stack.pop();
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
    if (seen.has(key(c, r))) continue;
    if (grid[c][r] !== color) continue;
    seen.add(key(c, r));
    out.push([c, r]);
    stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
  }
  return out;
}

/** Every matching cluster on the board, largest first. */
function findGroups(grid, min = 5) {
  const seen = new Set();
  const groups = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (seen.has(c * ROWS + r)) continue;
      const g = connectedGroup(grid, c, r, seen);
      if (g.length >= min) groups.push(g);
    }
  }
  return groups.sort((a, b) => b.length - a.length);
}

const groupCentre = (g) => g.reduce((s, [c]) => s + c, 0) / g.length;

/**
 * Keep a blast compact: the cells nearest the cluster's middle, capped.
 *
 * A whole connected run of same-level days can stretch most of the year, and
 * clearing all of it both looks diffuse and dirties every column — which then
 * forces every tile on the board into the closing sweep. A tight burst of ten
 * reads better and leaves most of the graph untouched.
 */
function trimGroup(g, cap = 10) {
  if (g.length <= cap) return g;
  const mc = groupCentre(g);
  const mr = g.reduce((s, [, r]) => s + r, 0) / g.length;
  return [...g]
    .sort((a, b) =>
      ((a[0] - mc) ** 2 + (a[1] - mr) ** 2) - ((b[0] - mc) ** 2 + (b[1] - mr) ** 2))
    .slice(0, cap);
}

function simulate(weeks) {
  const level = makeScale(weeks.flat());
  const grid = [];        // colour index per cell
  const at = [];          // tile id per cell
  const tiles = [];

  for (let c = 0; c < COLS; c++) {
    grid[c] = []; at[c] = [];
    for (let r = 0; r < ROWS; r++) {
      const color = level(weeks[c][r]);
      const t = mkTile(c, color, r);
      tiles.push(t);
      grid[c][r] = color;
      at[c][r] = t.id;
    }
  }
  const original = grid.map((col) => col.slice());
  const byId = new Map(tiles.map((t) => [t.id, t]));

  /** Clear a group, collapse its columns, refill from the top. */
  function resolve(group, tClear) {
    const cleared = [];
    for (const [c, r] of group) {
      const t = byId.get(at[c][r]);
      t.died = tClear + T_POP;
      t.popped = true;
      cleared.push({ tile: t, c, r });
      grid[c][r] = null;
      at[c][r] = null;
    }

    const cols = [...new Set(group.map(([c]) => c))];
    for (const c of cols) {
      // pull survivors down
      let write = ROWS - 1;
      for (let r = ROWS - 1; r >= 0; r--) {
        if (grid[c][r] == null) continue;
        if (write !== r) {
          const t = byId.get(at[c][r]);
          t.moves.push({ t: tClear + T_FALL, row: write });
          grid[c][write] = grid[c][r];
          at[c][write] = at[c][r];
          grid[c][r] = null;
          at[c][r] = null;
        }
        write--;
      }
      // refill the gap left at the top, dropping in from above the board
      const holes = write + 1;
      for (let r = write; r >= 0; r--) {
        const pool = original[c].filter((v) => v > 0);
        const color = pool.length
          ? pool[(nextId + r + c) % pool.length]
          : 1 + ((nextId + r) % 4);
        const t = mkTile(c, color, r - holes - 1);
        t.spawn = tClear + T_FALL;
        t.born = tClear + T_FALL;
        t.moves = [{ t: 0, row: r - holes - 1 }, { t: tClear + T_FALL, row: r }];
        tiles.push(t);
        byId.set(t.id, t);
        grid[c][r] = color;
        at[c][r] = t.id;
      }
    }
    return cleared;
  }

  // ── rounds
  const clears = [];
  let lastCentre = -99;
  for (let i = 0; i < ROUNDS; i++) {
    const tRound = SETTLE + i * ROUND;
    const groups = findGroups(grid);
    if (!groups.length) break;
    // Prefer a big cluster, but spread the action across the width rather than
    // hammering the same corner every round.
    const pick = groups
      .slice(0, 6)
      .sort((a, b) =>
        (b.length + Math.min(20, Math.abs(groupCentre(b) - lastCentre)) * 0.6) -
        (a.length + Math.min(20, Math.abs(groupCentre(a) - lastCentre)) * 0.6))[0];
    lastCentre = groupCentre(pick);

    clears.push({ t: tRound, cells: resolve(trimGroup(pick), tRound), chain: 0 });

    // the chain reaction — the part that actually sells it
    const after = findGroups(grid, 5);
    if (after.length) {
      const tChain = tRound + T_LAND + CASCADE_DELAY;
      if (tChain + T_LAND < RESET_AT) {
        clears.push({ t: tChain, cells: resolve(trimGroup(after[0], 8), tChain), chain: 1 });
      }
    }
  }

  // ── closing sweep
  // Only the columns the rounds actually disturbed get reset. Sweeping the
  // whole board looks the same but makes every one of the 371 tiles an
  // animated node, which took the file past 800 KB; the untouched majority
  // ship as static <use> instead.
  const dirty = [...new Set(
    tiles.filter((t) => t.died != null || t.moves.length > 1 || t.born > 0)
      .map((t) => t.col))].sort((a, b) => a - b);

  for (const t of tiles) {
    if (t.died == null && dirty.includes(t.col)) {
      const out = RESET_AT + 0.02 * t.col;
      t.died = out + 0.85;
      const last = t.moves[t.moves.length - 1];
      t.moves.push({ t: out, row: last.row });
      t.moves.push({ t: out + 0.85, row: ROWS + 2 });
    }
  }
  for (const c of dirty) {
    for (let r = 0; r < ROWS; r++) {
      const t = mkTile(c, original[c][r], r - ROWS - 2);
      const delay = RESET_AT + 0.95 + 0.02 * c + 0.05 * (ROWS - r);
      t.born = delay;
      t.spawn = delay;
      t.moves = [{ t: 0, row: r - ROWS - 2 }, { t: delay, row: r }];
      tiles.push(t);
    }
  }

  return { tiles, clears, original, dirty };
}

// ─────────────────────────────────────────────── svg
function render(theme, sim, { animated = true } = {}) {
  const t = THEMES[theme];
  const { tiles, clears } = sim;
  const T = `${CYCLE}s`;
  const kt = (a) => a.map((v) => n(Math.max(0, Math.min(1, v / CYCLE)))).join(";");
  const out = [];
  const add = (s) => out.push(s);

  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="My GitHub contribution graph, played as a casual match puzzle">`);
  add(`<style>@media (prefers-reduced-motion:reduce){.fx{display:none}}</style>`);
  add(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  // One tile shape, reused. The body rect carries no fill so each <use>
  // colours it; only the gloss keeps its own.
  add(`<defs><g id="tl"><rect width="${CELL}" height="${CELL}" rx="3.6"/><rect x="1.4" y="1.4" width="${n(CELL - 2.8)}" height="${n(CELL * 0.42)}" rx="2.2" fill="${t.gloss}" opacity="${t.glossOp}"/></g></defs>`);

  const tile = (color, x, y) =>
    `<use href="#tl" x="${n(x)}" y="${n(y)}" fill="${t.tiles[color]}"/>`;

  if (!animated) {
    // opening board only — used by --snapshot
    for (let c = 0; c < COLS; c++)
      for (let r = 0; r < ROWS; r++) add(tile(sim.original[c][r], tileX(c), tileY(r)));
    add(`</svg>`);
    return out.join("");
  }

  for (const tl of tiles) {
    const still = tl.moves.length === 1 && tl.born === 0;
    const x = tileX(tl.col);

    if (still && tl.died == null) {
      add(tile(tl.color, x, tileY(tl.moves[0].row)));
      continue;
    }

    // Only y ever changes, so the y attribute is animated directly rather
    // than a translate transform — plain numbers instead of coordinate pairs
    // is worth roughly a third of the file.
    const times = [], vals = [];
    const pushKey = (time, row) => { times.push(time); vals.push(n(tileY(row))); };
    pushKey(0, tl.moves[0].row);
    for (let i = 1; i < tl.moves.length; i++) {
      const m = tl.moves[i];
      pushKey(Math.max(0.001, m.t), tl.moves[i - 1].row);
      pushKey(Math.min(CYCLE, m.t + (tl.spawn === m.t ? 0.62 : 0.52)), m.row);
    }
    pushKey(CYCLE, tl.moves[tl.moves.length - 1].row);

    // hold, then a weighted fall that settles rather than stopping dead
    const splines = [];
    for (let i = 0; i < times.length - 1; i++) {
      splines.push(vals[i] === vals[i + 1] ? "0 0 1 1" : ".34 .06 .2 1.2");
    }
    const yAnim = `<animate attributeName="y" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt(times)}" values="${vals.join(";")}" keySplines="${splines.join(";")}"/>`;

    const oTimes = [0], oVals = [tl.born > 0 ? 0 : 1];
    if (tl.born > 0) { oTimes.push(tl.born - 0.01, tl.born); oVals.push(0, 1); }
    if (tl.died != null) {
      oTimes.push(Math.max(0.02, tl.died - 0.26), tl.died, CYCLE);
      oVals.push(1, 0, 0);
    } else { oTimes.push(CYCLE); oVals.push(1); }
    const oAnim = `<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" keyTimes="${kt(oTimes)}" values="${oVals.join(";")}"/>`;

    if (tl.popped) {
      // The swell needs a transform box around the tile's own centre, so
      // cleared tiles get a wrapper. Everything else stays a bare <use>.
      const s = tl.died;
      add(`<g class="fx"><g transform="translate(${n(x + CELL / 2)},${n(tileY(tl.moves[0].row) + CELL / 2)})">`);
      add(`<animateTransform attributeName="transform" type="scale" additive="sum" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt([0, Math.max(0.02, s - 0.26), Math.max(0.03, s - 0.08), s, CYCLE])}" values="1;1;1.3;.2;.2" keySplines="0 0 1 1;.2 .8 .3 1.4;.5 0 .9 .4;0 0 1 1"/>`);
      add(`<use href="#tl" x="${n(-CELL / 2)}" y="${n(-CELL / 2)}" fill="${t.tiles[tl.color]}">${oAnim}</use>`);
      add(`</g></g>`);
    } else {
      add(`<use class="fx" href="#tl" x="${n(x)}" y="${vals[0]}" fill="${t.tiles[tl.color]}">${yAnim}${oAnim}</use>`);
    }
  }

  // ── burst rings, one per cleared group
  for (const cl of clears) {
    const cx = cl.cells.reduce((s, x) => s + tileX(x.c), 0) / cl.cells.length + CELL / 2;
    const cy = cl.cells.reduce((s, x) => s + tileY(x.r), 0) / cl.cells.length + CELL / 2;
    const k = cl.t + T_POP;
    const col = THEMES[theme].tiles[cl.cells[0].tile.color];
    add(`<g class="fx"><circle cx="${n(cx)}" cy="${n(cy)}" fill="none" stroke="${col}" stroke-width="2" opacity="0">`);
    add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt([0, k, k + 0.03, k + 0.6, CYCLE])}" values="0;0;.55;0;0"/>`);
    add(`<animate attributeName="r" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt([0, k, k + 0.6, CYCLE])}" values="4;4;${n(9 + cl.cells.length * 2.2)};${n(9 + cl.cells.length * 2.2)}" keySplines="0 0 1 1;.1 .7 .3 1;0 0 1 1"/>`);
    add(`</circle></g>`);
  }

  add(`<text x="${PAD_X}" y="${H - 8}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">A YEAR OF COMMITS, PLAYED AS A PUZZLE</text>`);
  add(`<text x="${W - PAD_X}" y="${H - 8}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">CASUAL &#183; MOBILE</text>`);
  add(`</svg>`);
  return out.join("");
}

// ─────────────────────────────────────────────── main
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const outDir = argOf("--out", "dist");
mkdirSync(outDir, { recursive: true });

const weeks = loadData(argOf("--data", null));
const sim = simulate(weeks);

/**
 * A still of the board at `time`. SMIL cannot be seeked from outside a
 * browser, so this is the only way to check that tiles land where the
 * simulation thinks they do.
 */
function snapshot(theme, time) {
  const t = THEMES[theme];
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  out.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  out.push(`<defs><g id="tl"><rect width="${CELL}" height="${CELL}" rx="3.6"/><rect x="1.4" y="1.4" width="${n(CELL - 2.8)}" height="${n(CELL * 0.42)}" rx="2.2" fill="${t.gloss}" opacity="${t.glossOp}"/></g></defs>`);

  for (const tl of sim.tiles) {
    if (time < tl.born) continue;
    if (tl.died != null && time >= tl.died) continue;
    let row = tl.moves[0].row;
    for (let i = 1; i < tl.moves.length; i++) {
      const m = tl.moves[i];
      const dur = tl.spawn === m.t ? 0.62 : 0.52;
      if (time >= m.t + dur) { row = m.row; }
      else if (time >= m.t) {
        const k = (time - m.t) / dur;
        row = tl.moves[i - 1].row + (m.row - tl.moves[i - 1].row) * k;
      }
    }
    const popping = tl.popped && time > tl.died - 0.26;
    const s = popping ? 1 + 0.3 * Math.min(1, (time - (tl.died - 0.26)) / 0.18) : 1;
    const x = tileX(tl.col), y = tileY(row);
    if (s === 1) out.push(`<use href="#tl" x="${n(x)}" y="${n(y)}" fill="${t.tiles[tl.color]}"/>`);
    else out.push(`<g transform="translate(${n(x + CELL / 2)},${n(y + CELL / 2)}) scale(${n(s)})"><use href="#tl" x="${n(-CELL / 2)}" y="${n(-CELL / 2)}" fill="${t.tiles[tl.color]}"/></g>`);
  }
  out.push(`<text x="${W - PAD_X}" y="14" text-anchor="end" font-family="monospace" font-size="9" fill="${t.label}">t = ${time.toFixed(1)}s</text>`);
  out.push(`</svg>`);
  return out.join("");
}

const snapAt = argOf("--snapshot", null);
if (snapAt) {
  for (const time of snapAt.split(",").map(Number)) {
    const file = join(outDir, `snap-${time.toFixed(1).replace(".", "_")}.svg`);
    writeFileSync(file, snapshot("dark", time), "utf8");
    console.log(`  ${file}`);
  }
}

for (const theme of ["dark", "light"]) {
  const svg = render(theme, sim);
  const file = join(outDir, `puzzle-${theme}.svg`);
  writeFileSync(file, svg, "utf8");
  console.log(`  ${file}  ${svg.length.toLocaleString()} B`);
}

const still = sim.tiles.filter((t) => t.moves.length === 1 && t.born === 0 && t.died == null).length;
console.log(`  ${sim.tiles.length} tiles (${still} static), ${sim.clears.length} clears ` +
  `(${sim.clears.filter((c) => c.chain).length} chained), ${CYCLE}s loop`);
