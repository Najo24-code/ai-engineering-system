/**
 * Las pruebas del relevo.
 *
 * La que manda es **"sin cuota se para, no se degrada"**. Todas las demás
 * comprueban que el relevo encuentra por dónde seguir; esa comprueba que
 * **prefiere pararse antes que seguir con un modelo que no cabe**, que es la
 * única propiedad que impide convertir un bloqueo ruidoso —y por tanto visible—
 * en un agente que sigue trabajando mal en silencio.
 *
 * Cuestan cero: ni una llamada al proveedor. El sondeo entra por parámetro.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { opcionesPara, elegir, firma, DESCARTE } from "./relevo.mjs"

const AQUI = dirname(fileURLToPath(import.meta.url))
const CATALOGO_REAL = JSON.parse(readFileSync(join(AQUI, "catalogo.json"), "utf8"))

/** Contrato de REVIEW, tal como lo declara agents/review/agent.json. */
const REVIEW = { requires: ["tool_calling"], min_context: 200000 }

const catalogo = {
  proveedores: {
    alfa: { credencial: "ALFA_KEY", endpoint: "https://alfa/x" },
    beta: { credencial: "BETA_KEY", endpoint: "https://beta/x" },
    local: { credencial: null, endpoint: "http://localhost/x" },
  },
  modelos: {
    grande: [
      { proveedor: "alfa", id: "a-grande", contexto: 1000000, tool_calling: true },
      { proveedor: "beta", id: "b-grande", contexto: 500000, tool_calling: true },
    ],
    mixto: [
      { proveedor: "alfa", id: "a-corto", contexto: 32000, tool_calling: true },
      { proveedor: "local", id: "l-sin-tools", contexto: 1000000, tool_calling: false },
      { proveedor: "beta", id: "b-ok", contexto: 262144, tool_calling: true },
    ],
    solo_cortos: [
      { proveedor: "alfa", id: "a-corto", contexto: 32000, tool_calling: true },
      { proveedor: "local", id: "l-corto", contexto: 32000, tool_calling: true },
    ],
  },
}

const hay = { estado: "DISPONIBLE", detalle: "hay cuota" }
const nada = { estado: "AGOTADA", detalle: "no queda cuota" }
const nose = { estado: "INDETERMINADA", detalle: "sin red" }
const rechazada = { estado: "INSERVIBLE", detalle: "404: el modelo ya no se sirve" }

const env = { ALFA_KEY: "k1", BETA_KEY: "k2" }
const sondeoFijo = (por) => async ({ proveedor }) => por[proveedor] ?? hay

// ── el filtro del contrato ───────────────────────────────────────────────────

test("el contrato descarta lo que no cabe, y dice por qué", () => {
  const { aptas, descartadas } = opcionesPara(catalogo, "mixto", REVIEW)
  assert.deepEqual(aptas.map((o) => o.id), ["b-ok"])
  assert.equal(descartadas.length, 2)
  assert.match(descartadas[0].detalle, /contexto/)
  assert.match(descartadas[1].detalle, /sin tool calling/)
})

// ── la que manda ─────────────────────────────────────────────────────────────

test("sin cuota se para; NO baja el listón del contrato", async () => {
  // alfa tiene cuota, pero su modelo no cabe. La tentación es usarlo "porque es
  // el único encendido": eso cambia un bloqueo visible por un agente que opina
  // sobre el resumen sin que nadie se entere.
  const r = await elegir({
    catalogo,
    idNeutral: "solo_cortos",
    requisitos: REVIEW,
    env,
    sondear: sondeoFijo({}),
  })
  assert.equal(r.elegida, null)
  assert.match(r.motivo, /ninguna opción .* cumple el contrato/)
  assert.ok(r.bitacora.every((b) => b.motivo === DESCARTE.CONTRATO))
})

test("cuando el contrato descarta todo, ni siquiera se pregunta por la cuota", async () => {
  // Preguntar gastaría una petición para enterarse de algo que ya se sabía.
  let pregunto = false
  await elegir({
    catalogo,
    idNeutral: "solo_cortos",
    requisitos: REVIEW,
    env,
    sondear: async () => {
      pregunto = true
      return hay
    },
  })
  assert.equal(pregunto, false)
})

