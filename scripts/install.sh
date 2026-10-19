#!/usr/bin/env bash
# Install pi2web globally from a Git branch.
#
# Keeps a dedicated clone in a fixed directory, checks out the requested branch
# at its latest remote commit, builds it, packs it, and installs the packed
# tarball globally with npm. Installing the tarball (instead of a Git URL)
# lets the native modules (better-sqlite3, node-pty) run their install scripts,
# which npm 11 otherwise blocks.
#
# Usage:
#   scripts/install.sh [--branch NAME] [--repo URL] [--dir PATH] [--force]
#   curl -fsSL https://raw.githubusercontent.com/sxwxs/pi2web/feat/backend-relay/scripts/install.sh | bash
#
# Environment overrides: PI2WEB_BRANCH, PI2WEB_REPO, PI2WEB_SRC_DIR.
set -euo pipefail

branch="${PI2WEB_BRANCH:-feat/backend-relay}"
repo="${PI2WEB_REPO:-https://github.com/sxwxs/pi2web.git}"
dir="${PI2WEB_SRC_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/pi2web/src}"
force=0
native_scripts="better-sqlite3,node-pty"
min_node="22.19.0"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) branch="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --dir) dir="$2"; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool was not found in PATH." >&2; exit 1; }
done

node_version="$(node --version | sed 's/^v//')"
if [ "$(printf '%s\n%s\n' "$min_node" "$node_version" | sort -V | head -n1)" != "$min_node" ]; then
  echo "pi2web needs Node.js $min_node or later; found $node_version." >&2
  exit 1
fi

echo "pi2web source : $dir"
echo "Repository    : $repo"
echo "Branch        : $branch"

if [ -d "$dir/.git" ]; then
  origin="$(git -C "$dir" remote get-url origin)"
  if [ "$origin" != "$repo" ]; then
    echo "$dir is a clone of $origin, not $repo. Use --dir to pick another directory." >&2
    exit 1
  fi
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then
    if [ "$force" -ne 1 ]; then
      echo "$dir has local changes. Re-run with --force to discard them." >&2
      exit 1
    fi
    echo "Discarding local changes (--force)..."
    git -C "$dir" reset --hard
    git -C "$dir" clean -fdx -e node_modules/
  fi
  echo "Fetching..."
  git -C "$dir" fetch --prune origin
elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
  echo "$dir exists and is not a Git clone. Remove it or use --dir." >&2
  exit 1
else
  mkdir -p "$(dirname "$dir")"
  git clone --no-checkout "$repo" "$dir"
fi

git -C "$dir" rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null \
  || { echo "Branch $branch was not found on $repo." >&2; exit 1; }
git -C "$dir" checkout -B "$branch" "origin/$branch"
commit="$(git -C "$dir" log -1 --format='%h %s')"
echo "Checked out   : $commit"

pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT

cd "$dir"
echo "Installing build dependencies (npm ci)..."
npm ci --no-audit --no-fund
# prepack runs the TypeScript build.
echo "Building and packing..."
npm pack --pack-destination "$pack_dir"
tarball="$(ls "$pack_dir"/pi2web-*.tgz | head -n1)"

echo "Installing globally..."
npm install -g "$tarball" --allow-scripts="$native_scripts" --no-audit --no-fund

(cd "$(npm root -g)/pi2web" && node -e "new (require('better-sqlite3'))(':memory:'); require('node-pty');")

version="$(pi2web --version)"
echo
echo "Installed pi2web $version from $branch ($commit)."
echo "Run the same command again to update to the latest commit on the branch."
