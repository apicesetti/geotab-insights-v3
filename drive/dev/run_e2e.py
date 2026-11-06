"""Prueba de punta a punta de "Mi jornada" con el API simulado: python drive/dev/run_e2e.py"""
import datetime, pathlib, sys
from playwright.sync_api import sync_playwright

AR = datetime.timezone(datetime.timedelta(hours=-3))
NOW = datetime.datetime.now(AR).replace(hour=14, minute=0, second=0, microsecond=0)
HERE = pathlib.Path(__file__).parent
OUT = HERE / "shots"; OUT.mkdir(exist_ok=True)
errors = []
def check(c, m):
    print(("OK   " if c else "FAIL ") + m)
    if not c: errors.append(m)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 400, "height": 900}, timezone_id="America/Argentina/Buenos_Aires", locale="es-AR")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
    page.on("console", lambda m: m.type == "error" and errors.append("console: %s" % m.text))
    page.clock.install(time=NOW)
    page.add_init_script(path=str(HERE / "mock-api.js"))
    page.goto((HERE.parent / "index.html").as_uri())

    # startup (sin interfaz) → carga datos, sin avisos todavía (cerca del vehículo)
    page.evaluate("""() => new Promise(res => { window.__a = geotab.addin.cesettiMiJornada(); window.__a.startup(window.__api, window.__state, res); })""")
    page.wait_for_function("() => window.GI._mj.view")
    v = page.evaluate("() => { const v = window.GI._mj.view; return { open: !!v.fat.open, items: v.fat.open.progress.items.map(x => [x.key, x.v, x.left]), risk: v.risk.cur.risk, n: v.risk.cur.n } }")
    items = {k: (val, left) for k, val, left in v["items"]}
    check(v["open"], "jornada en curso")
    check(abs(items["span"][0] - 8) < 0.01 and abs(items["span"][1] - 4) < 0.01, "jornada 8 h, quedan 4 h (%s)" % (items["span"],))
    check(abs(items["drive"][0] - 7.3333) < 0.01 and abs(items["drive"][1] - 1.6667) < 0.01, "manejo 7 h 20, quedan 1 h 40 (%s)" % (items["drive"],))
    check(abs(items["stint"][0] - 3.8333) < 0.01, "manejo continuo 3 h 50 (%s)" % (items["stint"],))
    check(v["risk"] is not None and v["n"] > 0, "índice de riesgo calculado (%s, %d eventos)" % (v["risk"], v["n"]))
    notes = page.evaluate("window.__notifications")
    check(any("manejo continuo" in n["title"] for n in notes) and any("manejo" in n["title"] for n in notes), "avisos del 80 %% de manejo y continuo (%d)" % len(notes))
    check(page.evaluate("window.GI._mj.away.status") == "cerca", "teléfono cerca del vehículo")

    # interfaz
    page.evaluate("() => new Promise(res => window.__a.initialize(window.__api, window.__state, res))")
    page.evaluate("() => window.__a.focus(window.__api, window.__state)")
    page.wait_for_timeout(300)
    txt = page.inner_text("#mjDrive").replace("\u00a0", " ")
    check("TE QUEDA" in txt.upper() and "Quedan 4 h" in txt and "Quedan 1 h 40 min" in txt and "Quedan 10 min" in txt, "tarjeta de tiempo restante")
    check("Límites de Insights" in txt, "usa la configuración de Insights")
    check("Juan Pérez" in txt, "nombre del conductor")
    page.screenshot(path=str(OUT / "01-jornada.png"), full_page=True)

    # se aleja 900 m sin desvincularse → avisa a la 2.ª lectura
    page.evaluate("() => { window.__phone = { lat: -38.9504, lon: -68.0478, acc: 20 }; window.__notifications.length = 0; }")
    page.evaluate("() => window.GI._mj.check({ force: true })")
    check(page.evaluate("window.GI._mj.away.status") == "lejos" and not page.evaluate("window.__notifications.length"), "1.ª lectura lejos, sin aviso")
    page.clock.run_for(2 * 60 * 1000 + 1000)
    page.wait_for_timeout(200)
    page.evaluate("() => window.GI._mj.check({ force: true })")
    notes = page.evaluate("window.__notifications")
    check(any("Seguís identificado" in n["title"] for n in notes), "aviso de alejamiento (%s)" % [n["title"] for n in notes])
    check(len(page.evaluate("window.__spoken")) >= 1, "aviso por voz")
    page.evaluate("() => window.GI._mj.render()")
    page.screenshot(path=str(OUT / "02-lejos.png"), full_page=True)

    # relevo: elige a María → mensaje de usuario + desvinculación
    check(page.is_visible("text=Me relevaron") and page.is_visible("text=Me desvinculo"), "botones en la tarjeta del vehículo")
    page.click("text=Me relevaron")
    page.wait_for_selector(".mj-user")
    names = page.eval_on_selector_all(".mj-user", "els => els.map(e => e.textContent)")
    check(names == ["Carlos Ruiz", "María Álvarez"], "lista de relevo: mismo grupo, activos (%s)" % names)
    page.fill("#mj-q", "alva")
    names = page.eval_on_selector_all(".mj-user", "els => els.map(e => e.textContent)")
    check(names == ["María Álvarez"] and page.evaluate("document.activeElement.id") == "mj-q", "búsqueda sin perder el foco")
    page.screenshot(path=str(OUT / "03-relevo.png"), full_page=True)
    page.click("text=María Álvarez")
    page.wait_for_selector(".mj-okm")
    added = page.evaluate("window.__added")
    tm = [a for a in added if a["typeName"] == "TextMessage"]
    dc = [a for a in added if a["typeName"] == "DriverChange"]
    check(len(tm) == 1 and tm[0]["entity"]["recipient"]["id"] == "u2" and tm[0]["entity"]["user"]["id"] == "uMe" and "te entregó Camión 12" in tm[0]["entity"]["messageContent"]["message"], "mensaje a María (%s)" % (tm[0]["entity"]["messageContent"]["message"] if tm else None))
    check(len(dc) == 1 and dc[0]["entity"]["driver"]["id"] == "UnknownDriverId" and dc[0]["entity"]["device"]["id"] == "b1", "desvinculación por DriverChange")
    check("Le avisamos a María Álvarez" in page.inner_text(".mj-okm"), "confirmación en pantalla")
    page.screenshot(path=str(OUT / "04-relevo-ok.png"), full_page=True)

    # se desvincula → ya no avisa
    page.evaluate("() => { window.__notifications.length = 0; }")
    page.clock.run_for(35 * 60 * 1000)
    page.evaluate("() => window.GI._mj.check({ force: true })")
    check(page.evaluate("window.GI._mj.away.status") == "sin_vehiculo" and not any("identificado" in n["title"] for n in page.evaluate("window.__notifications")), "desvinculado: no avisa")

    # sin permiso para desvincularse: mensaje claro
    page.evaluate("() => { window.__vehicle.driver = 'uMe'; window.__denyAdd = true; }")
    page.evaluate("() => window.GI._mj.check({ force: true })")
    page.evaluate("() => window.GI._mj.act('cancel')")
    page.click("text=Me desvinculo")
    page.click("text=Sí, desvincularme")
    page.wait_for_selector("#mj-vehicle .mj-msg")
    check("no tiene permiso" in page.inner_text("#mj-vehicle .mj-msg"), "error de permiso explicado")
    b.close()

if errors:
    print("\n".join(errors)); sys.exit(1)
print("Todo OK")
