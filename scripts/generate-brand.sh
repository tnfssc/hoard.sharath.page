#!/bin/sh
# Development-only dependency: rsvg-convert (librsvg2-bin on Debian/Ubuntu).
set -eu
cd "$(dirname "$0")/.."
for spec in '1024 logo' '256 favicon'; do
  set -- $spec
  rsvg-convert --width "$1" --height "$1" public/logo.svg > "public/$2.png"
done
