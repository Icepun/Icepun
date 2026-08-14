/**
 * Breakout, played against a year of commits.
 *
 * The contribution calendar is the brick wall. A ball is launched, and the
 * whole rally — every wall bounce, every brick it clips, the paddle sliding
 * under it — is simulated at build time on a fixed timestep. Because the ball
 * only ever changes direction at a collision, the emitted animation needs one
 * keyframe per bounce rather than one per frame: the motion between them is
 * genuinely straight, so the physics you see is the physics that was solved,
 * not an approximation of it.
 *
 * Art direction follows the Dream Games house style rather than flat cel
 * shading: rounded forms, volume from gradients, a lit top edge on every brick
 * so it reads as a solid object, and a paddle in the profile's amber.
 *
 * Two SMIL rules are load-bearing and both fail silently, leaving a perfect
 * still image that never moves:
 *   * keyTimes must be strictly increasing.
 *   * every keySplines control point must sit inside 0..1 — unlike CSS
 *     cubic-bezier an overshoot is rejected rather than clamped.
 * assertPlayable() refuses to write a file that breaks either.
 *
 *   node tools/build-breakout.mjs --out dist [--data contributions.json]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────── layout
const COLS = 53, ROWS = 7;
const BW = 14.6, BH = 9.2, GAP = 1.6;           // brick box
const PX = BW + GAP, PY = BH + GAP;
const PAD_X = 17, WALL_TOP = 26;
const W = COLS * PX - GAP + PAD_X * 2;
const WALL_BOT = WALL_TOP + ROWS * PY - GAP;
const PADDLE_Y = 158, PADDLE_W = 150, PADDLE_H = 10;
const BALL_R = 6.4;
const H = 192;

const CYCLE = 14;
const LAUNCH = 0.45;
const PLAY_END = 11.6;      // ball retires
const RESPAWN = 11.6;       // wall rebuilds
const REBUILD = 1.5;

const SPEED = 402;          // px per second
const STEP = 1 / 240;

const brickX = (c) => PAD_X + c * PX;
const brickY = (r) => WALL_TOP + r * PY;
const n = (v) => Number(v.toFixed(1));

const THEMES = {
  dark: {
    bg0: "#10151F", bg1: "#0B0F17", glow: "#4C7BD9", glowOp: 0.16,
    lv: [
      ["#333E4E", "#232C39"],
      ["#45D0C4", "#249B92"],
      ["#63BEFF", "#3486D6"],
      ["#FFCF57", "#DE9A1C"],
      ["#FF8AA3", "#D9506F"],
    ],
    rim: "#FFFFFF", rimOp: 0.30,
    ball: "#FFF6E2", ballLo: "#FFC96B", ballGlow: "#FFD municipal",
    paddle: "#FFB020", paddleLo: "#D8830A", paddleRim: "#FFE3A8",
    label: "#5E6472",
  },
  light: {
    bg0: "#F4F8FD", bg1: "#E8EFF7", glow: "#9CC4FF", glowOp: 0.30,
    lv: [
      ["#D9E0E8", "#BFC9D4"],
      ["#3FC3B7", "#219189"],
      ["#4FA8F0", "#2C79C4"],
      ["#F5BB33", "#CE8A11"],
      ["#FF7A96", "#D14664"],
    ],
    rim: "#FFFFFF", rimOp: 0.55,
    ball: "#FFFFFF", ballLo: "#FFB944", ballGlow: "#FFD98A",
    paddle: "#F5A417", paddleLo: "#C97C05", paddleRim: "#FFE0A0",
    label: "#8A8F9A",
  },
};
THEMES.dark.ballGlow = "#FFD98A";

// ─────────────────────────────────────────────── data
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

function makeScale(values) {
  const active = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!active.length) return () => 0;
  const anchor = Math.max(active[Math.floor(active.length / 2)] || 1, 1.35);
  return (count) =>
    count ? 1 + Math.max(0, Math.min(3, Math.floor(Math.log2((count / anchor) * 2)))) : 0;
}

// ─────────────────────────────────────────────── the rally
/**
 * Fixed-step simulation. Only collisions are recorded: between them the ball
 * travels in a straight line at constant speed, so those samples are the whole
 * truth about its path.
 */
