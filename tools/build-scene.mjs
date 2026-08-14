/**
 * An idle garden scene grown from a year of commits.
 *
 * Not a grid. One hero flower stands in the middle of a small garden and sways
 * in the wind; how tall it stands, how many petals it opens and how many
 * companions it has are all read off the contribution calendar. The dark theme
 * is the same garden at night, so switching GitHub's theme turns day to dusk.
 *
 * Art direction follows the Dream Games house style rather than cel shading:
 * rounded forms with no sharp edges, soft volume from gradients instead of flat
 * bands, a rim light to lift each silhouette off the background, and saturated
 * but never garish colour.
 *
 * Nothing shares a master timeline — the sway, the leaves, the head and the
 * drifting pollen each loop on their own period, so the motion never falls into
 * lockstep and the whole thing is seamless by construction.
 *
 * Two SMIL rules are load-bearing and both fail silently, leaving a perfect
 * still image that never moves:
 *   * keyTimes must be strictly increasing.
 *   * every keySplines control point must sit inside 0..1 — unlike CSS
 *     cubic-bezier, an overshoot is rejected outright rather than clamped.
 * assertPlayable() refuses to write a file that breaks either.
 *
 *   node tools/build-scene.mjs --out dist [--data contributions.json]
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const W = 880, H = 300;
const GROUND = 236;          // horizon
const n = (v) => Number(v.toFixed(1));

// ─────────────────────────────────────────────── palettes
const THEMES = {
  light: {
    name: "day",
    skyTop: "#BFE6FF", skyBot: "#EAF7F2",
    glow: "#FFF3C4", glowOp: 0.85,
    hillFar: "#8FD08A", hillFarLo: "#6FBE75",
    hillNear: "#74C26B", hillNearLo: "#4EA35A",
    soil: "#B98A5E", soilLo: "#9A6E48",
    stem: "#5CB25F", stemLo: "#3E8C4A", stemRim: "#9FE08F",
    leaf: "#63BE6A", leafLo: "#3F9450", leafRim: "#A6E49A",
    petal: "#FF8DA8", petalLo: "#EC5C82", petalRim: "#FFD7E2",
    core: "#FFC93C", coreLo: "#F0A21C", coreRim: "#FFEBA8",
    mote: "#FFFFFF", moteOp: 0.75,
    smallPetal: "#FFC7DA", smallCore: "#FFD766",
    label: "#5E7A6B",
  },
  dark: {
    name: "dusk",
    skyTop: "#1A2142", skyBot: "#2B2C52",
    glow: "#FFE6A8", glowOp: 0.30,
    hillFar: "#2C4A46", hillFarLo: "#223A38",
    hillNear: "#2F5347", hillNearLo: "#213E36",
    soil: "#4A3728", soilLo: "#372A1E",
    stem: "#499B58", stemLo: "#2F6B3E", stemRim: "#8FD98A",
    leaf: "#4FA75F", leafLo: "#2F7444", leafRim: "#97DE93",
    petal: "#FF8FB0", petalLo: "#D95580", petalRim: "#FFD9E6",
    core: "#FFCE55", coreLo: "#E09B22", coreRim: "#FFF0B6",
    mote: "#FFE9A8", moteOp: 0.9,
    smallPetal: "#E9A9C6", smallCore: "#FFCF63",
    label: "#7E8AA0",
  },
};

// ─────────────────────────────────────────────── contribution data
function synthetic() {
  let seed = 20260814;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: 53 }, () => {
    const burst = rnd() < 0.3 ? 3 : 1;
    return Array.from({ length: 7 }, (_, r) => {
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
  return src.map((w) => (w.contributionDays ?? w).map((x) =>
    typeof x === "number" ? x : x.contributionCount ?? 0));
}

/** What the year buys the garden. */
function growth(weeks) {
  const days = weeks.flat();
  const total = days.reduce((s, v) => s + v, 0);
  const activeDays = days.filter((v) => v > 0).length;
  const best = Math.max(0, ...days);
  return {
    total, activeDays, best,
    petals: Math.max(5, Math.min(10, 5 + Math.floor(total / 130))),
    bloom: 0.72 + Math.min(0.46, total / 1100),
    height: 96 + Math.min(46, activeDays * 0.28),
    companions: Math.max(2, Math.min(7, Math.round(activeDays / 26))),
  };
}

// ─────────────────────────────────────────────── drawing helpers
/**
 * Sway is a rotation about the plant's own base, phrased as a full there-and-
 * back cycle so the animation loops on its own period without a master clock.
 */
