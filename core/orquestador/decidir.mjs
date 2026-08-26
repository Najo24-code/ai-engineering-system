/**
 * Qué decide el modelo, y qué no puede decidir aunque quiera.
 *
 * ATLAS elige **la clase de la tarea**. No elige la secuencia, no inventa etapas
 * y no puede nombrar una ruta que no exista. Ese reparto es lo que hace que G5.2
 * sea una propiedad y no una promesa: la peor consecuencia de una clasificación
 * equivocada es recorrer la ruta que no tocaba —y todas terminan en alto, sin
 * publicar—, nunca un resultado sin verificar.
 *
 * La regla de lectura es dura a propósito: si la respuesta no nombra exactamente
 * una clase conocida, **no se adivina**. Se corta hacia una persona. Un
 * orquestador que ante la duda elige «lo más probable» convierte cada respuesta
 * confusa del modelo en una corrida que nadie pidió.
 */

import { RUTAS } from "./rutas.mjs"

export const CLASES = Object.keys(RUTAS)

/**
 * La clase que dijo el modelo, o `null`.
 *
 * Se busca la etiqueta declarada (`Clase: implementar`) y, si no está, una
 * mención inequívoca a **una sola** clase. Dos clases mencionadas es ambigüedad,
 * y la ambigüedad no se resuelve por orden de aparición.
 */
export function leerClase(salida, clases = CLASES) {
  const texto = String(salida ?? "")

  // El token se captura ENTERO, guiones incluidos. Cortándolo en el guion,
  // «implementar-rapido» —una ruta que no existe— se recortaba a «implementar» y
  // pasaba como válida: la aproximación silenciosa que esta función existe para
  // no hacer.
  const etiqueta = [...texto.matchAll(/^\s*(?:\*\*)?(?:clase|class|ruta|route)(?:\*\*)?\s*:\s*(?:\*\*)?\s*([a-záéíóúñ][\wáéíóúñ-]*)/gim)]
  if (etiqueta.length) {
    const dicha = etiqueta.at(-1)[1].toLowerCase()
    return clases.includes(dicha) ? dicha : null
  }

  const mencionadas = clases.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(texto))
  return mencionadas.length === 1 ? mencionadas[0] : null
}

/**
 * La decisión completa, lista para el registro (G5.5).
 *
 * Un registro que sólo dijera «ruta: implementar» no sirve para auditar nada
 * dentro de tres meses. Hace falta **quién** lo decidió —el modelo o una regla—,
 * **por qué** esa ruta es así, y **qué se descartó**: sin las alternativas, una
 * decisión siempre parece la única posible.
 *
 * @returns {{corte: string|null, clase: string|null, etapas: string[], porque: string, quien: string, descartadas: string[]}}
 */
export function decidir({ salidaDelModelo, rutas = RUTAS, tarea = "" }) {
  const clases = Object.keys(rutas)
  const clase = leerClase(salidaDelModelo, clases)

  if (!clase) {
    return {
      corte: "el clasificador no nombró una sola clase conocida; no se adivina la ruta",
      clase: null,
      etapas: [],
      porque: "",
      quien: "regla",
      descartadas: clases,
      tarea,
    }
  }

  return {
    corte: null,
    clase,
    etapas: rutas[clase].etapas,
    porque: rutas[clase].porque,
    quien: "modelo",
    descartadas: clases.filter((c) => c !== clase),
    tarea,
  }
}

/**
 * El renglón que se guarda por cada decisión.
 *
 * Va aparte de `decidir` porque el sello de tiempo lo pone quien escribe, no
 * quien decide: una función pura con `Date.now()` dentro no se puede probar.
 */
export function renglonDeBitacora(decision, ahora = new Date()) {
  return JSON.stringify({
    fecha: ahora.toISOString(),
    clase: decision.clase,
    etapas: decision.etapas,
    porque: decision.porque,
    quien: decision.quien,
    descartadas: decision.descartadas,
    corte: decision.corte,
    tarea: String(decision.tarea ?? "").split("\n")[0].slice(0, 200),
  })
}

/**
 * Por qué se detuvo el ciclo, dicho para una persona.
 *
 * G5.3 en una frase: **un fallo detiene, nunca se sigue adelante «arreglándolo»**.
 * Lo que hace este texto es que el corte no se lea como un error del sistema
 * cuando es el sistema haciendo lo correcto.
 */
export function explicarCorte({ etapa, motivo, vuelta = null, maxVueltas = null }) {
  if (etapa === "vueltas") {
    return (
      `Se agotaron las ${maxVueltas} vueltas y el trabajo sigue sin pasar. ` +
      `El ciclo para aquí a propósito: un tercer intento casi nunca trae el mismo defecto arreglado, ` +
      `trae otro distinto. Lo que hay está en la corrida, sin publicar.`
    )
  }
  return (
    `Se detuvo en "${etapa}": ${motivo}. ` +
    `No se sigue a la etapa siguiente con esto sin resolver${vuelta ? ` (vuelta ${vuelta})` : ""}: ` +
    `una etapa que arranca sobre un fallo anterior produce evidencia que parece buena y no lo es.`
  )
}
