"""Build the 460x215 store-card shelf for the profile README.

Steam headers are already 460x215 and ship as-is (re-encoded to WebP).
Titles without store capsule art get a card composed in the same visual
language: full-bleed art, baked-in logo, no border.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path
import colorsys

ROOT = Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT.parent / "profile-readme" / "assets" / "store"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 460, 215
SS = 3  # supersample factor for crisp type

INTER = ROOT / "fonts" / "inter" / "extras" / "ttf"
F_BLACK = str(INTER / "Inter-Black.ttf")
F_BOLD = str(INTER / "Inter-Bold.ttf")
F_SEMI = str(INTER / "Inter-SemiBold.ttf")


def font(path, size):
    return ImageFont.truetype(path, size)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def vgradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", (1, h))
    px = img.load()
    for y in range(h):
        px[0, y] = lerp(top, bottom, y / max(1, h - 1))
    return img.resize((w, h), Image.BICUBIC)


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def shadow(size, radius, blur, spread, alpha):
    """Soft drop shadow layer sized to the full card."""
    lay = Image.new("L", size, 0)
    return lay, radius, blur, spread, alpha


def text_with_shadow(draw, xy, text, fnt, fill, shadow_fill, offset, anchor="ls"):
    x, y = xy
    draw.text((x + offset, y + offset), text, font=fnt, fill=shadow_fill, anchor=anchor)
    draw.text((x, y), text, font=fnt, fill=fill, anchor=anchor)


# ---------------------------------------------------------------- Steam cards
def passthrough(src_name, out_name):
    im = Image.open(SRC / src_name).convert("RGB")
    if im.size != (W, H):
        im = im.resize((W, H), Image.LANCZOS)
    im.save(OUT / out_name, "WEBP", quality=88, method=6)
    return (OUT / out_name).stat().st_size


# --------------------------------------------------------- Sweet Pixels card
def sweet_pixels():
    icon = Image.open(SRC / "sweetpixels-icon.png").convert("RGB")

    # Ground: pink gradient pulled from the icon's own palette.
    top, bottom = (255, 226, 238), (249, 154, 192)
    card = vgradient((W * SS, H * SS), top, bottom).convert("RGBA")

    # Big soft bloom of the artwork bleeding off the right edge.
    bleed = icon.resize((int(H * SS * 1.55),) * 2, Image.LANCZOS)
    glow = bleed.filter(ImageFilter.GaussianBlur(26 * SS // 3))
    gl = Image.new("RGBA", card.size, (0, 0, 0, 0))
    gl.paste(glow, (int(W * SS * 0.52), int(-H * SS * 0.16)))
    gl.putalpha(gl.split()[-1].point(lambda v: 110 if v else 0))
    card = Image.alpha_composite(card, gl)

    # Crisp icon plate, rounded, with a soft drop shadow.
    plate = int(H * SS * 0.74)
    art = icon.resize((plate, plate), Image.LANCZOS)
    art.putalpha(rounded_mask((plate, plate), int(plate * 0.22)))
    px, py = int(W * SS * 0.635), int((H * SS - plate) / 2)

    sh = Image.new("RGBA", card.size, (0, 0, 0, 0))
    sd = Image.new("L", card.size, 0)
    ImageDraw.Draw(sd).rounded_rectangle(
        [px + 3 * SS, py + 6 * SS, px + plate + 3 * SS, py + plate + 6 * SS],
        int(plate * 0.22), fill=95)
    sd = sd.filter(ImageFilter.GaussianBlur(9 * SS))
    sh.putalpha(sd)
    card = Image.alpha_composite(card, sh)
    card.paste(art, (px, py), art)

    # Scattered candy confetti in the empty left field.
    d = ImageDraw.Draw(card, "RGBA")
    confetti = [
        (0.09, 0.20, 13, (255, 255, 255, 150)), (0.20, 0.13, 9, (255, 173, 205, 190)),
        (0.05, 0.62, 10, (255, 255, 255, 120)), (0.30, 0.80, 12, (255, 196, 220, 170)),
        (0.15, 0.88, 8, (255, 255, 255, 130)), (0.41, 0.16, 9, (255, 210, 230, 160)),
        (0.36, 0.92, 7, (255, 255, 255, 110)), (0.02, 0.40, 7, (255, 190, 215, 150)),
    ]
    for fx, fy, r, col in confetti:
        cx, cy = fx * W * SS, fy * H * SS
        rr = r * SS / 2
        d.rounded_rectangle([cx - rr, cy - rr, cx + rr, cy + rr], rr * 0.45, fill=col)

    # Logo lockup.
    f_title = font(F_BLACK, int(37 * SS))
    f_sub = font(F_BOLD, int(13.5 * SS))
    ink = (150, 42, 88)
    glow_c = (255, 255, 255, 210)

    tx, ty = int(W * SS * 0.055), int(H * SS * 0.40)
    for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2), (-2, -2), (2, 2), (-2, 2), (2, -2)):
        d.text((tx + dx * SS, ty + dy * SS), "SWEET", font=f_title, fill=glow_c, anchor="ls")
    d.text((tx, ty), "SWEET", font=f_title, fill=ink, anchor="ls")

    ty2 = ty + int(38 * SS)
    for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2), (-2, -2), (2, 2), (-2, 2), (2, -2)):
        d.text((tx + dx * SS, ty2 + dy * SS), "PIXELS", font=f_title, fill=glow_c, anchor="ls")
    d.text((tx, ty2), "PIXELS", font=f_title, fill=ink, anchor="ls")

    # Genre chip above the logo.
    chip = "PUZZLE"
    cw = d.textlength(chip, font=f_sub)
    cx0, cy0 = tx, int(H * SS * 0.155)
    d.rounded_rectangle(
        [cx0 - 9 * SS, cy0 - 6 * SS, cx0 + cw + 9 * SS, cy0 + 20 * SS],
        10 * SS, fill=(255, 255, 255, 190))
    d.text((cx0, cy0 + 14 * SS), chip, font=f_sub, fill=(196, 70, 121), anchor="ls")

    card = card.convert("RGB").resize((W, H), Image.LANCZOS)
    card.save(OUT / "sweet-pixels.webp", "WEBP", quality=90, method=6)
    return (OUT / "sweet-pixels.webp").stat().st_size


if __name__ == "__main__":
    jobs = [
        ("steam-3044520.jpg", "coffee-express.webp"),
        ("steam-4642730.jpg", "optical-shop.webp"),
        ("steam-2665380.jpg", "camping-vlog.webp"),
    ]
    for s, o in jobs:
        print(f"  {o:26} {passthrough(s, o):>7,} B")
    print(f"  {'sweet-pixels.webp':26} {sweet_pixels():>7,} B")
