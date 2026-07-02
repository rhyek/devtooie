#!/usr/bin/env bash
set -euo pipefail
# Prints the body of the first "## X.Y.Z" section from CHANGELOG.md — i.e. the
# release notes for the top (most recent) version. Used by the release workflow
# to populate a GitHub release's body.
awk '
  /^## [0-9]+\.[0-9]+\.[0-9]+/ { if (seen++) exit; next }
  seen { print }
' CHANGELOG.md
