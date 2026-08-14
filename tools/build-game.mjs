/**
 * Tower defense, played on a GitHub contribution graph.
 *
 * Every shot is choreographed at build time rather than left to chance: enemy
 * positions are integrated along the path, an intercept point is picked for
 * each one, and the firing tower and projectile flight time are solved
 * backwards from that. Nothing is random at runtime, so no shot ever misses.
 *
 * Output is a plain animated SVG with SMIL timing — one cycle of a fixed
 * duration, every animation expressed as keyTimes over that same duration, so
 * the loop is seamless. No script, no webfont, no external reference, which is
 * what lets it survive being served as an <img> from raw.githubusercontent.com.
 *
 *   node tools/build-game.mjs --out dist [--data contributions.json]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────── layout
const COLS = 53, ROWS = 7;
const CELL = 11, GAP = 3, PITCH = CELL + GAP;
const PAD_X = 18, PAD_TOP = 20, PAD_BOT = 26;
const GRID_W = COLS * PITCH - GAP;
const GRID_H = ROWS * PITCH - GAP;
const W = GRID_W + PAD_X * 2;
const H = GRID_H + PAD_TOP + PAD_BOT;

const CYCLE = 16;            // seconds, one full wave
const ENEMIES = 15;
const TOWERS = 6;
const SPEED = 1 / 9.2;       // path fractions per second
const FLIGHT = 0.34;         // projectile travel time, seconds

const THEMES = {
  dark: {
    bg: "#0D1117", empty: "#161B22",
    levels: ["#3B2A0B", "#7A5410", "#C08018", "#FFB020"],
    path: "#FFFFFF", pathOp: 0.05,
    ring: "#FFB020", enemy: "#4CC9F0", enemyEdge: "#0D1117",
    shot: "#FFE9C2", burst: "#FFB020", label: "#5E6472",
  },
  light: {
    bg: "#FFFFFF", empty: "#EBEDF0",
    levels: ["#FFE2A8", "#FFC65C", "#EFA01C", "#C97F00"],
    path: "#000000", pathOp: 0.05,
    ring: "#C97F00", enemy: "#1583AD", enemyEdge: "#FFFFFF",
    shot: "#8A5A00", burst: "#C97F00", label: "#8A8F9A",
  },
};

const cellX = (c) => PAD_X + c * PITCH;
const cellY = (r) => PAD_TOP + r * PITCH;
const centre = (c, r) => [cellX(c) + CELL / 2, cellY(r) + CELL / 2];
const n = (v) => Number(v.toFixed(2));

// ─────────────────────────────────────────────── the lane
// Orthogonal, with rounded corners — a straight line reads as a progress bar,
// and a sine wave fights the grid it is drawn over.
function buildLane() {
  const legs = [
    [-1, 3], [12, 3], [12, 1], [25, 1], [25, 5], [38, 5], [38, 3], [COLS, 3],
  ].map(([c, r]) => {
    const [x, y] = centre(Math.min(c, COLS - 1), r);
    return [c < 0 ? -6 : c >= COLS ? W + 6 : x, y];
  });

  const R = 9;
  let d = `M${n(legs[0][0])},${n(legs[0][1])}`;
  for (let i = 1; i < legs.length - 1; i++) {
    const [px, py] = legs[i - 1], [cx, cy] = legs[i], [nx, ny] = legs[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(R, inLen / 2, outLen / 2);
    const a = [cx - ((cx - px) / inLen) * r, cy - ((cy - py) / inLen) * r];
    const b = [cx + ((nx - cx) / outLen) * r, cy + ((ny - cy) / outLen) * r];
    d += ` L${n(a[0])},${n(a[1])} Q${n(cx)},${n(cy)} ${n(b[0])},${n(b[1])}`;
  }
  const last = legs[legs.length - 1];
  d += ` L${n(last[0])},${n(last[1])}`;
  return { d, legs };
}

/** Sample the lane so we can solve positions without a DOM. */
function samplePath(legs, R = 9) {
  const pts = [];
  const push = (x, y) => {
    const p = pts[pts.length - 1];
    if (!p || Math.hypot(x - p[0], y - p[1]) > 0.01) pts.push([x, y]);
  };
  for (let i = 0; i < legs.length - 1; i++) {
    const [ax, ay] = legs[i], [bx, by] = legs[i + 1];
    const steps = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 2));
    for (let s = 0; s <= steps; s++) {
      push(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
    }
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  return {
    total,
    at(frac) {
      const target = Math.max(0, Math.min(1, frac)) * total;
      let i = 1;
      while (i < cum.length && cum[i] < target) i++;
      const t0 = cum[i - 1], t1 = cum[i] ?? total;
      const k = t1 === t0 ? 0 : (target - t0) / (t1 - t0);
      const a = pts[i - 1], b = pts[i] ?? pts[pts.length - 1];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    },
  };
}

