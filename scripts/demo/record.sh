#!/usr/bin/env bash
# Record the devtooie demo GIF end-to-end. Renders the VHS tape at 2x (crisp, supersampled
# text), then downscales ~1.5x — which thins out macOS's heavy font stem-darkening — and crops
# to a uniform ~20px margin, producing the committed GIF at
# packages/devtooie/assets/demo-<unix-ts>.gif — the timestamp suffix busts GitHub's and npm's
# image caches, so a re-recording is actually visible. Any previous demo GIF is deleted and the
# README's image URL is rewritten to point at the new filename.
# Run it from anywhere (e.g. `./scripts/demo/record.sh`).
#
# Check the result with `node scripts/demo/frames.ts`: it splits the GIF into frames and
# flags any the recorder caught mid-repaint (half the screen drawn, the rest blank) — a
# single such frame is easy to miss at playback speed.
#
# Requires: brew install vhs ttyd ffmpeg (plus expect, which macOS ships). The recording
# drives the real example (Go worker + Vite frontend), so a plain `pnpm devtooie` must boot
# cleanly here first. It also *overwrites the clipboard*: the recording double-clicks a word
# in the log, which really copies it, and then pastes it back into devtooie's filter.
set -euo pipefail
cd "$(dirname "$0")"

RAW="demo.raw.gif"
ASSETS="../../packages/devtooie/assets"
README="../../README.md"
OUT_NAME="demo-$(date +%s).gif"
OUT="$ASSETS/$OUT_NAME"

# Free the example's dev ports so it boots cleanly even if a stray session lingered.
for port in 3000 3001 3002; do
  pids=$(lsof -ti "tcp:$port" 2>/dev/null || true)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
done

# 1) Seed the clipboard with what the demo's double-click is expected to copy. The tape pastes
# the clipboard into devtooie's filter, so if the injected click ever misses, the GIF shows
# this instead of whatever the machine happened to have on the clipboard.
printf 'added' | pbcopy

# 2) Render the tape -> $RAW at 2x (see `Output` + the `Set` block in demo.tape).
vhs demo.tape

# 3) Downscale ~1.5x (thins strokes; leaves the final ~1680px wide so npm/GitHub never upscale
#    it and it stays crisp on retina) and crop to a uniform ~20px margin. The crop numbers match
#    demo.tape's Set block (Width 2600 / Height 1600 / Padding 62) — re-derive them if you
#    change the terminal size or padding. A full-palette + fine ordered dither keeps colors clean.
ffmpeg -y -i "$RAW" \
  -vf "scale=iw*2/3:ih*2/3:flags=lanczos,crop=1678:993:27:31,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" \
  "$OUT"

rm -f "$RAW"

# 4) Point the README's image URL at the new filename, and bail if it didn't take — this runs
#    before the old GIF is dropped, so a README the pattern no longer matches aborts the script
#    with the previous recording still in place rather than with a link to a deleted file.
sed -i '' -E "s|assets/demo(-[0-9]+)?\.gif|assets/$OUT_NAME|g" "$README"
grep -q "assets/$OUT_NAME" "$README" || {
  echo "error: could not find the demo GIF URL to update in README.md" >&2
  exit 1
}

# 5) Drop any earlier demo GIF — `assets/` ships wholesale in the npm tarball, so leaving the
#    old ones behind would grow the published package with every recording.
find "$ASSETS" -maxdepth 1 -name 'demo*.gif' ! -name "$OUT_NAME" -delete

echo "wrote $OUT ($(du -h "$OUT" | cut -f1)); README.md updated"
