#!/usr/bin/env bash
# Build Starmap and copy it into the site repo at starmap/, ready to commit there.
# Usage: scripts/copy-to-site.sh [path-to-chasestruse.github.io]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
site="${1:-$here/../chasestruse.github.io}"

if [[ ! -f "$site/index.html" ]]; then
  echo "Site repo not found at $site" >&2
  exit 1
fi

cd "$here"
npm run check
rm -rf "$site/starmap"
cp -R dist "$site/starmap"
echo "Copied dist/ to $site/starmap. Commit it on a branch in the site repo and open a PR."
