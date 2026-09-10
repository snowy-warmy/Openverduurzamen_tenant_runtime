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
#
# (sep 2026) De pin is een TARBALL-URL geworden:
#   https://github.com/snowy-warmy/Openverduurzamen_tenant_runtime/archive/refs/tags/vX.Y.Z.tar.gz
# Reden: Render's build herschrijft git+https-dependencies naar SSH en faalt
# dan op "Permission denied (publickey)". Met de build-cache erbij leek de
# deploy te slagen terwijl de OUDE runtime bleef draaien (lead-BCC-incident,
# 2 sep 2026). Een tarball-URL installeert keyloos via HTTPS en is cache-proof:
# elke tag is een unieke URL. De sed herkent zowel het oude git+https- als
# het tarball-formaat en herschrijft beide naar de nieuwe tag.

set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version-tag>   e.g. $0 v1.4.2" >&2
  exit 2
fi

TARBALL_URL="https://github.com/snowy-warmy/Openverduurzamen_tenant_runtime/archive/refs/tags/${VERSION}.tar.gz"

TENANTS_FILE="$(dirname "$0")/tenants.txt"
WORKDIR="${WORKDIR:-/tmp/of-fleet}"
mkdir -p "$WORKDIR"

# Make sure the tag exists upstream before propagating it.
if ! git ls-remote --tags origin 2>/dev/null | grep -q "refs/tags/${VERSION}$"; then
  echo "Tag ${VERSION} not found on origin. Push the tag first." >&2
  exit 3
fi

# (10 sep 2026) Extra vangnet, zie de FAILED-samenvatting onderaan: één stukke
# tenant mag de rest niet meeslepen. Met `set -e` brak het script vroeger af op
# de eerste fout, mogelijk met een deel van de fleet al gepusht en de rest niet.

# De tag bestaat, maar bestaat de tarball-URL ook? Tags zijn hoofdlettergevoelig
# (V2.0.4 != v2.0.4) en de pin is een URL — een typefout levert een 404 op die
# pas bij de Render-build zichtbaar wordt, op elke tenant tegelijk.
if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 30 "$TARBALL_URL" || echo 000)"
  if [ "$code" != "200" ]; then
    echo "Tarball ${TARBALL_URL} geeft HTTP ${code} (verwacht 200). Gestopt." >&2
    exit 4
  fi
fi

FAILED=()
UPDATED=()
SKIPPED=()

# Alles voor één tenant. Draait via `if ! update_one ...`, waardoor `set -e`
# hierbinnen niet geldt — vandaar de expliciete `|| return 1` per stap.
update_one() {
  local repo="$1"
  local repo_dir="${WORKDIR}/$(basename "$repo" .git)"

  if [ -d "$repo_dir" ]; then
    git -C "$repo_dir" fetch --quiet || return 1
    git -C "$repo_dir" checkout main --quiet || return 1
    git -C "$repo_dir" pull --ff-only --quiet || return 1
  else
    git clone --quiet "$repo" "$repo_dir" || return 1
    git -C "$repo_dir" checkout main --quiet || return 1
  fi

  # Update the runtime pin. We rely on a sentinel string in package.json:
  # "@openverduurzamen/tenant-runtime": "<waarde>"
  # De waarde mag het oude git+https- of het tarball-formaat hebben — de
  # sed vervangt wat er ook staat door de tarball-URL van deze versie.
  if ! grep -q '"@openverduurzamen/tenant-runtime"' "$repo_dir/package.json"; then
    echo "  ! no tenant-runtime dep in package.json; skipping"
    SKIPPED+=("$repo")
    return 0
  fi

  sed -i.bak -E \
    "s|(\"@openverduurzamen/tenant-runtime\"\s*:\s*\")[^\"]*\"|\1${TARBALL_URL}\"|" \
    "$repo_dir/package.json" || return 1
  rm -f "$repo_dir/package.json.bak"

  # De sed mag package.json niet slopen: ongeldige JSON hier betekent een
  # kapotte npm install op Render.
  if command -v node >/dev/null 2>&1; then
    node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" \
      "$repo_dir/package.json" || {
        echo "  ! package.json is geen geldige JSON na de sed; niet gepusht" >&2
        git -C "$repo_dir" checkout -- package.json
        return 1
      }
  fi

  if git -C "$repo_dir" diff --quiet package.json; then
    echo "  ✓ already on ${VERSION}"
    SKIPPED+=("$repo")
    return 0
  fi

  git -C "$repo_dir" add package.json || return 1
  git -C "$repo_dir" commit -m "chore: bump tenant-runtime to ${VERSION}" --quiet || return 1
  git -C "$repo_dir" push origin main --quiet || return 1
  echo "  ✓ pushed bump to ${VERSION}"
  UPDATED+=("$repo")
  return 0
}

while IFS= read -r repo; do
  [ -z "$repo" ] && continue
  case "$repo" in \#*) continue ;; esac

  echo ""
  echo "=== ${repo} ==="

  if ! update_one "$repo"; then
    echo "  ✗ MISLUKT — overgeslagen, de rest van de fleet gaat door" >&2
    FAILED+=("$repo")
  fi
done < "$TENANTS_FILE"

echo ""
echo "── Samenvatting ────────────────────────────────"
echo "  gebumpt naar ${VERSION}: ${#UPDATED[@]}"
for r in ${UPDATED+"${UPDATED[@]}"}; do echo "     ✓ $r"; done
echo "  al up-to-date/overgeslagen: ${#SKIPPED[@]}"
for r in ${SKIPPED+"${SKIPPED[@]}"}; do echo "     · $r"; done
echo "  mislukt: ${#FAILED[@]}"
for r in ${FAILED+"${FAILED[@]}"}; do echo "     ✗ $r"; done

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo ""
  echo "LET OP: de fleet staat nu op gemengde versies. Los bovenstaande repo's" >&2
  echo "op en draai het script opnieuw — het is idempotent." >&2
  exit 1
fi

echo ""
echo "Done. Render will redeploy each tenant on push."
