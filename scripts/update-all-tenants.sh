#!/usr/bin/env bash
#
# update-all-tenants.sh — push a new tenant-runtime version to every
# tenant repo in the fleet.
#
# Usage:
#   ./scripts/update-all-tenants.sh v1.4.2
#
# What it does, per tenant repo:
#   1. clone (or pull if already present in /tmp/of-fleet/)
#   2. update the @openverduurzamen/tenant-runtime version pin in package.json
#   3. commit "chore: bump tenant-runtime to <version>"
#   4. push to main — triggers Render auto-deploy
#
# The list of tenant repos comes from tenants.txt next to this script.
# Add/remove lines to onboard or offboard.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version-tag>   e.g. $0 v1.4.2" >&2
  exit 2
fi

TENANTS_FILE="$(dirname "$0")/tenants.txt"
WORKDIR="${WORKDIR:-/tmp/of-fleet}"
mkdir -p "$WORKDIR"

# Make sure the tag exists upstream before propagating it.
if ! git ls-remote --tags origin 2>/dev/null | grep -q "refs/tags/${VERSION}$"; then
  echo "Tag ${VERSION} not found on origin. Push the tag first." >&2
  exit 3
fi

while IFS= read -r repo; do
  [ -z "$repo" ] && continue
  case "$repo" in \#*) continue ;; esac

  echo ""
  echo "=== ${repo} ==="
  REPO_DIR="${WORKDIR}/$(basename "$repo")"

  if [ -d "$REPO_DIR" ]; then
    git -C "$REPO_DIR" fetch --quiet
    git -C "$REPO_DIR" checkout main --quiet
    git -C "$REPO_DIR" pull --ff-only --quiet
  else
    git clone --quiet "$repo" "$REPO_DIR"
    git -C "$REPO_DIR" checkout main --quiet
  fi

  # Update the runtime pin. We rely on a sentinel string in package.json:
  # "@openverduurzamen/tenant-runtime": "git+https://github.com/snowy-warmy/Openverduurzamen_tenant_runtime.git#vX.Y.Z"
  if ! grep -q '"@openverduurzamen/tenant-runtime"' "$REPO_DIR/package.json"; then
    echo "  ! no tenant-runtime dep in package.json; skipping"
    continue
  fi

  sed -i.bak -E \
    "s|(\"@openverduurzamen/tenant-runtime\"\s*:\s*\"git\+https://github\.com/snowy-warmy/Openverduurzamen_tenant_runtime\.git#)v[0-9.]+\"|\\1${VERSION}\"|" \
    "$REPO_DIR/package.json"
  rm -f "$REPO_DIR/package.json.bak"

  if git -C "$REPO_DIR" diff --quiet package.json; then
    echo "  ✓ already on ${VERSION}"
    continue
  fi

  git -C "$REPO_DIR" add package.json
  git -C "$REPO_DIR" commit -m "chore: bump tenant-runtime to ${VERSION}" --quiet
  git -C "$REPO_DIR" push origin main --quiet
  echo "  ✓ pushed bump to ${VERSION}"
done < "$TENANTS_FILE"

echo ""
echo "Done. Render will redeploy each tenant on push."
