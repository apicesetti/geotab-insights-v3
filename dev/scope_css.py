"""Acota todos los selectores de un CSS al contenedor del add-in (#gi3-root).

MyGeotab inserta el add-in dentro de su propia página (sin iframe), así que
cualquier selector global (body, main, button...) le cambiaría el layout.
Uso: python3 dev/scope_css.py static/style.src.css static/style.css
En el fuente, ":root" y "body" se convierten en el propio contenedor.
"""
import re
import sys

P = "#gi3-root"


def prefix_sel(sel):
    out = []
    for s in sel.split(","):
        s = s.strip()
        if not s:
            continue
        if s in (":root", "body"):
            out.append(P)
        elif s.startswith(P):
            out.append(s)
        else:
            out.append(P + " " + s)
    return ", ".join(out)


def scope(src):
    res, stack, pos = [], [], 0
    for m in re.finditer(r"([^{}]+)\{|\}", src):
        res.append(src[pos:m.start()])
        if m.group(0) == "}":
            res.append("}")
            if stack:
                stack.pop()
        else:
            sel = m.group(1)
            lead = sel[: len(sel) - len(sel.lstrip())]
            s = sel.strip()
            cm = re.match(r"((?:/\*.*?\*/\s*)*)(.*)", s, re.S)
            comments, s = cm.group(1), cm.group(2)
            if s.startswith("@"):
                res.append(lead + comments + s + " {")
                stack.append("kf" if s.startswith("@keyframes") else "at")
            elif stack and stack[-1] == "kf":
                res.append(lead + comments + s + " {")
                stack.append("x")
            else:
                res.append(lead + comments + prefix_sel(s) + " {")
                stack.append("r")
        pos = m.end()
    res.append(src[pos:])
    return "".join(res)


if __name__ == "__main__":
    src = open(sys.argv[1], encoding="utf-8").read()
    open(sys.argv[2], "w", encoding="utf-8").write(scope(src))
