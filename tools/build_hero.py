"""Build the animated hero SVG for the profile README (dark + light).

Hard constraints, all verified against GitHub's renderer:
  * No @font-face of any kind. GitHub serves repo SVGs from
    raw.githubusercontent.com, whose CSP sends no font-src, so both external
    and base64-embedded fonts fail. Every headline glyph ships as an
    outlined <path>.
  * No data: rasters. raw's CSP sends no img-src either. 100% vector.
  * Animation is CSS @keyframes inside the file's own <style> block, which is
    permitted (style-src 'unsafe-inline').
  * prefers-reduced-motion collapses all motion to the finished state.
"""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT.parent / "profile-readme" / "assets"
OUT.mkdir(parents=True, exist_ok=True)
FONTS = ROOT / "fonts" / "inter" / "extras" / "ttf"

VW, VH = 1200, 340


# --------------------------------------------------------------- text→paths
class Typesetter:
    def __init__(self, ttf_path):
        self.font = TTFont(ttf_path)
        self.upem = self.font["head"].unitsPerEm
        self.cmap = self.font.getBestCmap()
        self.gs = self.font.getGlyphSet()
        self.hmtx = self.font["hmtx"]
        try:
            self.kern = self.font["kern"].kernTables[0].kernTable
        except Exception:
            self.kern = {}

    def _name(self, ch):
        return self.cmap.get(ord(ch))

    def width(self, text, size, tracking=0.0):
        s = size / self.upem
        total = 0.0
        for i, ch in enumerate(text):
            gn = self._name(ch)
            if gn is None:
                total += size * 0.4
                continue
            total += self.hmtx[gn][0] * s
            if i + 1 < len(text):
                nn = self._name(text[i + 1])
                if nn:
                    total += self.kern.get((gn, nn), 0) * s
            total += tracking
        return total

    @staticmethod
    def _num(v, prec):
        """Shortest safe decimal. Trailing zeros may only be stripped when a
        decimal point is present — '110' formatted at prec=0 must not become
        '11'."""
        s = f"{v:.{prec}f}"
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return "0" if s in ("", "-", "-0") else s

    def path(self, text, size, x=0.0, y=0.0, tracking=0.0, prec=1):
        """Return one SVG path 'd' string for the whole run, baseline at y."""
        s = size / self.upem
        out = []
        pen_x = x
        for i, ch in enumerate(text):
            gn = self._name(ch)
            if gn is None:
                pen_x += size * 0.4
                continue
            spen = SVGPathPen(self.gs, ntos=lambda v: self._num(v, prec))
            tpen = TransformPen(spen, Transform(s, 0, 0, -s, pen_x, y))
            self.gs[gn].draw(tpen)
            d = spen.getCommands()
            if d:
                out.append(d)
            pen_x += self.hmtx[gn][0] * s
            if i + 1 < len(text):
                nn = self._name(text[i + 1])
                if nn:
                    pen_x += self.kern.get((gn, nn), 0) * s
            pen_x += tracking
        return " ".join(out), pen_x - x


display = Typesetter(FONTS / "InterDisplay-Black.ttf")
semi = Typesetter(FONTS / "Inter-SemiBold.ttf")
med = Typesetter(FONTS / "Inter-Medium.ttf")


# ------------------------------------------------------------------- themes
THEMES = {
    "dark": dict(
        bg="#0D1117", ink="#F0F3F8", muted="#8A94A6", accent="#FFB020",
        rule="#FFFFFF", rule_op=".10", glow_op=".16", card_edge="#FFFFFF",
        card_edge_op=".14", card_ink="#0D1117", plate_op=".05",
    ),
    "light": dict(
        bg="#FFFFFF", ink="#0B0D12", muted="#5C6473", accent="#E08A00",
        rule="#000000", rule_op=".10", glow_op=".13", card_edge="#000000",
        card_edge_op=".10", card_ink="#FFFFFF", plate_op=".04",
    ),
}

