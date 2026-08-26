/**
 * La huella del árbol de trabajo en el momento en que se midió.
 *
 * Existe por un agujero que solo se ve cuando el ciclo llega hasta el final. El
 * verificador mide un árbol; publicar lo publica. Entre las dos cosas pasa
 * tiempo, y en ese tiempo el árbol puede haber cambiado: alguien editó un
 * archivo, se corrió otra vuelta de BUILD, se probó algo a mano y se dejó
 * puesto. **El PR saldría con el sello de una verificación que se hizo sobre
 * otro contenido**, y el sello es todo lo que el revisor humano tiene.
 *
 * No es un caso raro. Es lo que pasa siempre que la corrida no se publica en el
 * mismo minuto, que es casi siempre.
 *
 * Comparar el diff de texto no basta, y por un motivo concreto: `git diff` no ve
 * los archivos que nunca se añadieron al índice. Un test nuevo —lo más normal
 * que puede hacer BUILD— no aparece en el diff, así que un control basado solo
 * en el diff diría «idéntico» mientras el archivo nuevo cambia entero debajo.
 * Por eso se sella el CONTENIDO de cada archivo tocado, venga del diff o de los
 * no seguidos.
 */

import { createHash } from "node:crypto"
import { readFileSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"

const AUSENTE = "ausente"

/**
 * @param {string} proyecto  raíz del árbol
 * @param {string[]} archivos rutas relativas al proyecto (las que devuelve `archivosDelDiff`)
 * @returns {Record<string,string>} ruta → sha256 del contenido, o "ausente"
 */
export function huellaDeArchivos(proyecto, archivos) {
  const huella = {}
  for (const rel of [...new Set(archivos)].sort()) {
    const abs = join(proyecto, rel)
    // Un archivo que el diff nombra y que ya no está no es un error de la
    // huella: es un borrado, y sellarlo como "ausente" lo distingue de un
    // archivo que nunca se nombró. Las dos cosas tienen que poder compararse.
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      huella[rel] = AUSENTE
      continue
    }
    huella[rel] = createHash("sha256").update(readFileSync(abs)).digest("hex")
  }
  return huella
}

/**
 * Qué se movió entre dos huellas.
 *
 * Devuelve las tres formas de moverse por separado, en vez de un booleano,
 * porque el motivo cambia qué tiene que hacer quien lo lee: un archivo nuevo
 * suele ser trabajo que no se verificó, uno que desapareció suele ser una
 * reversión a medias, y uno que cambió de contenido es el caso peligroso —el que
 * conserva el nombre y el sello mientras el contenido ya es otro—.
 *
 * @returns {{iguales: boolean, aparecieron: string[], desaparecieron: string[], cambiaron: string[]}}
 */
export function compararHuellas(medida, actual) {
  const antes = medida ?? {}
  const ahora = actual ?? {}

  const aparecieron = Object.keys(ahora).filter((f) => !(f in antes))
  const desaparecieron = Object.keys(antes).filter((f) => !(f in ahora))
  const cambiaron = Object.keys(antes).filter((f) => f in ahora && antes[f] !== ahora[f])

  return {
    iguales: !aparecieron.length && !desaparecieron.length && !cambiaron.length,
    aparecieron,
    desaparecieron,
    cambiaron,
  }
}

/**
 * La diferencia, dicha para que la lea una persona que está a punto de publicar.
 */
export function explicarDeriva({ aparecieron, desaparecieron, cambiaron }) {
  const partes = []
  if (cambiaron.length) partes.push(`cambiaron de contenido: ${cambiaron.join(", ")}`)
  if (aparecieron.length) partes.push(`aparecieron sin verificar: ${aparecieron.join(", ")}`)
  if (desaparecieron.length) partes.push(`ya no están: ${desaparecieron.join(", ")}`)
  return partes.join(" · ")
}
