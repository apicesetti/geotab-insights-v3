"""Add-in unificado (Mi jornada + Horas de trabajo) con dos teléfonos: python drive/dev/run_shell.py

Requiere el repo apicesetti/workinghours clonado al lado (../workinghours), como en GitHub Pages.
Juan (chofer de Camión 12) carga a María de acompañante; María recibe el aviso, ve su jornada como
acompañante en "Mi jornada" y confirma en "Tripulación".
"""
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

def phone(page, login, saved=None):
    """Abre el add-in como otro usuario (otro teléfono): sin caché local, misma base."""
    page.goto((HERE.parent / "index.html").as_uri())
    page.evaluate("""([login, saved]) => new Promise(res => {
        localStorage.clear();
        window.__userName = login;
        if (saved) window.__db.AddInData = JSON.parse(saved);
        const a = geotab.addin.cesettiMiJornada();
        window.__a = a;
        a.startup(window.__api, window.__state, () => a.initialize(window.__api, window.__state, () => { a.focus(window.__api, window.__state); res(); }));
    })""", [login, saved])
    page.wait_for_timeout(2500)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 400, "height": 860}, timezone_id="America/Argentina/Buenos_Aires", locale="es-AR")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
    page.on("console", lambda m: m.type == "error" and errors.append("console: %s" % m.text))
    page.clock.install(time=NOW)
    page.add_init_script(path=str(HERE / "mock-api.js"))

    # 1) Juan: un solo add-in, dos pestañas; falta cargar tripulación → abre en Tripulación
    phone(page, "jp@cesetti.com.ar")
    check(page.locator(".cz-tab").count() == 3, "tres pestañas: Mi jornada, Tripulación y Clientes")
    titles = [n["title"] for n in page.evaluate("window.__notifications")]
    check("¿Quién viaja con vos?" in titles, "aviso de Horas de trabajo desde el mismo add-in (%s)" % titles)
    check(any("manejo" in t.lower() for t in titles), "avisos de límites de Mi jornada")
    check(page.is_visible("#cz-p-tripulacion") and page.inner_text("#cz-badge") == "1", "abre en Tripulación con 1 pendiente")
    check(page.evaluate("document.getElementById('cz-who').textContent") == "Juan Pérez", "nombre en el encabezado")
    page.screenshot(path=str(OUT / "s1-juan-tripulacion.png"), full_page=True)
    page.click("[data-act=crew]")
    page.wait_for_selector(".whd-pick")
    page.check("[data-pick=u2]")
    page.click("[data-act=saveCrew]")
    page.wait_for_timeout(500)
    check("María Álvarez · sin confirmar" in page.inner_text("#whDrive"), "Juan ve que María no confirmó")
    # Clientes: llegada con la posición del teléfono
    page.click(".cz-tab[data-tab=clientes]")
    page.wait_for_selector("[data-act=checkin]")
    page.click("[data-act=checkin]")
    page.wait_for_selector("#whd-search")
    page.wait_for_timeout(200)
    page.fill("#whd-search", "Pampa Energía")
    page.click("[data-act=checkinSave][data-new='1']")
    page.wait_for_timeout(800)
    recs = [e["details"]["rec"] for e in page.evaluate("window.__db.AddInData") if e["details"].get("type")]
    check(any(r["type"] == "visit" and r["client"] == "Pampa Energía" and r["posSource"] == "phone" for r in recs), "llegada guardada desde la pestaña Clientes")
    check(any(r["type"] == "zonereq" for r in recs), "geocerca pedida para el supervisor")
    page.wait_for_selector(".whd-visit")
    check("Pampa Energía" in page.inner_text(".whd-visit >> nth=-1"), "la visita aparece en curso")
    page.screenshot(path=str(OUT / "s1b-juan-clientes.png"), full_page=True)
    page.click(".cz-tab[data-tab=tripulacion]")
    check(page.is_visible("[data-act=crew]"), "volver a Tripulación muestra la tripulación")
    page.click(".cz-tab[data-tab=jornada]")
    check(page.is_visible("#mjDrive .mj-card"), "pestaña Mi jornada")
    saved = page.evaluate("JSON.stringify(window.__db.AddInData)")

    # 2) María: aviso, jornada como acompañante, confirma
    phone(page, "ma@cesetti.com.ar", saved)
    titles = [n["title"] for n in page.evaluate("window.__notifications")]
    check("¿Viajás con Juan Pérez?" in titles, "María recibe el aviso (%s)" % titles)
    check(page.is_visible("#cz-p-tripulacion") and page.is_visible(".whd-card-ask"), "abre en Tripulación con la pregunta")
    page.screenshot(path=str(OUT / "s2-maria-pregunta.png"), full_page=True)
    page.click(".cz-tab[data-tab=jornada]")
    page.wait_for_selector(".mj-ride")
    ride = page.inner_text(".mj-ride")
    check(ride.startswith("Como acompañante de Juan Pérez en Camión 12") and "(sin confirmar)" in ride, "Mi jornada: jornada como acompañante (%s)" % ride)
    items = page.evaluate("Object.fromEntries(window.GI._mj.view.fat.open.progress.items.map(x => [x.key, x.v]))")
    check(abs(items["span"] - 8.0833) < 0.01 and items["drive"] == 0, "cuenta desde que subió (05:55): 8 h 05 de jornada y 0 de manejo (%s)" % items)
    page.screenshot(path=str(OUT / "s3-maria-jornada.png"), full_page=True)
    page.click(".cz-tab[data-tab=tripulacion]")
    page.click("[data-act=ack][data-status=ok]")
    page.wait_for_timeout(500)
    acks = [e for e in page.evaluate("window.__db.AddInData") if e["details"].get("type") == "ack"]
    check(len(acks) == 1 and acks[0]["details"]["rec"]["status"] == "ok", "confirmación guardada")
    page.click("#cz-refresh")
    page.wait_for_timeout(800)
    check(page.is_hidden("#cz-badge"), "sin pendientes")
    page.click(".cz-tab[data-tab=jornada]")
    check("(sin confirmar)" not in page.inner_text(".mj-ride"), "Mi jornada ya no dice sin confirmar")
    b.close()

if errors:
    print("\n".join(errors)); sys.exit(1)
print("Todo OK")