# The shelf, as cartridges. Colours are each game's own signature; the motif
# identifies the title, so the label carries the platform.
# Genre words were tried here and rejected: the README scales the hero to 75%,
# so a 10-character label like MANAGEMENT lands under 6px on screen. Platform
# names are short enough to stay legible at the size the shelf actually is.
CARTRIDGES = [
    dict(key="coffee", ground="#C98A4B", ink="#3A2413", label="PC"),
    dict(key="optical", ground="#3E6FB0", ink="#0E1D33", label="PC"),
    dict(key="camping", ground="#4B7A5A", ink="#16261C", label="PC"),
    dict(key="sweet", ground="#E87BA8", ink="#5A1B36", label="MOBILE"),
]


def motif(key, cx, cy, ink):
    """Flat vector motif, drawn around (cx, cy) in a ~34px box."""
    o = f'fill="none" stroke="{ink}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"'
    if key == "coffee":
        return (
            f'<path d="M{cx-11},{cy-8} h19 v12 a9.5,9.5 0 0 1 -19,0 z" {o}/>'
            f'<path d="M{cx+8},{cy-5} h4.5 a5,5 0 0 1 0,10 h-1" {o}/>'
            f'<path d="M{cx-14},{cy+11} h26" {o}/>'
            f'<path d="M{cx-5},{cy-14} v-4 M{cx+1},{cy-14} v-6" {o}/>'
        )
    if key == "optical":
        return (
            f'<circle cx="{cx-8}" cy="{cy+2}" r="7.2" {o}/>'
            f'<circle cx="{cx+8}" cy="{cy+2}" r="7.2" {o}/>'
            f'<path d="M{cx-1},{cy+1} h2" {o}/>'
            f'<path d="M{cx-15},{cy-1} l-4,-5 M{cx+15},{cy-1} l4,-5" {o}/>'
        )
    if key == "camping":
        return (
            f'<path d="M{cx},{cy-13} L{cx+15},{cy+11} H{cx-15} Z" {o}/>'
            f'<path d="M{cx},{cy-13} L{cx},{cy+11}" {o}/>'
            f'<path d="M{cx-6},{cy+11} L{cx},{cy-1} L{cx+6},{cy+11}" {o}/>'
        )
    if key == "sweet":
        p = []
        for gx, gy in ((-1, -1), (0, -1), (1, -1), (-1, 0), (0, 0), (1, 0), (0, 1)):
            x, y = cx + gx * 9 - 3.6, cy + gy * 9 - 3.6
            p.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="7.2" height="7.2" rx="1.8" fill="{ink}"/>')
        return "".join(p)
    return ""