// ── el relevo propiamente dicho ──────────────────────────────────────────────

test("si el primero se queda sin cuota, releva al siguiente", async () => {
  const r = await elegir({
    catalogo,
    idNeutral: "grande",
    requisitos: REVIEW,
    env,
    sondear: sondeoFijo({ alfa: nada }),
  })
  assert.equal(firma(r.elegida), "beta/b-grande")
  assert.equal(r.bitacora[0].motivo, DESCARTE.SIN_CUOTA)
})

test("una opción sin credencial se salta, no rompe el relevo", async () => {
  const r = await elegir({
    catalogo,
    idNeutral: "grande",
    requisitos: REVIEW,
    env: { BETA_KEY: "k2" },
    sondear: sondeoFijo({}),
  })
  assert.equal(firma(r.elegida), "beta/b-grande")
  assert.equal(r.bitacora[0].motivo, DESCARTE.SIN_CREDENCIAL)
  assert.match(r.bitacora[0].detalle, /ALFA_KEY/)
})

test("la cuota se pregunta una vez por proveedor, no una por modelo", async () => {
  // El tope de OpenRouter es de cuenta: sondear cada modelo gastaría una
  // petición por modelo para enterarse tres veces de lo mismo.
  const catalogoRepetido = {
    ...catalogo,
    modelos: {
      repes: [
        { proveedor: "alfa", id: "a-1", contexto: 1000000, tool_calling: true },
        { proveedor: "alfa", id: "a-2", contexto: 1000000, tool_calling: true },
        { proveedor: "beta", id: "b-1", contexto: 1000000, tool_calling: true },
      ],
    },
  }
  const vistos = []
  await elegir({
    catalogo: catalogoRepetido,
    idNeutral: "repes",
    requisitos: REVIEW,
    env,
    sondear: async ({ proveedor }) => {
      vistos.push(proveedor)
      return nada
    },
  })
  assert.deepEqual(vistos, ["alfa", "beta"])
})

test("una opción que el proveedor rechaza se salta y se sigue bajando la escalera", async () => {
  // Es la diferencia con la duda. Ante un "no sé" se intenta, porque intentarlo
  // es la forma de averiguarlo. Ante un "no" ya no queda nada que averiguar:
  // elegirla gastaría la corrida en algo que se sabe que falla y —peor— dejaría
  // sin mirar las opciones que vienen detrás.
  const r = await elegir({
    catalogo,
    idNeutral: "grande",
    requisitos: REVIEW,
    env,
    sondear: sondeoFijo({ alfa: rechazada }),
  })
  assert.equal(firma(r.elegida), "beta/b-grande")
  const saltada = r.bitacora.find((b) => b.modelo === "a-grande")
  assert.equal(saltada.motivo, DESCARTE.INSERVIBLE)
  assert.match(saltada.detalle, /404/)
})

test("el rechazo de un modelo no condena al siguiente del mismo proveedor", async () => {
  // La caché de sondeos estaba puesta por PROVEEDOR, porque el tope de cuota es
  // de cuenta. En cuanto una respuesta habla del modelo y no de la cuenta, esa
  // clave miente: el 404 de `a-1` apagaba a `a-2`, que podía estar vivo.
  const dosDelMismo = {
    ...catalogo,
    modelos: {
      repes: [
        { proveedor: "alfa", id: "a-1", contexto: 1000000, tool_calling: true },
        { proveedor: "alfa", id: "a-2", contexto: 1000000, tool_calling: true },
      ],
    },
  }
  const preguntados = []
  const r = await elegir({
    catalogo: dosDelMismo,
    idNeutral: "repes",
    requisitos: REVIEW,
    env,
    sondear: async ({ modelo }) => {
      preguntados.push(modelo)
      return modelo === "a-1" ? rechazada : hay
    },
  })
  assert.deepEqual(preguntados, ["a-1", "a-2"])
  assert.equal(firma(r.elegida), "alfa/a-2")
})

