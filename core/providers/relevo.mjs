/**
 * El relevo de proveedores.
 *
 * El encargo, dicho por quien lo usa: que el sistema funcione con **cualquier IA
 * que se pueda usar gratis**. La consecuencia de diseño no es "que acepte más
 * proveedores": es que **ninguno sea imprescindible**. Mientras las cuatro fases
 * anteriores salieron todas por OpenRouter, el proyecto no tenía un proveedor
 * preferido; tenía una dependencia, y se notó el día que su tope diario de 50
 * peticiones detuvo dos fases seguidas.
 *
 * ── La regla que gobierna este archivo ──────────────────────────────────────
 *
 * **El relevo no es un descuento sobre el contrato.**
 *
 * Un contrato de agente declara lo que necesita para hacer su trabajo:
 * `tool_calling`, y un `min_context` que REVIEW pone en 200k porque sostiene a la
 * vez el diff, los archivos que el diff toca y el reporte de BUILD. Una opción
 * que no llega a eso NO se usa, ni siquiera como último recurso, ni siquiera si
 * es la única que queda. Sin cuota el sistema se para y lo dice; con un modelo
 * que no cabe, el sistema sigue andando y **empieza a opinar sobre el resumen**,
 * que es un fallo silencioso y por tanto peor.
 *
 * Aquí eso descarta cosas concretas: los modelos locales de esta máquina (4B–8B,
 * ~32k) y proveedores enteros como Groq y Cerebras, que no tienen ni un modelo
 * con herramientas y 200k. No es una preferencia estética; es el contrato
 * haciendo su trabajo, y por eso el motivo de cada descarte queda escrito.
 *
 * ── Por qué hay bitácora ────────────────────────────────────────────────────
 *
 * Cambiar de proveedor cambia el modelo, y un modelo distinto puede dictaminar
 * distinto sobre el mismo diff. Un relevo transparente —que sustituye por debajo
 * sin dejar rastro— fabricaría una serie de resultados no comparables con
 * aspecto de serie comparable. Cada elección deja escrito qué se eligió, qué se
 * saltó y por qué.
 */

/** Motivos de descarte. Son datos, no texto: la auditoría los cuenta. */
export const DESCARTE = {
  CONTRATO: "no cumple el contrato",
  SIN_CREDENCIAL: "no hay credencial en el entorno",
  SIN_CUOTA: "el proveedor no tiene cuota",
  PROVEEDOR_DESCONOCIDO: "el proveedor no está en el catálogo",
  INSERVIBLE: "el proveedor rechaza esta opción",
}

/**
 * Filtra las opciones de un id neutral contra los requisitos del contrato.
 *
 * No decide nada sobre cuotas ni credenciales: solo si la opción **puede** hacer
 * el trabajo. Separarlo importa porque son dos preguntas distintas —«¿sirve?» y
 * «¿está disponible?»— y mezclarlas es lo que lleva a aceptar un modelo que no
 * cabe porque era el único encendido.
 *
 * @param {object} catalogo
 * @param {string} idNeutral       el id que declara el contrato
 * @param {object} requisitos      `{requires: string[], min_context: number}`
 */
export function opcionesPara(catalogo, idNeutral, requisitos = {}) {
  const todas = catalogo.modelos?.[idNeutral]
  if (!todas) return { aptas: [], descartadas: [], desconocido: true }

  const minimo = requisitos.min_context ?? 0
  const exige = requisitos.requires ?? []

  const aptas = []
  const descartadas = []

  for (const opcion of todas) {
    const faltan = []
    if (opcion.contexto < minimo) {
      faltan.push(`contexto ${opcion.contexto.toLocaleString("es")} < ${minimo.toLocaleString("es")} exigidos`)
    }
    if (exige.includes("tool_calling") && !opcion.tool_calling) faltan.push("sin tool calling")

    if (faltan.length) {
      descartadas.push({ opcion, motivo: DESCARTE.CONTRATO, detalle: faltan.join("; ") })
    } else {
      aptas.push(opcion)
    }
  }

  return { aptas, descartadas, desconocido: false }
}

/**
 * Elige con qué correr, recorriendo la escalera en orden.
 *
 * La cuota se pregunta **una vez por proveedor**, no una por opción: el tope de
 * OpenRouter es de cuenta, así que sondear cada uno de sus modelos gastaría una
 * petición por modelo para enterarse tres veces de lo mismo.
 *
 * @param {object}   o
 * @param {object}   o.catalogo
 * @param {string}   o.idNeutral
 * @param {object}   o.requisitos
 * @param {object}   [o.env]        de dónde salen las credenciales
 * @param {Function} o.sondear      `({proveedor, endpoint, apiKey, modelo}) => Promise<{estado}>`
 * @returns {Promise<{elegida: object|null, bitacora: Array, motivo: string}>}
 */
