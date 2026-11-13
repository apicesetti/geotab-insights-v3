#!/usr/bin/env bash
# Publica una versión BETA. githack cachea cada URL unos minutos e ignora el
# ?v=, así que con la rama "beta" el navegador puede mezclar archivos de dos
# versiones. Por eso el index.html de beta carga los scripts desde un COMMIT
# fijo (inmutable): primero se commitea el código, después el index.html que
# apunta a ese commit. (Las etiquetas no se pueden empujar desde este entorno.)
#   dev/release-beta.sh 3.26.3-beta "mensaje"
# OJO al pasar a la versión normal (main): el index.html de main usa rutas
# relativas (GitHub Pages); no copiar el de beta.
set -euo pipefail
VER="$1"; MSG="${2:-BETA $1}"
cd "$(dirname "$0")/.."
TRAILER="

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GomakazPAm89dtzonqWZwj"
git add -A
git diff --cached --quiet || git commit -qm "$MSG$TRAILER"
SHA=$(git rev-parse HEAD)
BASE="https://raw.githack.com/apicesetti/geotab-insights-v3/${SHA}/static/"
python3 - "$VER" "$BASE" <<'PY'
import re, sys
ver, base = sys.argv[1], sys.argv[2]
p = "static/index.html"
s = open(p).read()
def fix(m):
    attr, url = m.group(1), m.group(2)
    url = re.sub(r"^https://raw\.githack\.com/[^/]+/[^/]+/[^/]+/static/", "", url)
    url = re.sub(r"\?v=[^\"']*", "", url)
    if url.startswith("vendor/"): return '%s="%s%s"' % (attr, base, url)
    return '%s="%s%s?v=%s"' % (attr, base, url, ver)
s = re.sub(r'(src|href)="((?:https://raw\.githack\.com/[^"]+/static/)?(?:js|vendor)/[^"]+|(?:https://raw\.githack\.com/[^"]+/static/)?style\.css[^"]*)"', fix, s)
open(p, "w").write(s)
PY
git add static/index.html
git commit -qm "BETA $VER: index.html apunta al commit ${SHA:0:7}$TRAILER"
git push -q origin beta
git push -q origin beta:exposicion
echo "publicado $VER (scripts del commit ${SHA:0:7})"