def build(theme_name):
    t = THEMES[theme_name]
    P = []
    add = P.append

    add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VW} {VH}" '
        f'width="{VW}" height="{VH}" role="img" '
        f'aria-label="Berke Abanoz — Unity developer at Vitrum Games, Izmir, Turkey">')

    # ---- defs: the drifting glow ----
    add('<defs>')
    add(f'<radialGradient id="g" cx="50%" cy="50%" r="50%">'
        f'<stop offset="0" stop-color="{t["accent"]}" stop-opacity="{t["glow_op"]}"/>'
        f'<stop offset="1" stop-color="{t["accent"]}" stop-opacity="0"/></radialGradient>')
    add(f'<linearGradient id="swg" x1="0" y1="0" x2="1" y2="0">'
        f'<stop offset="0" stop-color="{t["accent"]}" stop-opacity="0"/>'
        f'<stop offset=".5" stop-color="{t["accent"]}" stop-opacity="1"/>'
        f'<stop offset="1" stop-color="{t["accent"]}" stop-opacity="0"/></linearGradient>')
    add('</defs>')

    # ---- style ----
    add('<style>')
    add(f"""
.bg{{fill:{t['bg']}}}
.ink{{fill:{t['ink']}}}
.muted{{fill:{t['muted']}}}
.acc{{fill:{t['accent']}}}
#glow{{animation:drift 19s ease-in-out infinite}}
@keyframes drift{{0%,100%{{transform:translate(0,0)}}50%{{transform:translate(70px,-26px)}}}}

/* Every entrance below is authored as an enhancement, never as the base
   state: no rule sets opacity:0 on its own. animation-fill-mode:both still
   holds the hidden `from` frame through the delay, so the stagger survives,
   but a renderer that ignores CSS animation shows the finished hero rather
   than a blank plate. */
.wm path{{animation:ink .5s ease-out both}}
@keyframes ink{{from{{opacity:0}}to{{opacity:1}}}}

.stroke{{fill:none;stroke:{t['accent']};stroke-width:1.1;
  stroke-dasharray:1400;stroke-dashoffset:1400;
  animation:draw 1.15s cubic-bezier(.4,0,.2,1) forwards, fadeout .5s ease-in .95s forwards}}
@keyframes draw{{to{{stroke-dashoffset:0}}}}
@keyframes fadeout{{to{{opacity:0}}}}

.up{{animation:up .62s cubic-bezier(.22,1,.36,1) both}}
@keyframes up{{from{{opacity:0;transform:translateY(11px)}}to{{opacity:1;transform:none}}}}

.cart{{animation:slide .72s cubic-bezier(.22,1,.36,1) both}}
@keyframes slide{{from{{opacity:0;transform:translateX(46px) rotate(9deg)}}
  to{{opacity:1;transform:none}}}}
.bob{{animation:bob 4.6s ease-in-out infinite}}
@keyframes bob{{0%,100%{{transform:translateY(0)}}50%{{transform:translateY(-7px)}}}}

#sweep{{animation:sw 6.5s cubic-bezier(.45,0,.55,1) infinite}}
@keyframes sw{{0%{{transform:translateX(-360px)}}100%{{transform:translateX(1200px)}}}}

@media (prefers-reduced-motion:reduce){{
  #glow,.wm path,.up,.cart,.bob,#sweep{{animation:none!important}}
  .wm path,.up,.cart{{opacity:1!important;transform:none!important}}
  .stroke{{display:none}}
}}
""")
    add('</style>')

    # ---- ground ----
    add(f'<rect class="bg" width="{VW}" height="{VH}"/>')
    add(f'<g id="glow"><ellipse cx="300" cy="150" rx="440" ry="250" fill="url(#g)"/></g>')

    X = 66

    # ---- eyebrow ----
    ey, w = med.path("UNITY DEVELOPER", 15, X + 22, 92, tracking=3.4, prec=0)
    add(f'<g class="up" style="animation-delay:.05s">'
        f'<rect x="{X}" y="80.5" width="11" height="11" rx="2.5" class="acc"/>'
        f'<path class="acc" d="{ey}"/></g>')

    # ---- wordmark: outlined glyphs, drawn on then filled ----
    # The draw-on stroke reuses the same geometry via <use> rather than a
    # second copy of the path data — halves the largest asset in the file.
    # Fill lives on the wrapping <g>, never on #wm itself: <use> clones the
    # referenced node, and a class on it would win over the fill:none the
    # clone must inherit from the <use> — leaving a filled duplicate on top.
    SIZE = 78
    d_wm, wm_w = display.path("BERKE ABANOZ", SIZE, X, 186, tracking=-1.2)
    add(f'<g class="wm" fill="{t["ink"]}"><path id="wm" d="{d_wm}" style="animation-delay:.30s"/></g>')
    add('<use class="stroke" href="#wm"/>')

    # ---- subtitle ----
    sub = "Shipping commercial games at Vitrum Games  ·  İzmir, Türkiye"
    d_sub, _ = semi.path(sub, 17.5, X + 2, 224, tracking=.15, prec=0)
    add(f'<g class="up" style="animation-delay:.62s"><path class="muted" d="{d_sub}"/></g>')

    # ---- proof line ----
    proof = "4 titles shipped  ·  Steam  ·  Google Play  ·  Unity / C#"
    d_pr, _ = med.path(proof, 13.5, X + 2, 252, tracking=.9, prec=0)
    add(f'<g class="up" style="animation-delay:.74s"><path class="muted" d="{d_pr}" opacity=".72"/></g>')

    # ---- hairline + sweep ----
    ry = 288
    add(f'<rect x="{X}" y="{ry}" width="{VW - X * 2}" height="1.4" '
        f'fill="{t["rule"]}" opacity="{t["rule_op"]}"/>')
    add(f'<g clip-path="inset(0)"><rect id="sweep" x="{X}" y="{ry}" width="300" height="1.4" '
        f'fill="url(#swg)"/></g>')

    # ---- cartridge shelf ----
    CW, CH, GAP = 74, 104, 15
    n = len(CARTRIDGES)
    total = n * CW + (n - 1) * GAP
    sx = VW - 66 - total
    sy = 118  # centred against the text block (eyebrow 92 → proof 252)

    for i, c in enumerate(CARTRIDGES):
        x = sx + i * (CW + GAP)
        delay = .52 + i * .09
        add(f'<g class="cart" style="animation-delay:{delay:.2f}s">')
        add(f'<g class="bob" style="animation-delay:{-i * 1.15:.2f}s">')
        add(f'<g transform="rotate(-5 {x + CW/2} {sy + CH/2})">')
        # plate
        add(f'<rect x="{x}" y="{sy}" width="{CW}" height="{CH}" rx="13" fill="{c["ground"]}"/>')
        add(f'<rect x="{x}" y="{sy}" width="{CW}" height="{CH}" rx="13" fill="none" '
            f'stroke="{t["card_edge"]}" stroke-opacity="{t["card_edge_op"]}" stroke-width="1.2"/>')
        # top gloss
        add(f'<path d="M{x+13},{sy} h{CW-26} a13,13 0 0 1 13,13 v9 h-{CW} v-9 a13,13 0 0 1 13,-13 z" '
            f'fill="#FFFFFF" opacity=".14"/>')
        # motif
        add(motif(c["key"], x + CW / 2, sy + 44, c["ink"]))
        # Label bar. Genre names vary in length, so the type shrinks to fit
        # the plate rather than the plate growing to fit the type — the shelf
        # has to stay a shelf.
        bar_x, bar_w = x + 7, CW - 14
        size, track = 11.0, 1.3
        while size > 8.4 and med.width(c["label"], size, tracking=track) > bar_w - 8:
            size -= .2
            track = max(.5, track - .05)
        lw = med.width(c["label"], size, tracking=track)
        d_lb, _ = med.path(c["label"], size, x + CW / 2 - lw / 2, sy + CH - 17.5,
                           tracking=track, prec=0)
        add(f'<rect x="{bar_x}" y="{sy+CH-30}" width="{bar_w}" height="18" rx="6" '
            f'fill="{c["ink"]}" opacity=".22"/>')
        add(f'<path d="{d_lb}" fill="{c["ink"]}" opacity=".88"/>')
        add('</g></g></g>')

    add('</svg>')
    return "".join(P)


def freeze(svg):
    """Return the reduced-motion rendering: what a viewer who opts out of
    animation sees, and the state every animation must settle into. Written
    to work/ for review only — never committed."""
    return svg.replace(
        "@media (prefers-reduced-motion:reduce){",
        "@media all{",
    )


if __name__ == "__main__":
    for name in ("dark", "light"):
        svg = build(name)
        p = OUT / f"hero-{name}.svg"
        p.write_text(svg, encoding="utf-8")
        assert "data:image" not in svg, "raster embedded — blocked by raw CSP"
        assert "@font-face" not in svg, "webfont embedded — blocked by raw CSP"
        print(f"  hero-{name}.svg  {p.stat().st_size:>7,} B")

        f = ROOT / f"hero-{name}-frozen.svg"
        f.write_text(freeze(svg), encoding="utf-8")