function play(grid) {
  const alive = grid.map((col) => col.map(() => true));
  const hits = [];                       // {t, c, r}
  const path = [];                       // {t, x, y}
  const paddle = [];                     // {t, x}
  const catches = [];                    // paddle interceptions

  let x = W * 0.5, y = PADDLE_Y - 40;
  let a = -Math.PI * 0.28;               // up and to the right
  let vx = Math.cos(a) * SPEED, vy = Math.sin(a) * SPEED;
  let px = x;                            // paddle centre

  path.push({ t: LAUNCH, x, y });
  paddle.push({ t: 0, x: px });

  const minX = PAD_X + BALL_R, maxX = W - PAD_X - BALL_R;

  for (let t = LAUNCH; t < PLAY_END; t += STEP) {
    x += vx * STEP;
    y += vy * STEP;

    // the paddle chases with a lag, which reads as reaction rather than magnet
    px += (x - px) * 0.018;   // deliberately slow: a paddle that centres
                          // the ball every time produces a vertical
                          // ping-pong and a rally 125px wide
    px = Math.max(PADDLE_W / 2 + PAD_X, Math.min(W - PAD_X - PADDLE_W / 2, px));
    if (paddle.length === 0 || t - paddle[paddle.length - 1].t > 0.09) paddle.push({ t, x: px });

    let bounced = false;

    if (x < minX) { x = minX; vx = Math.abs(vx); bounced = true; }
    else if (x > maxX) { x = maxX; vx = -Math.abs(vx); bounced = true; }

    if (y < WALL_TOP - BALL_R - 6) { y = WALL_TOP - BALL_R - 6; vy = Math.abs(vy); bounced = true; }

    // paddle. A lagging paddle is what keeps the rally wide — the ball lands
    // off-centre and leaves at a steeper angle — but it must still physically
    // be under the ball, or the bounce reads as hitting thin air. Every
    // interception is measured and the build fails if one is a miss.
    if (vy > 0 && y > PADDLE_Y - BALL_R) {
      y = PADDLE_Y - BALL_R;
      const reach = Math.abs(x - px) - PADDLE_W / 2;
      catches.push({ t, gap: reach });
      const off = Math.max(-1, Math.min(1, (x - px) / (PADDLE_W / 2)));
      const ang = -Math.PI / 2 + off * 0.95;
      vx = Math.cos(ang) * SPEED;
      vy = Math.sin(ang) * SPEED;
      bounced = true;
    }

    // bricks
    if (y - BALL_R < WALL_BOT && y + BALL_R > WALL_TOP) {
      const c = Math.round((x - PAD_X - BW / 2) / PX);
      const r = Math.round((y - WALL_TOP - BH / 2) / PY);
      if (c >= 0 && c < COLS && r >= 0 && r < ROWS && alive[c][r]) {
        const bx = brickX(c), by = brickY(r);
        if (x + BALL_R > bx && x - BALL_R < bx + BW && y + BALL_R > by && y - BALL_R < by + BH) {
          // An impact takes the brick and the ones bracing it. One brick per
          // bounce clears 17 of 371 over a rally — invisible against a wall
          // this wide. A small cluster reads as force and actually eats the
          // wall down, without touching how the ball itself behaves.
          const blast = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1]];
          for (const [dc, dr] of blast) {
            const bc = c + dc, br = r + dr;
            if (bc < 0 || bc >= COLS || br < 0 || br >= ROWS) continue;
            if (!alive[bc][br]) continue;
            alive[bc][br] = false;
            hits.push({ t: t + (Math.abs(dc) + Math.abs(dr)) * 0.045, c: bc, r: br, core: !dc && !dr });
          }
          // reflect off whichever face was shallower to cross
          const overX = Math.min(Math.abs(x - bx), Math.abs(x - (bx + BW)));
          const overY = Math.min(Math.abs(y - by), Math.abs(y - (by + BH)));
          if (overY <= overX) { vy = -vy; y += vy > 0 ? 1.5 : -1.5; }
          else { vx = -vx; x += vx > 0 ? 1.5 : -1.5; }
          bounced = true;
        }
      }
    }

    if (bounced) path.push({ t, x, y });
  }
  path.push({ t: PLAY_END, x, y });
  paddle.push({ t: PLAY_END, x: px });
  return { hits, path, paddle, catches };
}

