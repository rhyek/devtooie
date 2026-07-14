#!/usr/bin/env bash
# Record the devtooie demo GIF end-to-end. Renders the VHS tape at 2x (crisp, supersampled
# text), then downscales ~1.5x — which thins out macOS's heavy font stem-darkening — and crops
# to a uniform ~20px margin, producing the committed GIF at
# packages/devtooie/assets/demo.gif. Run it from anywhere (e.g. `./scripts/demo/record.sh`).
#
# Requires: brew install vhs ttyd ffmpeg. The recording drives the real example
# (Go worker + Vite frontend), so a plain `pnpm devtooie` must boot cleanly here first.
set -euo pipefail
cd "$(dirname "$0")"

RAW="demo.raw.gif"
OUT="../../packages/devtooie/assets/demo.gif"

# Free the example's dev ports so it boots cleanly even if a stray session lingered.
for port in 3000 3001 3002; do
  pids=$(lsof -ti "tcp:$port" 2>/dev/null || true)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
done

# 1) Render the tape -> $RAW at 2x (see `Output` + the `Set` block in demo.tape).
vhs demo.tape

# 2) Downscale ~1.5x (thins strokes; leaves the final ~1680px wide so npm/GitHub never upscale
#    it and it stays crisp on retina) and crop to a uniform ~20px margin. The crop numbers match
#    demo.tape's Set block (Width 2600 / Height 1600 / Padding 62) — re-derive them if you
#    change the terminal size or padding. A full-palette + fine ordered dither keeps colors clean.
ffmpeg -y -i "$RAW" \
  -vf "scale=iw*2/3:ih*2/3:flags=lanczos,crop=1678:993:27:31,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  "$OUT"

rm -f "$RAW"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
