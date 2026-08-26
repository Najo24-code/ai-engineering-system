/**
 * Pruebas del orquestador, la parte que no llama a ningún modelo.
 *
 * Que sea toda determinista no es una comodidad: es el gate G5.2 en su forma
 * fuerte. Si «ATLAS no puede saltarse la verificación» dependiera de una corrida
 * para comprobarse, sería una afirmación sobre lo que hizo *esa* vez. Como es una
 * propiedad de la forma de las rutas, se comprueba entera y siempre.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { ETAPA, RUTAS, MAX_VUELTAS, etapasQueEscriben, problemasDeRuta, problemasDeTodas } from "./rutas.mjs"
import { CLASES, leerClase, decidir, renglonDeBitacora, explicarCorte } from "./decidir.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const contrato = (id) => JSON.parse(readFileSync(join(ROOT, "agents", id, "agent.json"), "utf8"))
const CONTRATOS = Object.fromEntries(["recon", "build", "review", "probe"].map((id) => [id, contrato(id)]))

// ── quién escribe sale de los contratos, no de una lista a mano ────────────

test("quién escribe se deriva de los contratos reales", () => {
  // Si esto se declarara aparte, se desincronizaría el primer día que alguien
  // cambiara un contrato. Este repositorio ya se comió esa lección dos veces.
  assert.deepEqual(etapasQueEscriben(CONTRATOS).sort(), ["build"])
})

test("un agente nuevo que escriba entra solo en la regla", () => {
  const conOtro = { ...CONTRATOS, migrador: { scope: { write: ["migrations/**"] } } }
  assert.deepEqual(etapasQueEscriben(conOtro).sort(), ["build", "migrador"])
})

// ── G5.2 · ninguna ruta puede saltarse la verificación ────────────────────

test("las rutas declaradas son todas válidas", () => {
  assert.deepEqual(problemasDeTodas(RUTAS, CONTRATOS), [])
})

test("una ruta que escribe y no verifica se rechaza al cargar, no al correr", () => {
  // Descubrirlo a mitad de corrida ya gastó llamadas y dejó el árbol tocado.
  const mala = { porque: "x", etapas: [ETAPA.RECON, ETAPA.BUILD, ETAPA.ALTO] }
  const p = problemasDeRuta("atajo", mala, CONTRATOS)
  assert.equal(p.length, 1)
  assert.match(p[0], /llega al final sin verificador/)
})

test("verificar ANTES de escribir no cuenta como verificar", () => {
  // El orden es lo que hace la comprobación. Medir y luego escribir deja el
  // cambio sin medir, con un veredicto en disco que parece que lo cubre.
  const mala = { porque: "x", etapas: [ETAPA.VERIFICADOR, ETAPA.BUILD, ETAPA.ALTO] }
  assert.match(problemasDeRuta("invertida", mala, CONTRATOS)[0], /sin verificador/)
})

test("el verificador no tiene que ir pegado a BUILD, sólo después", () => {
  // Un control positivo: exigir que fuera la etapa inmediatamente siguiente
  // prohibiría rutas legítimas y se acabaría desactivando.
  const buena = { porque: "x", etapas: [ETAPA.BUILD, ETAPA.RECON, ETAPA.VERIFICADOR, ETAPA.ALTO] }
  assert.deepEqual(problemasDeRuta("holgada", buena, CONTRATOS), [])
})

test("una ruta que no escribe no necesita verificador", () => {
  assert.deepEqual(problemasDeRuta("mirar", { porque: "x", etapas: [ETAPA.RECON, ETAPA.ALTO] }, CONTRATOS), [])
})

test("ninguna ruta declarada publica: eso sigue siendo de una persona", () => {
  for (const [nombre, r] of Object.entries(RUTAS)) {
    assert.ok(!r.etapas.includes("publicar"), `${nombre} publica`)
    assert.equal(r.etapas.at(-1), ETAPA.ALTO, `${nombre} no entrega a una persona`)
  }
})

// ── el resto de la forma de una ruta ──────────────────────────────────────

test("una ruta sin alto no entrega: sigue", () => {
  assert.match(problemasDeRuta("infinita", { porque: "x", etapas: [ETAPA.RECON] }, CONTRATOS)[0], /no termina en alto/)
})

test("una etapa inventada se caza", () => {
  const p = problemasDeRuta("rara", { porque: "x", etapas: ["desplegar", ETAPA.ALTO] }, CONTRATOS)
  assert.ok(p.some((x) => /no existen: desplegar/.test(x)))
})

test("reintentar sin nada que rehacer no tiene sentido y se dice", () => {
  const p = problemasDeRuta("mirar", { porque: "x", etapas: [ETAPA.RECON, ETAPA.ALTO], reintenta: true }, CONTRATOS)
  assert.ok(p.some((x) => /no hay qué corregir/.test(x)))
})

test("una ruta sin porqué no se puede auditar", () => {
  const p = problemasDeRuta("muda", { etapas: [ETAPA.RECON, ETAPA.ALTO] }, CONTRATOS)
  assert.ok(p.some((x) => /no dice por qué/.test(x)))
})

test("una ruta vacía se dice en una línea, sin cascada de quejas", () => {
  assert.deepEqual(problemasDeRuta("nada", { porque: "x", etapas: [] }, CONTRATOS), ['la ruta "nada" no tiene etapas'])
})

// ── G5.4 · el tope duro ───────────────────────────────────────────────────

test("hay un tope de vueltas y es pequeño", () => {
  assert.equal(MAX_VUELTAS, 2)
})

test("agotar las vueltas se explica como decisión, no como avería", () => {
  const t = explicarCorte({ etapa: "vueltas", maxVueltas: MAX_VUELTAS })
  assert.match(t, /a propósito/)
  assert.match(t, /sin publicar/)
})

// ── G5.1 y G5.5 · qué decide el modelo y qué queda escrito ────────────────

test("el modelo elige clase, y sólo entre las que existen", () => {
  assert.equal(leerClase("Clase: implementar"), "implementar")
  assert.equal(leerClase("**Clase**: diagnosticar"), "diagnosticar")
  assert.equal(leerClase("Route: revisar"), "revisar")
})

test("una clase inventada no se acepta ni se aproxima", () => {
  assert.equal(leerClase("Clase: desplegar"), null)
  assert.equal(leerClase("Clase: implementar-rapido"), null)
})

test("mencionar dos clases es ambigüedad, y la ambigüedad no se desempata", () => {
  // Resolverlo por orden de aparición convertiría cada respuesta confusa en una
  // corrida que nadie pidió.
  assert.equal(leerClase("podría ser implementar o diagnosticar"), null)
})

test("una sola mención sin etiqueta sí vale", () => {
  assert.equal(leerClase("esto es claramente diagnosticar y nada más"), "diagnosticar")
})

test("gana la última etiqueta, no la primera", () => {
  // El modelo puede copiar la plantilla arriba y decidir abajo.
  assert.equal(leerClase("Clase: implementar\n…pensándolo mejor…\nClase: revisar"), "revisar")
})

test("sin clase legible se corta hacia una persona, no se elige la más probable", () => {
  const d = decidir({ salidaDelModelo: "no estoy seguro" })
  assert.ok(d.corte)
  assert.equal(d.clase, null)
  assert.deepEqual(d.etapas, [])
  assert.equal(d.quien, "regla")
})

test("la decisión registra quién, por qué y qué se descartó", () => {
  // Sin las alternativas, una decisión siempre parece la única posible.
  const d = decidir({ salidaDelModelo: "Clase: implementar", tarea: "añade multiplica()" })
  assert.equal(d.clase, "implementar")
  assert.deepEqual(d.etapas, RUTAS.implementar.etapas)
  assert.equal(d.quien, "modelo")
  assert.deepEqual(d.descartadas.sort(), CLASES.filter((c) => c !== "implementar").sort())
  assert.ok(d.porque.length > 10)
})

test("el renglón de bitácora lleva la decisión entera y una sola línea de tarea", () => {
  const d = decidir({ salidaDelModelo: "Clase: revisar", tarea: "mira este diff\ncon muchas líneas\ny más" })
  const r = JSON.parse(renglonDeBitacora(d, new Date("2026-08-26T03:00:00Z")))
  assert.equal(r.fecha, "2026-08-26T03:00:00.000Z")
  assert.equal(r.clase, "revisar")
  assert.equal(r.quien, "modelo")
  assert.equal(r.tarea, "mira este diff")
  assert.ok(Array.isArray(r.descartadas))
})

// ── G5.3 · un fallo detiene ───────────────────────────────────────────────

test("un corte dice en qué etapa fue y por qué no se sigue", () => {
  const t = explicarCorte({ etapa: "build", motivo: "el gate le negó toda escritura", vuelta: 1 })
  assert.match(t, /Se detuvo en "build"/)
  assert.match(t, /negó toda escritura/)
  assert.match(t, /produce evidencia que parece buena y no lo es/)
})