// ─────────────────────────────────────────────── svg
function render(theme, grid, sim, { animated = true } = {}) {
  const t = THEMES[theme];
  const T = `${CYCLE}s`;

  const kt = (a) => {
    const EPS = 1e-4;
    const out = [];
    let prev = -1;
    for (const v of a) {
      let q = Number(Math.max(0, Math.min(1, v / CYCLE)).toFixed(4));
      if (q <= prev) q = Number((prev + EPS).toFixed(4));
      out.push(q); prev = q;
    }
    out[out.length - 1] = 1;
    for (let i = out.length - 2; i >= 0 && out[i] >= out[i + 1]; i--) {
      out[i] = Number((out[i + 1] - EPS).toFixed(4));
    }
    return out.join(";");
  };

  const o = [];
  const add = (s) => o.push(s);
  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${H}" width="${n(W)}" height="${H}" role="img" aria-label="Breakout played against my contribution graph — the ball breaks a year of commits">`);

  add(`<defs>`);
  add(`<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bg0}"/><stop offset="1" stop-color="${t.bg1}"/></linearGradient>`);
  add(`<radialGradient id="halo"><stop offset="0" stop-color="${t.glow}" stop-opacity="${t.glowOp}"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>`);
  t.lv.forEach(([hi, lo], i) => {
    add(`<linearGradient id="b${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset="1" stop-color="${lo}"/></linearGradient>`);
    // one brick, drawn once: body, lit top edge, seated shadow
    add(`<g id="k${i}">` +
      `<rect width="${BW}" height="${BH}" rx="3" fill="url(#b${i})"/>` +
      `<rect x="1.5" y="1.1" width="${n(BW - 3)}" height="2.2" rx="1.1" fill="${t.rim}" opacity="${t.rimOp}"/>` +
      `<rect y="${n(BH - 2.2)}" width="${BW}" height="2.2" rx="1.1" fill="#000" opacity=".16"/>` +
      `</g>`);
  });
  add(`<radialGradient id="ballG" cx=".36" cy=".32"><stop offset="0" stop-color="${t.ball}"/><stop offset=".6" stop-color="${t.ball}"/><stop offset="1" stop-color="${t.ballLo}"/></radialGradient>`);
  add(`<radialGradient id="ballHalo"><stop offset="0" stop-color="${t.ballGlow}" stop-opacity=".55"/><stop offset="1" stop-color="${t.ballGlow}" stop-opacity="0"/></radialGradient>`);
  add(`<linearGradient id="padG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.paddle}"/><stop offset="1" stop-color="${t.paddleLo}"/></linearGradient>`);
  add(`</defs>`);

  add(`<rect width="${n(W)}" height="${H}" fill="url(#bg)"/>`);
  add(`<ellipse cx="${n(W / 2)}" cy="${WALL_BOT + 40}" rx="${n(W * 0.45)}" ry="120" fill="url(#halo)"/>`);

  // ── wall
  const brokenAt = new Map(sim.hits.map((h) => [`${h.c}:${h.r}`, h.t]));
  const coreAt = new Set(sim.hits.filter((h) => h.core).map((h) => `${h.c}:${h.r}`));
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const lv = grid[c][r];
      const x = brickX(c), y = brickY(r);
      const key = `${c}:${r}`;
      const hit = animated ? brokenAt.get(key) : undefined;

      if (hit === undefined) {
        add(`<use href="#k${lv}" x="${n(x)}" y="${n(y)}"/>`);
        continue;
      }
      // struck: flash out, then rebuild with the rest of the wall
      const back = RESPAWN + (c / COLS) * REBUILD;
      add(`<g class="fx" transform="translate(${n(x + BW / 2)},${n(y + BH / 2)})">`);
      add(`<animateTransform attributeName="transform" type="scale" additive="sum" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt([0, hit, hit + 0.13, hit + 0.14, back, back + 0.3, CYCLE])}" values="1;1;1.35;0.001;0.001;1;1" keySplines="0 0 1 1;.2 .8 .3 1;.6 0 1 .4;0 0 1 1;.2 .9 .3 1;0 0 1 1"/>`);
      add(`<use href="#k${lv}" x="${n(-BW / 2)}" y="${n(-BH / 2)}">`);
      add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" keyTimes="${kt([0, hit, hit + 0.14, back, back + 0.22, CYCLE])}" values="1;1;0;0;1;1"/>`);
      add(`</use></g>`);
      // the pop it leaves behind
      if (coreAt.has(key)) {
      add(`<circle class="fx" cx="${n(x + BW / 2)}" cy="${n(y + BH / 2)}" fill="none" stroke="${t.lv[lv][0]}" stroke-width="1.8" opacity="0">`);
      add(`<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" keyTimes="${kt([0, hit, hit + 0.02, hit + 0.42, CYCLE])}" values="0;0;.7;0;0"/>`);
      add(`<animate attributeName="r" dur="${T}" repeatCount="indefinite" calcMode="spline" keyTimes="${kt([0, hit, hit + 0.42, CYCLE])}" values="3;3;17;17" keySplines="0 0 1 1;.12 .7 .3 1;0 0 1 1"/>`);
      add(`</circle>`);
      }
    }
  }

  if (!animated) {
    const p0 = sim.paddle[0].x - PADDLE_W / 2;
    add(`<rect x="${n(p0)}" y="${PADDLE_Y}" width="${PADDLE_W}" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="url(#padG)"/>`);
    add(`<rect x="${n(p0 + 7)}" y="${PADDLE_Y + 2}" width="${n(PADDLE_W - 14)}" height="2.6" rx="1.3" fill="${t.paddleRim}" opacity=".65"/>`);
    add(`<circle cx="${n(sim.path[0].x)}" cy="${n(sim.path[0].y)}" r="15" fill="url(#ballHalo)"/>`);
    add(`<circle cx="${n(sim.path[0].x)}" cy="${n(sim.path[0].y)}" r="${BALL_R}" fill="url(#ballG)"/>`);
    add(`</svg>`);
    return o.join("");
  }

  // ── paddle
  const pt = sim.paddle.map((p) => p.t);
  const pv = sim.paddle.map((p) => n(p.x - PADDLE_W / 2));
  add(`<g class="fx">`);
  add(`<rect y="${PADDLE_Y}" width="${PADDLE_W}" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="url(#padG)" x="${pv[0]}">`);
  add(`<animate attributeName="x" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt([0, ...pt, CYCLE])}" values="${[pv[0], ...pv, pv[pv.length - 1]].join(";")}"/>`);
  add(`</rect>`);
  add(`<rect y="${PADDLE_Y + 2}" width="${n(PADDLE_W - 14)}" height="2.6" rx="1.3" fill="${t.paddleRim}" opacity=".65" x="${n(sim.paddle[0].x - PADDLE_W / 2 + 7)}">`);
  add(`<animate attributeName="x" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${kt([0, ...pt, CYCLE])}" values="${[pv[0], ...pv, pv[pv.length - 1]].map((v) => n(Number(v) + 7)).join(";")}"/>`);
  add(`</rect></g>`);

  // ── ball: one keyframe per bounce, straight lines in between
  const bt = sim.path.map((p) => p.t);
  const bx = sim.path.map((p) => n(p.x));
  const by = sim.path.map((p) => n(p.y));
  const times = kt([0, ...bt, CYCLE]);
  const xs = [bx[0], ...bx, bx[bx.length - 1]].join(";");
  const ys = [by[0], ...by, by[by.length - 1]].join(";");
  const fade = `<animate attributeName="opacity" dur="${T}" repeatCount="indefinite" keyTimes="${kt([0, LAUNCH - 0.2, LAUNCH, PLAY_END, PLAY_END + 0.35, CYCLE - 0.5, CYCLE])}" values="0;0;1;1;0;0;0"/>`;

  add(`<g class="fx">`);
  add(`<circle r="15" fill="url(#ballHalo)" cx="${bx[0]}" cy="${by[0]}">`);
  add(`<animate attributeName="cx" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${times}" values="${xs}"/>`);
  add(`<animate attributeName="cy" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${times}" values="${ys}"/>`);
  add(fade);
  add(`</circle>`);
  add(`<circle r="${BALL_R}" fill="url(#ballG)" cx="${bx[0]}" cy="${by[0]}">`);
  add(`<animate attributeName="cx" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${times}" values="${xs}"/>`);
  add(`<animate attributeName="cy" dur="${T}" repeatCount="indefinite" calcMode="linear" keyTimes="${times}" values="${ys}"/>`);
  add(fade);
  add(`</circle></g>`);

  const mono = `font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="9.5" letter-spacing="1.5"`;
  add(`<text x="${PAD_X}" y="${H - 10}" ${mono} fill="${t.label}">A YEAR OF COMMITS, ONE BRICK AT A TIME</text>`);
  add(`<text x="${n(W - PAD_X)}" y="${H - 10}" text-anchor="end" ${mono} fill="${t.label}">${sim.hits.length} BROKEN</text>`);
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
    if (T.some((x, i) => i && x <= T[i - 1])) problems.push(`keyTimes not increasing`);
    if (T[0] !== 0 || T[T.length - 1] !== 1) problems.push(`keyTimes must span 0..1`);
    if (T.length !== V.length) problems.push(`keyTimes/values mismatch (${T.length} vs ${V.length})`);
    if (spl) {
      const grp = spl[1].split(";");
      if (grp.length !== T.length - 1) problems.push(`keySplines count ${grp.length}, expected ${T.length - 1}`);
      for (const s of grp) {
        const cp = s.trim().split(/[\s,]+/).map(Number);
        if (cp.length !== 4 || cp.some((v) => !(v >= 0 && v <= 1)))
          problems.push(`keySplines outside 0..1: "${s.trim()}"`);
      }
    }
  }
  if (problems.length) {
    console.error(`\n  ${label}: ${problems.length} broken animation(s), e.g.`);
    for (const p of [...new Set(problems)].slice(0, 3)) console.error(`    ${p}`);
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
const sim = play(grid);

// A bounce off empty air ruins the illusion faster than any other flaw here.
const misses = sim.catches.filter((c) => c.gap > 0);
if (misses.length) {
  console.error(`
  ${misses.length} of ${sim.catches.length} interceptions missed the paddle`);
  console.error(`  worst overshoot: ${Math.max(...misses.map((m) => m.gap)).toFixed(1)}px past the edge`);
  throw new Error("the ball bounces off nothing — tighten the paddle tracking");
}

/**
 * The board at `time`: the wall as it stands, the paddle where it slid to and
 * the ball on its line between bounces. SMIL cannot be seeked outside a
 * browser, so this is how the rally gets reviewed.
 */
function snapshot(theme, time) {
  const t = THEMES[theme];
  const brokenAt = new Map(sim.hits.map((h) => [`${h.c}:${h.r}`, h.t]));
  const o = [];
  const svg = render(theme, grid, sim, { animated: false });
  o.push(svg.slice(0, svg.indexOf(`<rect width="${n(W)}" height="${H}" fill="url(#bg)"/>`)));
  o.push(`<rect width="${n(W)}" height="${H}" fill="url(#bg)"/>`);
  o.push(`<ellipse cx="${n(W / 2)}" cy="${WALL_BOT + 40}" rx="${n(W * 0.45)}" ry="120" fill="url(#halo)"/>`);

  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS; r++) {
      const hit = brokenAt.get(`${c}:${r}`);
      if (hit !== undefined && time >= hit) continue;
      o.push(`<use href="#k${grid[c][r]}" x="${n(brickX(c))}" y="${n(brickY(r))}"/>`);
    }

  let px = sim.paddle[0].x;
  for (const p of sim.paddle) if (p.t <= time) px = p.x;
  o.push(`<rect x="${n(px - PADDLE_W / 2)}" y="${PADDLE_Y}" width="${PADDLE_W}" height="${PADDLE_H}" rx="${PADDLE_H / 2}" fill="url(#padG)"/>`);
  o.push(`<rect x="${n(px - PADDLE_W / 2 + 7)}" y="${PADDLE_Y + 2}" width="${n(PADDLE_W - 14)}" height="2.6" rx="1.3" fill="${t.paddleRim}" opacity=".65"/>`);

  let bx = sim.path[0].x, by = sim.path[0].y;
  for (let i = 1; i < sim.path.length; i++) {
    const a = sim.path[i - 1], b = sim.path[i];
    if (time >= a.t && time <= b.t) {
      const k = (time - a.t) / Math.max(1e-6, b.t - a.t);
      bx = a.x + (b.x - a.x) * k; by = a.y + (b.y - a.y) * k;
      break;
    }
    bx = b.x; by = b.y;
  }
  o.push(`<circle cx="${n(bx)}" cy="${n(by)}" r="15" fill="url(#ballHalo)"/>`);
  o.push(`<circle cx="${n(bx)}" cy="${n(by)}" r="${BALL_R}" fill="url(#ballG)"/>`);
  o.push(`<text x="${n(W - PAD_X)}" y="14" text-anchor="end" font-family="monospace" font-size="9" fill="${t.label}">t = ${time.toFixed(1)}s</text>`);
  o.push(`</svg>`);
  return o.join("");
}

