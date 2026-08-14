# Store art

These cards are committed on purpose. Steam serves capsule art from
hash-based paths that differ per asset and change when store art is
re-uploaded, so hotlinking breaks silently — the legacy unhashed path
already 404s for Optical Shop Simulator.

Re-fetch when a title's store art changes:

```bash
for id in 3044520 4642730 2665380; do
  curl -s "https://store.steampowered.com/api/appdetails?appids=$id&filter=basic" \
  | python -c "import sys,json;d=json.load(sys.stdin);print(list(d.values())[0]['data']['header_image'])"
done
```

Then re-run `build_cards.py`. `sweet-pixels.webp` is composed, not fetched.