const sway = (deg, dur, delay, ox, oy) =>
  `<animateTransform attributeName="transform" type="rotate" additive="sum" ` +
  `dur="${dur}s" repeatCount="indefinite" begin="-${delay}s" calcMode="spline" ` +
  `keyTimes="0;0.25;0.5;0.75;1" ` +
  `values="0 ${n(ox)} ${n(oy)};${deg} ${n(ox)} ${n(oy)};0 ${n(ox)} ${n(oy)};` +
  `${-deg} ${n(ox)} ${n(oy)};0 ${n(ox)} ${n(oy)}" ` +
  `keySplines=".45 0 .55 1;.45 0 .55 1;.45 0 .55 1;.45 0 .55 1"/>`;

const breathe = (from, to, dur, delay) =>
  `<animateTransform attributeName="transform" type="scale" additive="sum" ` +
  `dur="${dur}s" repeatCount="indefinite" begin="-${delay}s" calcMode="spline" ` +
  `keyTimes="0;0.5;1" values="${from};${to};${from}" ` +
  `keySplines=".45 0 .55 1;.45 0 .55 1"/>`;

/** One petal, drawn once and reused at every angle. */
const petalPath = "M0,0 C7.5,-5 11,-17 0,-25.5 C-11,-17 -7.5,-5 0,0 Z";

function flower(t, g) {
  // A daisy reads by its petals, not its middle: the core stays small so most
  // of each petal is visible. Earlier passes had the core covering two thirds
  // of the petal, which turned the whole head into a gear.
  const CORE = 8.4;
  const p = [];
  const step = 360 / g.petals;
  // an offset ring behind, peeking through the gaps
  for (let i = 0; i < g.petals; i++) {
    p.push(`<use href="#pt" transform="rotate(${n(i * step + step / 2)}) scale(.88)" fill="url(#gPetalBack)"/>`);
  }
  for (let i = 0; i < g.petals; i++) {
    p.push(`<use href="#pt" transform="rotate(${n(i * step)})" fill="url(#gPetal)"/>`);
    // a lit crease down the middle of each petal
    p.push(`<use href="#pt" transform="rotate(${n(i * step)}) scale(.6)" fill="${t.petalRim}" opacity=".3"/>`);
  }
  p.push(`<circle r="${CORE}" fill="url(#gCore)"/>`);
  p.push(`<circle r="${CORE}" fill="none" stroke="${t.coreRim}" stroke-opacity=".6" stroke-width="1.4"/>`);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    p.push(`<circle cx="${n(Math.cos(a) * 3.9)}" cy="${n(Math.sin(a) * 3.9)}" r="1.2" fill="${t.coreLo}" opacity=".6"/>`);
  }
  p.push(`<circle cx="-2.7" cy="-3.1" r="2.3" fill="#FFFFFF" opacity=".45"/>`);
  return p.join("");
}

function heroPlant(t, g) {
  const baseY = GROUND + 4;
  const topY = baseY - g.height;
  const p = [];

  // everything below is drawn about x=0; the whole plant is placed at centre
  p.push(`<g transform="translate(${W / 2},0)">`);
  p.push(sway(3.2, 5.2, 0, 0, baseY));

  // stem — a gentle S so it never reads as a stick
  const stemD =
    `M-5.5,${n(baseY)} C-7,${n(baseY - g.height * 0.42)} 5,${n(baseY - g.height * 0.62)} 1.5,${n(topY)} ` +
    `L-1.5,${n(topY)} C2,${n(baseY - g.height * 0.62)} -10,${n(baseY - g.height * 0.42)} -8.5,${n(baseY)} Z`;
  p.push(`<path d="${stemD}" fill="url(#gStem)"/>`);
  p.push(`<path d="M-5.5,${n(baseY)} C-7,${n(baseY - g.height * 0.42)} 5,${n(baseY - g.height * 0.62)} 1.5,${n(topY)}" fill="none" stroke="${t.stemRim}" stroke-opacity=".55" stroke-width="1.8" stroke-linecap="round"/>`);

  // leaves, each on its own slower beat
  const leaf = (x, y, rot, scale, dur, delay) =>
    `<g transform="translate(${n(x)},${n(y)}) rotate(${rot}) scale(${scale})">` +
    sway(5.5, dur, delay, 0, 0) +
    `<path d="M0,0 C16,-6 30,-2 38,10 C24,20 8,16 0,0 Z" fill="url(#gLeaf)"/>` +
    `<path d="M0,0 C16,-6 30,-2 38,10" fill="none" stroke="${t.leafRim}" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>` +
    `<path d="M2,2 C14,4 24,8 34,11" fill="none" stroke="${t.leafLo}" stroke-opacity=".45" stroke-width="1.3" stroke-linecap="round"/>` +
    `</g>`;
  p.push(leaf(-4, baseY - g.height * 0.46, 8, 0.95, 6.4, 1.1));
  p.push(leaf(1, baseY - g.height * 0.66, 168, 0.8, 7.1, 2.6));

  // head — counter-sways a touch behind the stem, which reads as weight
  p.push(`<g transform="translate(0,${n(topY)})">`);
  p.push(sway(4.5, 5.2, 0.42, 0, 0));
  p.push(`<g>`);
  p.push(breathe("1 1", "1.045 1.045", 4.6, 0));
  p.push(flower(t, g));
  p.push(`</g></g>`);
  p.push(`</g>`);
  return p.join("");
}