export async function elegir({ catalogo, idNeutral, requisitos = {}, env = process.env, sondear }) {
  const { aptas, descartadas, desconocido } = opcionesPara(catalogo, idNeutral, requisitos)
  const bitacora = descartadas.map((d) => ({
    proveedor: d.opcion.proveedor,
    modelo: d.opcion.id,
    resultado: "descartada",
    motivo: d.motivo,
    detalle: d.detalle,
  }))

  if (desconocido) {
    return { elegida: null, bitacora, motivo: `"${idNeutral}" no está en el catálogo de modelos` }
  }
  if (!aptas.length) {
    // Que ninguna cumpla el contrato NO se resuelve bajando el listón.
    return {
      elegida: null,
      bitacora,
      motivo: `ninguna opción de "${idNeutral}" cumple el contrato (${bitacora.map((b) => b.detalle).join(" · ")})`,
    }
  }

  // La clave lleva el modelo, no solo el proveedor. La cuota es de la cuenta,
  // pero «este modelo no existe» es del modelo: con la clave puesta solo en el
  // proveedor, el 404 de una opción se le aplicaba a la siguiente del mismo
  // proveedor, que podía estar perfectamente viva.
  const sondeos = new Map()

  for (const opcion of aptas) {
    const proveedor = catalogo.proveedores?.[opcion.proveedor]
    if (!proveedor) {
      bitacora.push({
        proveedor: opcion.proveedor,
        modelo: opcion.id,
        resultado: "saltada",
        motivo: DESCARTE.PROVEEDOR_DESCONOCIDO,
      })
      continue
    }

    const apiKey = proveedor.credencial ? env[proveedor.credencial] : null
    if (proveedor.credencial && !apiKey) {
      bitacora.push({
        proveedor: opcion.proveedor,
        modelo: opcion.id,
        resultado: "saltada",
        motivo: DESCARTE.SIN_CREDENCIAL,
        detalle: `falta ${proveedor.credencial}`,
      })
      continue
    }

    // El atajo que conserva el ahorro: la cuota es de la CUENTA, así que si un
    // modelo de este proveedor ya dijo "agotada", los demás lo están también y
    // preguntarlo otra vez es gastar una petición para saber lo mismo. Lo que
    // NO se puede heredar entre modelos es el rechazo: "este modelo no existe"
    // habla de un modelo, no del proveedor.
    if (!proveedor.credencial) {
      // Su llave no vive en el entorno, así que no hay con qué sondear la cuota
      // por HTTP. Eso es una duda REAL, y se dice con su motivo: hacerla pasar
      // por "no hay credencial en el entorno" —que es lo que devolvía la sonda
      // vacía— describiría como una falta lo que es una forma distinta de
      // guardar la llave.
      bitacora.push({
        proveedor: opcion.proveedor,
        modelo: opcion.id,
        resultado: "elegida",
        motivo: "cuota no sondeable: la credencial no vive en el entorno, la tiene el runtime",
      })
      return { elegida: opcion, bitacora, motivo: "" }
    }

    const clave = `${opcion.proveedor}/${opcion.id}`
    const agotadoYa = [...sondeos.entries()].find(
      ([k, v]) => k.startsWith(`${opcion.proveedor}/`) && v.estado === "AGOTADA",
    )
    if (!sondeos.has(clave)) {
      sondeos.set(
        clave,
        agotadoYa
          ? agotadoYa[1]
          : await sondear({ proveedor: opcion.proveedor, endpoint: proveedor.endpoint, apiKey, modelo: opcion.id }),
      )
    }
    const cuota = sondeos.get(clave)

    if (cuota.estado === "INSERVIBLE") {
      // El proveedor no dudó: dijo que no. Seguir con esta opción es gastar la
      // corrida en algo que ya se sabe que falla, y —peor— dejar sin mirar las
      // opciones que vienen detrás en la escalera.
      bitacora.push({
        proveedor: opcion.proveedor,
        modelo: opcion.id,
        resultado: "saltada",
        motivo: DESCARTE.INSERVIBLE,
        detalle: cuota.detalle,
      })
      continue
    }

    if (cuota.estado === "AGOTADA") {
      bitacora.push({
        proveedor: opcion.proveedor,
        modelo: opcion.id,
        resultado: "saltada",
        motivo: DESCARTE.SIN_CUOTA,
        detalle: cuota.detalle,
      })
      continue
    }

    // DISPONIBLE o INDETERMINADA. La duda no cierra la puerta: si el proveedor
    // no contesta, se intenta y que lo diga la corrida, en vez de dar por
    // agotado a alguien que a lo mejor solo tuvo un hipo de red.
    bitacora.push({
      proveedor: opcion.proveedor,
      modelo: opcion.id,
      resultado: "elegida",
      motivo: cuota.estado === "DISPONIBLE" ? "hay cuota" : `cuota desconocida: ${cuota.detalle}`,
    })
    return { elegida: opcion, bitacora, motivo: "" }
  }

  return {
    elegida: null,
    bitacora,
    motivo: `ninguna opción de "${idNeutral}" está disponible ahora mismo`,
  }
}

/**
 * La línea que acompaña a un resultado producido por el relevo.
 *
 * Va pegada al dictamen, no en un log aparte: quien lee un veredicto tiene que
 * ver con qué se produjo sin ir a buscarlo.
 */
export function firma(opcion) {
  return opcion ? `${opcion.proveedor}/${opcion.id}` : "sin proveedor"
}