test("a un proveedor cuya llave tiene el runtime no se le sondea la cuota", async () => {
  // opencode-zen guarda su credencial en el almacén de opencode, no en el
  // entorno. Sondearlo por HTTP con la llave que el relevo ve —que no existe—
  // devolvía "no hay credencial en el entorno": describía como una falta lo que
  // es otra forma de guardar la llave.
  const conLocal = {
    ...catalogo,
    modelos: { suyo: [{ proveedor: "local", id: "l-grande", contexto: 1000000, tool_calling: true }] },
  }
  let sondeos = 0
  const r = await elegir({
    catalogo: conLocal,
    idNeutral: "suyo",
    requisitos: REVIEW,
    env,
    sondear: async () => {
      sondeos++
      return hay
    },
  })
  assert.equal(sondeos, 0)
  assert.equal(firma(r.elegida), "local/l-grande")
  assert.match(r.bitacora.at(-1).motivo, /no sondeable/)
})

test("la duda no cierra la puerta: se intenta y que lo diga la corrida", async () => {
  const r = await elegir({
    catalogo,
    idNeutral: "grande",
    requisitos: REVIEW,
    env,
    sondear: sondeoFijo({ alfa: nose }),
  })
  assert.equal(firma(r.elegida), "alfa/a-grande")
  assert.match(r.bitacora.at(-1).motivo, /cuota desconocida/)
})

test("si nadie tiene cuota, se para y lo dice", async () => {
  const r = await elegir({
    catalogo,
    idNeutral: "grande",
    requisitos: REVIEW,
    env,
    sondear: sondeoFijo({ alfa: nada, beta: nada }),
  })
  assert.equal(r.elegida, null)
  // "no disponible" y "no cumple el contrato" son paradas distintas y no deben
  // confundirse: la primera se arregla esperando, la segunda no se arregla.
  assert.match(r.motivo, /está disponible ahora mismo/)
  assert.doesNotMatch(r.motivo, /contrato/)
  assert.ok(r.bitacora.every((b) => b.motivo === DESCARTE.SIN_CUOTA))
})

test("un id que no está en el catálogo no se inventa", async () => {
  const r = await elegir({ catalogo, idNeutral: "fantasma", requisitos: REVIEW, env, sondear: sondeoFijo({}) })
  assert.equal(r.elegida, null)
  assert.match(r.motivo, /no está en el catálogo/)
})

// ── la bitácora ──────────────────────────────────────────────────────────────

test("la elección deja escrito qué se usó y qué se saltó", async () => {
  // Dos dictámenes de modelos distintos no son comparables. Un relevo que no
  // dejara rastro fabricaría una serie con aspecto de comparable.
  const r = await elegir({
    catalogo,
    idNeutral: "mixto",
    requisitos: REVIEW,
    env,
    sondear: sondeoFijo({}),
  })
  assert.equal(firma(r.elegida), "beta/b-ok")
  assert.equal(r.bitacora.filter((b) => b.resultado === "descartada").length, 2)
  assert.equal(r.bitacora.filter((b) => b.resultado === "elegida").length, 1)
})

// ── contra el catálogo de verdad ─────────────────────────────────────────────

test("el catálogo real ofrece a REVIEW al menos una opción que cumple su contrato", () => {
  const { aptas } = opcionesPara(CATALOGO_REAL, "nemotron-3-ultra", REVIEW)
  assert.ok(aptas.length >= 1, "REVIEW se quedaría sin con qué correr")
  assert.ok(aptas.every((o) => o.contexto >= 200000 && o.tool_calling))
})

test("el catálogo real no promete como verificado lo que nadie ha corrido", () => {
  // Un DECLARADO se puede intentar, pero no puede aparecer en una auditoría
  // como capacidad del sistema. Es la misma regla que gobierna las fronteras.
  for (const opciones of Object.values(CATALOGO_REAL.modelos)) {
    if (!Array.isArray(opciones)) continue
    for (const o of opciones) {
      assert.ok(["VERIFICADO", "DECLARADO"].includes(o.estado), `${o.id} sin estado declarado`)
    }
  }
  const verificados = Object.values(CATALOGO_REAL.modelos)
    .filter(Array.isArray)
    .flat()
    .filter((o) => o.estado === "VERIFICADO")
  assert.ok(
    verificados.every((o) => o.proveedor === "openrouter"),
    "solo OpenRouter ha corrido agentes de verdad; marcar otro como VERIFICADO exige la corrida",
  )
})