function companion(t, x, scale, hue, dur, delay) {
  const baseY = GROUND + 6;
  const h = 34 * scale;
  return `<g transform="translate(${n(x)},0)">` +
    sway(4.2, dur, delay, 0, baseY) +
    `<path d="M-2.4,${n(baseY)} C-3,${n(baseY - h * 0.5)} 2.4,${n(baseY - h * 0.7)} 0.9,${n(baseY - h)} ` +
    `L-1.4,${n(baseY - h)} C0.4,${n(baseY - h * 0.7)} -5,${n(baseY - h * 0.5)} -4.6,${n(baseY)} Z" fill="url(#gStem)"/>` +
    `<g transform="translate(0,${n(baseY - h)}) scale(${n(scale * 0.5)})">` +
    Array.from({ length: 5 }, (_, i) =>
      `<use href="#pt" transform="rotate(${n(i * 72)}) scale(.92)" fill="${hue}"/>`).join("") +
    `<circle r="6.4" fill="${t.smallCore}"/>` +
    `<circle cx="-2" cy="-2.2" r="2.1" fill="#FFFFFF" opacity=".5"/>` +
    `</g></g>`;
}

function grassTuft(t, x, scale, dur, delay) {
  const y = GROUND + 8;
  // a blade is a filled sliver, not a stroked squiggle — it tapers to a point
  const blade = (lean, len, wide) =>
    `<path d="M0,0 C${n(-wide)},${n(-len * 0.4)} ${n(lean * 0.4)},${n(-len * 0.75)} ${n(lean)},${n(-len)} ` +
    `C${n(lean * 0.3)},${n(-len * 0.72)} ${n(wide)},${n(-len * 0.38)} ${wide},0 Z" fill="${t.hillNearLo}" opacity=".85"/>`;
  return `<g transform="translate(${n(x)},${n(y)}) scale(${scale})">` +
    sway(6, dur, delay, 0, 0) +
    blade(-7, 17, 1.7) + blade(1, 23, 2.0) + blade(8, 15, 1.6) +
    `</g>`;
}

