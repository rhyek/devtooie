# devtooie demo — records the example monorepo's TUI into the README hero GIF.
#
# Regenerate from this directory (two steps):
#   cd example && vhs demo.tape
#   # then downscale the 2x render to 1x (supersampling -> thinner strokes) and crop the ~1
#   # blank row devtooie leaves below its footer (final 620 -> 596), in place:
#   G=../packages/devtooie/assets/demo.gif
#   ffmpeg -y -i "$G" -vf "scale=iw/2:ih/2:flags=lanczos,crop=1200:596:0:0,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer" "$G.tmp.gif" && mv "$G.tmp.gif" "$G"
#
# Requires vhs + its runtime deps:  brew install vhs ttyd ffmpeg
# The recording drives the real example (Go worker + Vite frontend), so those must
# be runnable here first (a plain `pnpm devtooie` should boot cleanly).

Output ../packages/devtooie/assets/demo.gif

Require pnpm

Set Shell "bash"
Set FontFamily "Menlo"
# Rendered at 2x (FontSize 28 / 2400x1240) and downscaled to 1x on export — supersampling
# thins out macOS's heavy font stem-darkening so the text isn't chunky (VHS has no thin-strokes
# or font-weight setting). Keep FontSize : Width : Height : Padding all 2:1 to the 1x target.
Set FontSize 28
Set Width 2400
Set Height 1240
Set Padding 36
Set TypingSpeed 55ms
# Vibrant palette sampled from the original terminal screenshot (bg #24292E) so the ANSI
# status colors read as punchy as a real terminal rather than washed-out pastel.
Set Theme { "name": "devtooie", "background": "#24292E", "foreground": "#CFD3D7", "black": "#3B4048", "brightBlack": "#6D6D98", "red": "#DF6974", "brightRed": "#F97583", "green": "#36CB61", "brightGreen": "#56D364", "yellow": "#E5C07B", "brightYellow": "#FFC777", "blue": "#4E9CCD", "brightBlue": "#79C0FF", "magenta": "#9B72E3", "brightMagenta": "#C8A2FF", "cyan": "#4EC9D3", "brightCyan": "#56D4DD", "white": "#CFD3D7", "brightWhite": "#FFFFFF", "cursor": "#CFD3D7", "selection": "#3A6A9E" }

# --- hidden setup: clean prompt + fresh selection so the selector shows ---
Hide
Type "export PS1='$ '" Enter
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

# focus the api package: all the way right, then back two
Right
Sleep 550ms
Right
Sleep 550ms
Right
Sleep 550ms
Left
Sleep 550ms
Left
Sleep 900ms

# restart it
Type "r"
Sleep 3500ms

# run its custom command (add-random-todo) from the commands menu
Type "m"
Sleep 1500ms
Enter
Sleep 3500ms

# filter the combined log down to the added todos (case- and accent-insensitive)
Type "f"
Sleep 1000ms
Type "added"
Sleep 800ms
Enter
Sleep 2500ms

# clear the filter (esc), then quit
Escape
Sleep 2000ms
Ctrl+C
Sleep 2500ms