const snapAt = argOf("--snapshot", null);
if (snapAt) {
  for (const time of snapAt.split(",").map(Number)) {
    const f = join(outDir, `bsnap-${time.toFixed(1).replace(".", "_")}.svg`);
    writeFileSync(f, snapshot("dark", time), "utf8");
    console.log(`  ${f}`);
  }
}

if (args.includes("--still")) {
  for (const theme of ["dark", "light"]) {
    const f = join(outDir, `bstill-${theme}.svg`);
    writeFileSync(f, render(theme, grid, sim, { animated: false }), "utf8");
    console.log(`  ${f}`);
  }
}

for (const theme of ["dark", "light"]) {
  const svg = render(theme, grid, sim);
  const file = join(outDir, `breakout-${theme}.svg`);
  const anims = assertPlayable(svg, `breakout-${theme}.svg`);
  writeFileSync(file, svg, "utf8");
  console.log(`  ${file}  ${svg.length.toLocaleString()} B  ${anims} animations verified`);
}
console.log(`  ${sim.hits.length} bricks broken, ${sim.path.length} bounces, ${CYCLE}s loop`);
console.log(`  ${sim.catches.length} clean paddle catches, ` +
  `closest edge margin ${Math.min(...sim.catches.map((c) => -c.gap)).toFixed(1)}px`);
