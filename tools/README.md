# Build scripts

The hero and the store shelf are generated, not hand-drawn. Both write
straight into `../assets/`.

```bash
pip install fonttools pillow brotli
python tools/build_hero.py     # assets/hero-{dark,light}.svg
python tools/build_cards.py    # assets/store/*.webp
```

`build_hero.py` expects Inter at `work/fonts/inter/extras/ttf/` — download
`Inter-4.1.zip` from https://github.com/rsms/inter/releases and unzip it
there. Headline glyphs are converted to outlined paths because GitHub serves
repo SVGs under a CSP with no `font-src`, so no webfont of any kind loads.

To change the cartridges on the hero, edit `CARTRIDGES`. Labels shrink to fit
their plate, but the README displays the hero at 75%, so anything much longer
than `MOBILE` stops being readable.

`build_cards.py` re-encodes Steam headers and composes the Sweet Pixels card.
See `assets/store/README.md` for how to refresh the source art.