// ─────────────────────────────────────────────── contribution data
function synthetic() {
  // Deterministic stand-in so the visual can be reviewed without a token.
  let seed = 20260814;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const weeks = [];
  for (let c = 0; c < COLS; c++) {
    const days = [];
    const burst = rnd() < 0.28 ? 2.4 : 1;
    for (let r = 0; r < ROWS; r++) {
      const weekend = r === 0 || r === 6;
      const v = rnd() * burst * (weekend ? 0.4 : 1.6);
      days.push(v < 0.35 ? 0 : Math.round(v * 4));
    }
    weeks.push(days);
  }
  return weeks;
}

function loadData(file) {
  if (!file || !existsSync(file)) return synthetic();
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const days =
    raw?.data?.user?.contributionsCollection?.contributionCalendar?.weeks ?? raw?.weeks;
  if (!Array.isArray(days)) return synthetic();
  const weeks = days.slice(-COLS).map((w) => {
    const d = (w.contributionDays ?? w).map((x) =>
      typeof x === "number" ? x : x.contributionCount ?? 0);
    while (d.length < ROWS) d.push(0);
    return d.slice(0, ROWS);
  });
  while (weeks.length < COLS) weeks.unshift(new Array(ROWS).fill(0));
  return weeks;
}

const levelOf = (count, max) => {
  if (!count) return -1;
  const q = count / Math.max(1, max);
  return q > 0.66 ? 3 : q > 0.4 ? 2 : q > 0.15 ? 1 : 0;
};

// ─────────────────────────────────────────────── choreography
function choreograph(weeks, path) {
  const flat = [];
  weeks.forEach((days, c) => days.forEach((v, r) => flat.push({ c, r, v })));
  const max = Math.max(1, ...flat.map((f) => f.v));

  // Towers sit on the busiest days, spread out so they do not clump.
  const towers = [];
  for (const cand of [...flat].sort((a, b) => b.v - a.v)) {
    if (towers.length >= TOWERS) break;
    if (!cand.v) continue;
    if (towers.some((t) => Math.abs(t.c - cand.c) < 6)) continue;
    const [x, y] = centre(cand.c, cand.r);
    towers.push({ ...cand, x, y });
  }
  towers.sort((a, b) => a.c - b.c);

  // Enemies march in on a steady cadence; each is assigned a kill point and
  // the tower that can actually reach it.
  const gap = (CYCLE - 1 / SPEED) / ENEMIES;
  const waves = [];
  for (let i = 0; i < ENEMIES; i++) {
    const spawn = 0.35 + i * gap;
    // Die between a fifth and four-fifths of the way along, walking rightwards.
    const killFrac = 0.2 + 0.62 * ((i + 0.5) / ENEMIES) + (i % 3) * 0.035;
    const killTime = spawn + killFrac / SPEED;
    if (killTime + 0.4 > CYCLE) break;
    const [kx, ky] = path.at(killFrac);

    let tower = towers[0], best = Infinity;
    for (const t of towers) {
      const d = Math.hypot(t.x - kx, t.y - ky);
      if (d < best) { best = d; tower = t; }
    }
    waves.push({ spawn, killTime, killFrac, kx, ky, tower, fire: killTime - FLIGHT });
  }
  return { towers, waves, max };
}