// ─────────────────────────────────────────────── svg
function render(theme, g, { animated = true } = {}) {
  const t = THEMES[theme];
  const o = [];
  const add = (s) => o.push(s);

  add(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="An idle garden grown from a year of commits — a flower swaying in the wind">`);
  add(`<defs>`);
  add(`<linearGradient id="gSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.skyTop}"/><stop offset="1" stop-color="${t.skyBot}"/></linearGradient>`);
  add(`<radialGradient id="gGlow"><stop offset="0" stop-color="${t.glow}" stop-opacity="${t.glowOp}"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>`);
  add(`<linearGradient id="gHillFar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.hillFar}"/><stop offset="1" stop-color="${t.hillFarLo}"/></linearGradient>`);
  add(`<linearGradient id="gHillNear" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.hillNear}"/><stop offset="1" stop-color="${t.hillNearLo}"/></linearGradient>`);
  add(`<linearGradient id="gStem" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.stemLo}"/><stop offset=".55" stop-color="${t.stem}"/><stop offset="1" stop-color="${t.stemLo}"/></linearGradient>`);
  add(`<linearGradient id="gLeaf" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="${t.leaf}"/><stop offset="1" stop-color="${t.leafLo}"/></linearGradient>`);
  add(`<linearGradient id="gPetal" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${t.petalLo}"/><stop offset="1" stop-color="${t.petal}"/></linearGradient>`);
  add(`<linearGradient id="gPetalBack" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${t.petalLo}"/><stop offset="1" stop-color="${t.petalLo}"/></linearGradient>`);
  add(`<radialGradient id="gCore" cx=".38" cy=".34"><stop offset="0" stop-color="${t.coreRim}"/><stop offset=".55" stop-color="${t.core}"/><stop offset="1" stop-color="${t.coreLo}"/></radialGradient>`);
  add(`<radialGradient id="gShade"><stop offset="0" stop-color="#000000" stop-opacity=".28"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></radialGradient>`);
  add(`<path id="pt" d="${petalPath}"/>`);
  add(`</defs>`);

  // ── sky and light
  add(`<rect width="${W}" height="${H}" fill="url(#gSky)"/>`);
  add(`<g><ellipse cx="${W * 0.5}" cy="140" rx="360" ry="200" fill="url(#gGlow)"/>`);
  if (animated) add(breathe("1 1", "1.06 1.06", 11, 0));
  add(`</g>`);

  // ── land: two rolling banks, the far one lighter for depth
  add(`<path d="M0,${GROUND - 16} C150,${GROUND - 42} 300,${GROUND - 6} 470,${GROUND - 22} C640,${GROUND - 38} 780,${GROUND - 8} ${W},${GROUND - 24} L${W},${H} L0,${H} Z" fill="url(#gHillFar)"/>`);
  add(`<path d="M0,${GROUND + 6} C170,${GROUND - 14} 330,${GROUND + 10} 470,${GROUND - 2} C620,${GROUND - 14} 760,${GROUND + 12} ${W},${GROUND - 2} L${W},${H} L0,${H} Z" fill="url(#gHillNear)"/>`);

  // ── companions behind, then the hero, then a couple in front
  const spread = [-300, -222, -150, 152, 226, 300, -84, 88];
  for (let i = 0; i < g.companions; i++) {
    const x = W / 2 + spread[i % spread.length];
    const sc = 0.75 + ((i * 37) % 40) / 100;
    const hue = i % 2 ? t.smallPetal : t.petalRim;
    add(companion(t, x, sc, hue, 5.6 + (i % 4) * 0.7, (i * 0.9) % 4));
  }
  for (let i = 0; i < 9; i++) {
    const x = 60 + i * 92 + ((i * 53) % 30);
    add(grassTuft(t, x, 0.8 + ((i * 29) % 30) / 100, 5 + (i % 3) * 0.8, (i * 0.7) % 4));
  }

  // contact shadow keeps the hero from floating
  add(`<ellipse cx="${W / 2}" cy="${GROUND + 10}" rx="52" ry="9" fill="url(#gShade)"/>`);
  add(heroPlant(t, g));

  // ── motes drifting up through the light
  if (animated) {
    for (let i = 0; i < 14; i++) {
      const x = 90 + ((i * 137) % (W - 180));
      const r = 1.6 + ((i * 17) % 20) / 10;
      const dur = 7 + ((i * 23) % 60) / 10;
      const delay = (i * 1.7) % dur;
      const rise = 120 + ((i * 41) % 90);
      add(`<circle cx="${n(x)}" cy="${GROUND - 4}" r="${n(r)}" fill="${t.mote}" opacity="0">` +
        `<animate attributeName="cy" dur="${n(dur)}s" repeatCount="indefinite" begin="-${n(delay)}s" ` +
        `values="${GROUND - 4};${n(GROUND - 4 - rise)}" calcMode="spline" keyTimes="0;1" keySplines=".3 0 .7 1"/>` +
        `<animate attributeName="cx" dur="${n(dur)}s" repeatCount="indefinite" begin="-${n(delay)}s" ` +
        `values="${n(x)};${n(x + (i % 2 ? 26 : -26))}" calcMode="spline" keyTimes="0;1" keySplines=".4 0 .6 1"/>` +
        `<animate attributeName="opacity" dur="${n(dur)}s" repeatCount="indefinite" begin="-${n(delay)}s" ` +
        `keyTimes="0;0.18;0.75;1" values="0;${t.moteOp};${t.moteOp * 0.5};0"/>` +
        `</circle>`);
    }
  }

  // ── caption
  const mono = `font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="11" letter-spacing="1.4"`;
  add(`<text x="26" y="${H - 16}" ${mono} fill="${t.label}">${g.total.toLocaleString("en-US")} COMMITS THIS YEAR</text>`);
  add(`<text x="${W - 26}" y="${H - 16}" text-anchor="end" ${mono} fill="${t.label}">STILL GROWING</text>`);
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

const g = growth(loadData(argOf("--data", null)));

if (args.includes("--still")) {
  for (const theme of ["dark", "light"]) {
    const f = join(outDir, `still-${theme}.svg`);
    writeFileSync(f, render(theme, g, { animated: false }), "utf8");
    console.log(`  ${f}`);
  }
}

for (const theme of ["dark", "light"]) {
  const svg = render(theme, g);
  const file = join(outDir, `scene-${theme}.svg`);
  const anims = assertPlayable(svg, `scene-${theme}.svg`);
  writeFileSync(file, svg, "utf8");
  console.log(`  ${file}  ${svg.length.toLocaleString()} B  ${anims} animations verified`);
}
console.log(`  ${g.total.toLocaleString()} commits · ${g.activeDays} active days ` +
  `→ ${g.petals} petals, ${g.companions} companions, stem ${Math.round(g.height)}px`);
