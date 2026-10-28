#!/usr/bin/env bash
# Publica una versión BETA: el index.html de la rama beta carga los scripts
# desde una etiqueta (tag) fija, así githack nunca mezcla archivos de dos
# versiones (cachea cada URL unos minutos e ignora el ?v=).
#   dev/release-beta.sh 3.26.2-beta "mensaje"
# OJO al pasar a la versión normal (main): el index.html de main usa rutas
# relativas (GitHub Pages); no copiar el de beta.
set -euo pipefail
VER="$1"; MSG="${2:-BETA $1}"
TAG="beta-${VER%-beta}"
BASE="https://raw.githack.com/apicesetti/geotab-insights-v3/${TAG}/static/"
cd "$(dirname "$0")/.."
python3 - "$VER" "$BASE" <<'PY'
import re, sys
ver, base = sys.argv[1], sys.argv[2]
p = "static/index.html"
s = open(p).read()
def fix(m):
    attr, url = m.group(1), m.group(2)
    url = re.sub(r"^https://raw\.githack\.com/[^/]+/[^/]+/[^/]+/static/", "", url)  # quitar base anterior
    url = re.sub(r"\?v=[^\"']*", "", url)
    if url.startswith("vendor/"): return '%s="%s%s"' % (attr, base, url)
    return '%s="%s%s?v=%s"' % (attr, base, url, ver)
s = re.sub(r'(src|href)="((?:https://raw\.githack\.com/[^"]+/static/)?(?:js|vendor)/[^"]+|(?:https://raw\.githack\.com/[^"]+/static/)?style\.css[^"]*)"', fix, s)
open(p, "w").write(s)
PY
git add -A
git commit -qm "$MSG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GomakazPAm89dtzonqWZwj"
git tag -f "$TAG"
git push -q origin beta
git push -q -f origin "$TAG"
git push -q origin beta:exposicion
echo "publicado $VER ($TAG)"