// ─────────────────────────────────────────────── svg
function render(theme, weeks, lane, path, plan, { animated = true } = {}) {
  const t = THEMES[theme];
  const { towers, waves, max } = plan;
  // Snapshot mode omits the moving pieces at source. Stripping them from the
  // finished string with a regex silently ate the tower emplacements too,
  // because <g> nests and a non-greedy match cannot see that.
  const fx = animated ? waves : [];
  const T = `${CYCLE}s`;
  const kt = (arr) => arr.map((v) => n(v / CYCLE)).join(";");
  const out = [];
  const add = (s) => out.push(s);

  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="My GitHub contribution graph, played as a tower defense">`);
  add(`<style>
.cell{shape-rendering:crispEdges}
@media (prefers-reduced-motion:reduce){
  .fx{display:none}
  .tower-ring{opacity:.9}
}
</style>`);
  add(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);

  // ── grid
  const towerKey = new Set(towers.map((x) => `${x.c}:${x.r}`));
  weeks.forEach((days, c) => days.forEach((v, r) => {
    const lv = levelOf(v, max);
    const fill = lv < 0 ? t.empty : t.levels[lv];
    add(`<rect class="cell" x="${cellX(c)}" y="${cellY(r)}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`);
  }));

  // ── lane: a wide soft bed plus a dashed centre line, so it reads as a route
  // over the grid rather than a smudge across it
  add(`<path d="${lane.d}" fill="none" stroke="${t.bg}" stroke-opacity=".55" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>`);
  add(`<path d="${lane.d}" fill="none" stroke="${t.path}" stroke-opacity="${t.pathOp}" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>`);
  add(`<path d="${lane.d}" fill="none" stroke="${t.ring}" stroke-opacity=".22" stroke-width="1" stroke-dasharray="3 5" stroke-linecap="round"/>`);
  add(`<path id="lane" d="${lane.d}" fill="none" stroke="none"/>`);

  // ── towers: a ring that snaps tight on each shot
  towers.forEach((tw, i) => {
    const shots = fx.filter((w) => w.tower === tw).map((w) => w.fire).sort((a, b) => a - b);
    if (shots.length) {
      add(`<g class="fx"><circle cx="${n(tw.x)}" cy="${n(tw.y)}" r="8.5" fill="none" stroke="${t.ring}" stroke-width="1.4" opacity="0">`);
      const times = [0], vals = [0];
      for (const s of shots) {
        times.push(Math.max(0.001, s - 0.12), s, Math.min(CYCLE, s + 0.5));
        vals.push(0, 0.85, 0);
      }
      times.push(CYCLE); vals.push(0);
      add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt(times)}" values="${vals.join(";")}"/>`);
      const rt = [0], rv = [11];
      for (const s of shots) {
        rt.push(Math.max(0.001, s - 0.12), s, Math.min(CYCLE, s + 0.5));
        rv.push(11, 6.5, 12);
      }
      rt.push(CYCLE); rv.push(11);
      add(`<animate attributeName="r" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt(rt)}" values="${rv.join(";")}"/>`);
      add(`</circle></g>`);
    }
    // The emplacement has to sit on the busiest cells, which are also the
    // brightest — so it is drawn as a dark plate with a lit core rather than a
    // solid accent square that would vanish into them.
    add(`<g class="tower-ring">`);
    add(`<circle cx="${n(tw.x)}" cy="${n(tw.y)}" r="5.6" fill="${t.bg}" opacity=".92"/>`);
    add(`<circle cx="${n(tw.x)}" cy="${n(tw.y)}" r="5.6" fill="none" stroke="${t.ring}" stroke-width="1.5"/>`);
    add(`<circle cx="${n(tw.x)}" cy="${n(tw.y)}" r="1.9" fill="${t.ring}"/>`);
    add(`</g>`);
  });

  // ── enemies
  for (const w of fx) {
    const dieAt = w.killTime;
    const times = [0, Math.max(0.001, w.spawn), dieAt, CYCLE];
    add(`<g class="fx" opacity="0">`);
    add(`<animateMotion dur="${T}" repeatCount="indefinite" calcMode="linear" rotate="auto" keyPoints="0;0;${n(w.killFrac)};${n(w.killFrac)}" keyTimes="${kt(times)}"><mpath href="#lane"/></animateMotion>`);
    add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt([0, w.spawn, w.spawn + 0.18, dieAt - 0.02, dieAt, CYCLE])}" values="0;0;1;1;0;0"/>`);
    add(`<g><path d="M4.6,0 L-2.6,3.6 L-1.2,0 L-2.6,-3.6 Z" fill="${t.enemy}" stroke="${t.enemyEdge}" stroke-width=".8" stroke-linejoin="round"/></g>`);
    add(`</g>`);
  }

  // ── projectiles
  for (const w of fx) {
    const d = `M${n(w.tower.x)},${n(w.tower.y)} L${n(w.kx)},${n(w.ky)}`;
    const times = [0, Math.max(0.001, w.fire), w.killTime, CYCLE];
    add(`<g class="fx" opacity="0">`);
    add(`<animateMotion dur="${T}" repeatCount="indefinite" calcMode="linear" path="${d}" keyPoints="0;0;1;1" keyTimes="${kt(times)}"/>`);
    add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt([0, w.fire, w.fire + 0.04, w.killTime - 0.02, w.killTime, CYCLE])}" values="0;0;1;1;0;0"/>`);
    add(`<circle r="1.9" fill="${t.shot}"/>`);
    add(`</g>`);
  }

  // ── hit bursts
  for (const w of fx) {
    const k = w.killTime;
    add(`<g class="fx"><circle cx="${n(w.kx)}" cy="${n(w.ky)}" fill="none" stroke="${t.burst}" stroke-width="1.6" opacity="0">`);
    add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt([0, k, k + 0.02, k + 0.42, CYCLE])}" values="0;0;.9;0;0"/>`);
    add(`<animate attributeName="r" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt([0, k, k + 0.42, CYCLE])}" values="1;1;9;9"/>`);
    add(`</circle></g>`);
  }

  // ── caption
  add(`<text x="${PAD_X}" y="${H - 8}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">TOWER DEFENSE, PLAYED ON MY CONTRIBUTION GRAPH</text>`);
  add(`<text x="${W - PAD_X}" y="${H - 8}" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9" letter-spacing="1.6" fill="${t.label}">HEIRBOUND &#183; 2027</text>`);

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
const lane = buildLane();
const path = samplePath(lane.legs);
const plan = choreograph(weeks, path);

