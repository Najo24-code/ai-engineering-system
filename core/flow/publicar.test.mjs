/**
 * Pruebas de la salida a pull request.
 *
 * Las cinco negativas son lo único que separa «un ciclo que verifica» de «un
 * ciclo que verifica y luego publica lo que sea». Cada una tiene aquí su caso
 * que la dispara y su control positivo que demuestra que no está diciendo que no
 * a todo: una compuerta que niega siempre pasa por segura y no lo es, porque el
 * día que estorba se desactiva entera.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { motivosParaNoPublicar, cuerpoDelPR, mensajeDeCommit } from "./publicar.mjs"
import { compararHuellas, explicarDeriva } from "../verification/huella.mjs"

const medidoOK = {
  resultado: "APROBADO",
  motivos: [],
  base: "HEAD",
  controles: [
    { control: "suite", aprueba: true, medido: { pasaron: 49, fallaron: 0 } },
    { control: "alcance", aprueba: true, detalle: null },
    { control: "secretos", aprueba: true, detalle: null },
  ],
}
const dictamenOK = { aceptado: true, revisor: { veredicto: "APPROVED", defectos_bloqueantes: 0 }, citas_rotas: [], incoherencias: [] }
const sinDeriva = { iguales: true, aparecieron: [], desaparecieron: [], cambiaron: [] }
const archivos = ["server/detectores.py", "server/test_detectores.py"]

const publicable = { dictamen: dictamenOK, medido: medidoOK, deriva: sinDeriva, archivos }

// ── el control positivo, primero ───────────────────────────────────────────

test("un ciclo entero en verde sí se publica", () => {
  assert.deepEqual(motivosParaNoPublicar(publicable), [])
})

// ── 1. sin dictamen no se publica ──────────────────────────────────────────

test("sin dictamen no se publica: el sello es lo que hace que el revisor mire menos", () => {
  const motivos = motivosParaNoPublicar({ ...publicable, dictamen: null })
  assert.ok(motivos.some((m) => /nadie revisó/.test(m)))
})

test("un dictamen sin veredicto legible no aprueba nada", () => {
  const motivos = motivosParaNoPublicar({ ...publicable, dictamen: { aceptado: true, revisor: { veredicto: null } } })
  assert.ok(motivos.some((m) => /veredicto legible/.test(m)))
})

// ── 2. un dictamen descartado no aprueba ───────────────────────────────────

test("si REVIEW inventó una cita, su APPROVED no vale", () => {
  const motivos = motivosParaNoPublicar({
    ...publicable,
    dictamen: { ...dictamenOK, aceptado: false, citas_rotas: [{ cita: "server/app.py:900" }] },
  })
  assert.ok(motivos.some((m) => /descartado/.test(m) && /server\/app\.py:900/.test(m)))
})

test("REVIEW rechazando devuelve el motivo con el número de defectos", () => {
  const motivos = motivosParaNoPublicar({
    ...publicable,
    dictamen: { ...dictamenOK, revisor: { veredicto: "REJECTED", defectos_bloqueantes: 2 } },
  })
  assert.ok(motivos.some((m) => /rechazó/.test(m) && /2/.test(m)))
})

// ── 3. el verificador manda sobre el revisor ───────────────────────────────

test("APPROVED de REVIEW no salva un RECHAZADO medido", () => {
  // El desacuerdo entre un juicio y una medición lo resuelve la medición,
  // siempre. Es la razón entera de que exista la Fase 3.
  const motivos = motivosParaNoPublicar({
    ...publicable,
    medido: { ...medidoOK, resultado: "RECHAZADO", motivos: ["suite: el informe dice 49 y la medición dice 45"] },
  })
  assert.equal(motivos.length, 1)
  assert.match(motivos[0], /midió RECHAZADO/)
  assert.match(motivos[0], /45/)
})

test("sin veredicto medido no hay nada que publicar", () => {
  assert.ok(motivosParaNoPublicar({ ...publicable, medido: null }).some((m) => /no hay medición/.test(m)))
})

// ── 4. el árbol tiene que ser el que se midió ──────────────────────────────

test("un archivo que cambió de contenido después de medir frena la publicación", () => {
  const deriva = compararHuellas({ "server/detectores.py": "aaa" }, { "server/detectores.py": "bbb" })
  const motivos = motivosParaNoPublicar({ ...publicable, deriva })
  assert.ok(motivos.some((m) => /no es lo que se verificó/.test(m) && /detectores\.py/.test(m)))
})

test("un archivo que apareció después de medir también la frena", () => {
  // Este es el que un control basado solo en el diff no ve: `git diff` no
  // enseña los archivos sin seguir, y un test nuevo es lo más normal del mundo.
  const deriva = compararHuellas({ "server/a.py": "aaa" }, { "server/a.py": "aaa", "server/nuevo_test.py": "ccc" })
  assert.ok(motivosParaNoPublicar({ ...publicable, deriva }).some((m) => /sin verificar/.test(m)))
})

test("una corrida sin huella no se publica a ciegas", () => {
  const motivos = motivosParaNoPublicar({ ...publicable, deriva: { iguales: false, sinSello: true } })
  assert.equal(motivos.length, 1)
  assert.match(motivos[0], /no guardó la huella/)
})

test("un árbol vacío no se publica", () => {
  assert.ok(motivosParaNoPublicar({ ...publicable, archivos: [] }).some((m) => /nada que publicar/.test(m)))
})

test("los motivos vienen todos juntos, no de uno en uno", () => {
  const motivos = motivosParaNoPublicar({
    dictamen: null,
    medido: { ...medidoOK, resultado: "RECHAZADO", motivos: ["alcance: fuera"] },
    deriva: compararHuellas({ "a.py": "1" }, { "a.py": "2" }),
    archivos: ["a.py"],
  })
  assert.equal(motivos.length, 3, "quien va a publicar necesita ver todo lo que le falta de golpe")
})

// ── qué dice el PR ─────────────────────────────────────────────────────────

const issue = { number: 7, title: "El detector no avisa cuando un host deja de reportar" }

test("el PR cierra el issue del que salió", () => {
  const cuerpo = cuerpoDelPR({ issue, tarea: "x", corrida: "runs/2026-08-25T20-35-51", medido: medidoOK, dictamen: dictamenOK, archivos })
  assert.match(cuerpo, /^Closes #7/)
})

test("el PR lleva la medición, no una promesa de que todo está bien", () => {
  const cuerpo = cuerpoDelPR({ issue, tarea: "x", corrida: "runs/x", medido: medidoOK, dictamen: dictamenOK, archivos })
  assert.match(cuerpo, /49 en verde, 0 en rojo/)
  for (const c of medidoOK.controles) assert.ok(cuerpo.includes(c.control), `falta el control ${c.control}`)
  for (const a of archivos) assert.ok(cuerpo.includes(a), `falta el archivo ${a}`)
})

test("el PR dice que salió de un ciclo automático", () => {
  // Esconderlo le quita al revisor el dato que más cambia cómo lee el diff.
  const cuerpo = cuerpoDelPR({ issue, tarea: "x", corrida: "runs/x", medido: medidoOK, dictamen: dictamenOK, archivos })
  assert.match(cuerpo, /RECON → BUILD → REVIEW/)
  assert.match(cuerpo, /runs\/x/)
})

test("el PR no promete que el cambio valga la pena", () => {
  const cuerpo = cuerpoDelPR({ issue, tarea: "x", corrida: "runs/x", medido: medidoOK, dictamen: dictamenOK, archivos })
  assert.match(cuerpo, /no comprueba que valga la pena/)
})

test("sin issue el PR sigue teniendo cuerpo, pero no finge cerrar nada", () => {
  const cuerpo = cuerpoDelPR({ issue: null, tarea: "arregla el filtro\ny sus pruebas", corrida: "runs/x", medido: medidoOK, dictamen: dictamenOK, archivos })
  assert.ok(!cuerpo.includes("Closes #"))
  assert.match(cuerpo, /arregla el filtro/)
})

// ── qué dice el commit ─────────────────────────────────────────────────────

test("el commit nombra el issue y la corrida donde está la evidencia", () => {
  const m = mensajeDeCommit({ issue, tarea: "x", corrida: "runs/2026-08-25T20-35-51", medido: medidoOK })
  assert.equal(m.split("\n")[0], issue.title)
  assert.match(m, /Resuelve el issue #7/)
  assert.match(m, /49 pruebas en verde/)
  assert.match(m, /runs\/2026-08-25T20-35-51/)
})

test("el commit no lleva firma de ninguna herramienta", () => {
  const m = mensajeDeCommit({ issue, tarea: "x", corrida: "runs/x", medido: medidoOK })
  assert.ok(!/Co-Authored-By/i.test(m))
  assert.ok(!/Generated with/i.test(m))
})

// ── la deriva, dicha para una persona ──────────────────────────────────────

test("la deriva se explica separando qué clase de movimiento fue", () => {
  const d = compararHuellas({ a: "1", b: "1", c: "1" }, { a: "2", b: "1", d: "1" })
  assert.deepEqual(d.cambiaron, ["a"])
  assert.deepEqual(d.desaparecieron, ["c"])
  assert.deepEqual(d.aparecieron, ["d"])
  const texto = explicarDeriva(d)
  assert.match(texto, /cambiaron de contenido: a/)
  assert.match(texto, /aparecieron sin verificar: d/)
  assert.match(texto, /ya no están: c/)
})

test("dos huellas idénticas no son deriva", () => {
  assert.equal(compararHuellas({ a: "1" }, { a: "1" }).iguales, true)
})

// ── 5. nada que ya estuviera sucio antes de que el agente corriera ─────────

test("un archivo que ya estaba tocado antes de empezar no se publica", () => {
  // El caso real del 2026-08-26: el instalador corrió después del último commit
  // y `.opencode/agents/build.md` apareció en el diff como trabajo de BUILD.
  const motivos = motivosParaNoPublicar({ ...publicable, previos: ["server/detectores.py"] })
  assert.equal(motivos.length, 1)
  assert.match(motivos[0], /ya estaban sin commitear/)
  assert.match(motivos[0], /detectores\.py/)
})

test("lo que estaba sucio y el agente NO tocó no estorba", () => {
  // El control positivo: un árbol con trabajo tuyo aparte no puede bloquear una
  // publicación que no lo incluye.
  assert.deepEqual(motivosParaNoPublicar({ ...publicable, previos: ["docs/borrador.md"] }), [])
})

test("sin previos declarados, el control no inventa un bloqueo", () => {
  assert.deepEqual(motivosParaNoPublicar({ ...publicable, previos: [] }), [])
  assert.deepEqual(motivosParaNoPublicar(publicable), [])
})

test("el motivo nombra los archivos, no solo cuántos", () => {
  // Quien lo lea tiene que poder ir a arreglarlo sin volver a investigar.
  const motivos = motivosParaNoPublicar({ ...publicable, previos: archivos })
  assert.match(motivos[0], /server\/detectores\.py/)
  assert.match(motivos[0], /server\/test_detectores\.py/)
})
