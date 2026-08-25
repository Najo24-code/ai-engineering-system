/**
 * Las dos reglas que se le aplican al dictamen de REVIEW, aparte del dictamen.
 *
 * Viven aquí y no dentro de `review.mjs` por un motivo práctico: ese archivo es
 * una etapa del flujo y arranca en cuanto se importa. Estas dos son funciones
 * puras, y en este repositorio toda regla necesita su prueba de unidad además de
 * la de cableado — una prueba que para correr tuviera que gastar una corrida del
 * proveedor sería una prueba que nadie corre.
 */

import { citasRotas } from "../verification/verdict.mjs"

/**
 * Lee el cierre del dictamen: veredicto, defectos bloqueantes, y en qué se
 * contradice si se contradice.
 *
 * Se queda con la ÚLTIMA coincidencia de cada campo, no con la primera. El
 * formato los pone al final a propósito, y un modelo que además resuma arriba
 * —o que copie la plantilla `Verdict: APPROVED | REJECTED`— haría que ganara la
 * primera línea sobre la que de verdad cierra el documento.
 */
export function leerDictamen(texto) {
  const campo = (nombre) => {
    const rx = new RegExp(`^\\s*(?:\\*\\*)?${nombre}(?:\\*\\*)?:\\s*(?:\\*\\*)?\\s*([A-Za-z0-9]+)`, "gmi")
    const todas = [...String(texto ?? "").matchAll(rx)]
    return todas.length ? todas.at(-1)[1].toUpperCase() : null
  }

  const veredicto = campo("Verdict")
  const bloqueantes = Number(campo("Blocking defects") ?? NaN)
  const incoherencias = []

  if (!veredicto) incoherencias.push("el dictamen no termina con un 'Verdict:' legible")
  else if (!["APPROVED", "REJECTED"].includes(veredicto)) incoherencias.push(`veredicto desconocido: ${veredicto}`)

  if (Number.isNaN(bloqueantes)) incoherencias.push("no dice cuántos defectos bloqueantes encontró")
  else if (veredicto === "REJECTED" && bloqueantes === 0)
    incoherencias.push("rechaza sin un solo defecto bloqueante: un dictamen así enseña a no leerlo")
  else if (veredicto === "APPROVED" && bloqueantes > 0)
    incoherencias.push(`aprueba con ${bloqueantes} defectos bloqueantes`)

  return { veredicto, bloqueantes, incoherencias }
}

/**
 * Una cita solo se declara rota si falla contra los DOS puntos de partida: el
 * proyecto y la raíz del repositorio.
 *
 * El dictamen puede citar `src/x.js:10` o `lab/src/x.js:10` según desde dónde
 * mire. Lo que se audita es si el archivo y la línea existen, no si el revisor
 * eligió la convención de rutas que a este script le venía bien: tomar una
 * convención por una mentira sería otro falso rojo, y de esos ya van varios.
 */
export function citasRotasEnAmbasRaices(proyecto, raiz, texto) {
  return citasRotas(proyecto, texto).filter((c) => citasRotas(raiz, c.cita).length > 0)
}