/**
 * A still of the timeline at `time`, with the moving pieces placed where the
 * SMIL would have put them. SMIL cannot be seeked from outside a browser, so
 * this is how the choreography gets checked: if a projectile is not sitting on
 * top of its target at the moment of impact, it is wrong here too.
 */
function snapshot(theme, time) {
  const t = THEMES[theme];
  const svg = render(theme, weeks, lane, path, plan, { animated: false });

  const bits = [];
  for (const w of plan.waves) {
    if (time >= w.spawn && time < w.killTime) {
      const frac = Math.min(w.killFrac, (time - w.spawn) * SPEED);
      const [x, y] = path.at(frac);
      const [ax, ay] = path.at(Math.max(0, frac - 0.004));
      const ang = (Math.atan2(y - ay, x - ax) * 180) / Math.PI;
      bits.push(`<g transform="translate(${n(x)},${n(y)}) rotate(${n(ang)})"><path d="M4.6,0 L-2.6,3.6 L-1.2,0 L-2.6,-3.6 Z" fill="${t.enemy}" stroke="${t.enemyEdge}" stroke-width=".8" stroke-linejoin="round"/></g>`);
    }
    if (time >= w.fire && time < w.killTime) {
      const k = (time - w.fire) / FLIGHT;
      const px = w.tower.x + (w.kx - w.tower.x) * k;
      const py = w.tower.y + (w.ky - w.tower.y) * k;
      bits.push(`<circle cx="${n(px)}" cy="${n(py)}" r="1.9" fill="${t.shot}"/>`);
      bits.push(`<line x1="${n(w.tower.x)}" y1="${n(w.tower.y)}" x2="${n(px)}" y2="${n(py)}" stroke="${t.shot}" stroke-width=".6" opacity=".35"/>`);
    }
    if (time >= w.killTime && time < w.killTime + 0.42) {
      const k = (time - w.killTime) / 0.42;
      bits.push(`<circle cx="${n(w.kx)}" cy="${n(w.ky)}" r="${n(1 + 8 * k)}" fill="none" stroke="${t.burst}" stroke-width="1.6" opacity="${n(0.9 * (1 - k))}"/>`);
    }
  }
  bits.push(`<text x="${W - PAD_X}" y="${PAD_TOP - 8}" text-anchor="end" font-family="ui-monospace,monospace" font-size="9" fill="${t.label}">t = ${time.toFixed(1)}s</text>`);
  return svg.replace("</svg>", bits.join("") + "</svg>");
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
  const svg = render(theme, weeks, lane, path, plan);
  const file = join(outDir, `tower-defense-${theme}.svg`);
  writeFileSync(file, svg, "utf8");
  console.log(`  ${file}  ${svg.length.toLocaleString()} B`);
}
console.log(`  ${plan.towers.length} towers, ${plan.waves.length} enemies, ${CYCLE}s loop`);
