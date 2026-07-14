# devtooie demo — the tape behind the README hero GIF (records the example monorepo's TUI).
#
# Don't run this tape directly. Use the wrapper (from the repo root), which renders it and
# then does the 2x->1x downscale (thins macOS font stem-darkening) + uniform-margin crop that
# produce the committed GIF:
#   ./scripts/demo/record.sh
#
# Requires vhs + its runtime deps:  brew install vhs ttyd ffmpeg
# The recording drives the real example (Go worker + Vite frontend), so those must
# be runnable here first (a plain `pnpm devtooie` should boot cleanly).

Output demo.raw.gif

Require pnpm

Set Shell "bash"
Set FontFamily "Menlo"
# Rendered large, then downscaled ~1.5x on export (see record.sh): the supersampling thins
# macOS's heavy font stem-darkening (VHS has no thin-strokes/font-weight setting), while the
# ~1680px final width means npm/GitHub never upscale it and it stays crisp on retina. FontSize
# is tuned to keep ~120 columns at this width.
Set FontSize 36
Set Width 2600
Set Height 1600
Set Padding 62
# Cap the capture rate to what headless Chromium can sustain at this render size, so VHS
# doesn't drop frames and time-compress the result — this keeps playback at real speed.
Set Framerate 15
Set TypingSpeed 55ms
# Vibrant palette sampled from the original terminal screenshot (bg #24292E) so the ANSI
# status colors read as punchy as a real terminal rather than washed-out pastel.
Set Theme { "name": "devtooie", "background": "#24292E", "foreground": "#CFD3D7", "black": "#3B4048", "brightBlack": "#6D6D98", "red": "#DF6974", "brightRed": "#F97583", "green": "#36CB61", "brightGreen": "#56D364", "yellow": "#E5C07B", "brightYellow": "#FFC777", "blue": "#4E9CCD", "brightBlue": "#79C0FF", "magenta": "#9B72E3", "brightMagenta": "#C8A2FF", "cyan": "#4EC9D3", "brightCyan": "#56D4DD", "white": "#CFD3D7", "brightWhite": "#FFFFFF", "cursor": "#CFD3D7", "selection": "#3A6A9E" }

# --- hidden setup: clean prompt + fresh selection so the selector shows ---
Hide
Type "export PS1='$ '" Enter
Sleep 300ms
# Force the footer's git branch to read `main` no matter which branch we record from.
Type "export DEVTOOIE_DEMO_RECORDING=1" Enter
Sleep 200ms
Type "cd ../../example" Enter
Sleep 300ms
Type "pnpm devtooie reset" Enter
Sleep 1500ms
Type "clear" Enter
Sleep 500ms
Show

# --- launch: the package selector ---
Type "pnpm devtooie" Enter
Sleep 2500ms

# select each package one-by-one (space toggles the row under the cursor)
Space
Sleep 500ms
Down
Sleep 350ms
Space
Sleep 500ms
Down
Sleep 350ms
Space
Sleep 700ms
Enter

# --- run phase: web + api + worker + isomorphic boot together ---
# Start moving the cursor while logs are still settling, so the demo never looks frozen.
Sleep 4500ms

# quick tour of package navigation (fast — just showing the cursor move right and back), ending on web
Right
Sleep 400ms
Right
Sleep 400ms
Right
Sleep 400ms
Left
Sleep 400ms
Left
Sleep 400ms
Left
Sleep 800ms

# open web's commands menu, then arrow across to api's commands without leaving the menu
Type "m"
Sleep 1800ms
Right
Sleep 2500ms

# run api's custom command (add-random-todo)
Enter
Sleep 3500ms

# filter the combined log down to the added todos (case- and accent-insensitive)
Type "f"
Sleep 1000ms
Type@150ms "added"
Sleep 800ms
Enter
Sleep 2500ms

# clear the filter (esc), then quit
Escape
Sleep 2000ms
Ctrl+C
Sleep 2500ms
