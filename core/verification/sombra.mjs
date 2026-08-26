/**
 * El test que muere sin que nadie lo borre.
 *
 * Este control existe por un caso medido el 2026-08-26, y es el tercero de la
 * misma familia: la suite se queda en verde mientras cubre menos.
 *
 * BUILD implementó un detector nuevo y añadió nueve pruebas. Una se llamaba
 * `test_muestras_viejas_quedan_fuera_de_la_ventana`, y en ese mismo archivo ya
 * había otra función con ese nombre exacto, que cubría un detector distinto.
 * Python se queda con la última definición: **la original dejó de existir al
 * importar el módulo.** El archivo tiene 49 `def test_`; pytest recoge 48.
 *
 * Lo que lo hace peligroso es todo lo que NO lo delata:
 *
 *   - La suite pasó, 66 en verde, 0 en rojo. El número **subió**.
 *   - El control de regresión (G3.6) no lo vio: mira tests borrados o
 *     silenciados en el diff, y aquí no se borró ni se silenció nada.
 *   - El control de alcance, el de secretos y el de citas, conformes.
 *   - REVIEW lo leyó entero y dictaminó APPROVED.
 *
 * Nadie mintió. Lo único que lo delata es una resta: había 58, se añadieron 9,
 * midió 66. Esa resta es la que este archivo mecaniza —por su forma exacta, que
 * es la que se puede comprobar sin volver a correr la suite del árbol base—.
 *
 * **Alcance honesto.** Esto caza la colisión de nombres, no toda pérdida
 * silenciosa de cobertura. El control general —que la suite crezca exactamente
 * lo que crecieron sus definiciones— necesita medir también el árbol base, y eso
 * son otra corrida de la suite y un árbol limpio que hoy no hay de dónde sacar
 * sin tocar el del usuario. Queda escrito en vez de escondido.
 */

import { esArchivoDeTest } from "./regresion.mjs"

/**
 * Solo cuentan las formas en que un test se DEFINE, no en las que se declara.
 *
 * La diferencia decide si el control tiene sentido. `def test_x` y `func TestX`
 * son enlaces en un espacio de nombres: dos con el mismo nombre y uno queda
 * muerto, siempre. `test("x", ...)` de node:test, jest o vitest es una LLAMADA:
 * dos con el mismo nombre corren las dos, y avisar ahí sería un rojo falso sobre
 * código que funciona.
 */
const DEFINICION = [
  /^(\s*)(?:async\s+)?def\s+(test_[A-Za-z0-9_]*)\s*\(/, // pytest / unittest
  /^()func\s+(Test[A-Za-z0-9_]*)\s*\(/, // go
]

/**
 * Las definiciones de test de un archivo, agrupadas por su ESPACIO DE NOMBRES.
 *
 * El espacio de nombres es lo que decide si dos definiciones se pisan, y no es
 * la sangría: dos métodos `test_caso_borde` en dos clases distintas tienen la
 * misma sangría y no se pisan nada. Agrupar por sangría produce exactamente el
 * rojo falso más fácil de generar en una suite organizada por clases —lo
 * produjo, de hecho, en su primera prueba—.
 *
 * Así que se sigue la anidación: para cada definición se busca la clase que la
 * contiene, que es la última abierta con menos sangría que ella.
 *
 * @returns {Map<string, number[]>} clave "Clase.Otra\0nombre" → líneas (1-indexadas)
 */
export function definicionesDeTest(contenido) {
  const encontradas = new Map()
  const lineas = String(contenido ?? "").split("\n")
  /** @type {{sangria: number, nombre: string}[]} */
  const clases = []

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]

    const clase = /^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(linea)
    if (clase) {
      const sangria = clase[1].length
      while (clases.length && clases.at(-1).sangria >= sangria) clases.pop()
      clases.push({ sangria, nombre: clase[2] })
      continue
    }

    for (const rx of DEFINICION) {
      const m = rx.exec(linea)
      if (!m) continue
      const sangria = m[1].length
      while (clases.length && clases.at(-1).sangria >= sangria) clases.pop()
      const ambito = clases.map((c) => c.nombre).join(".")
      const clave = `${ambito}\0${m[2]}`
      if (!encontradas.has(clave)) encontradas.set(clave, [])
      encontradas.get(clave).push(i + 1)
      break
    }
  }
  return encontradas
}

/**
 * Los nombres de test que el cambio AÑADE, por archivo.
 *
 * Solo se miran las líneas añadidas. Una colisión que ya estaba en el archivo
 * antes del cambio es un defecto de verdad, pero no es de este cambio, y
 * rechazar por ella convertiría cualquier edición de un archivo con deuda vieja
 * en un rechazo — que es cómo se enseña a la gente a ignorar un control.
 *
 * Se guarda el NOMBRE pelado, sin su ámbito. Un hunk no enseña la clase que lo
 * contiene —puede estar cien líneas más arriba, fuera del recorte—, así que
 * deducir el ámbito desde el diff sería adivinar. El ámbito lo pone el archivo
 * final, que sí se lee entero.
 *
 * @returns {Map<string, Set<string>>} ruta → nombres añadidos
 */
export function definicionesAñadidas(diff) {
  const porArchivo = new Map()
  let actual = null

  for (const linea of String(diff ?? "").split("\n")) {
    const cabecera = /^\+\+\+ b\/(.+)$/.exec(linea)
    if (cabecera) {
      actual = cabecera[1].trim()
      continue
    }
    if (!actual || !linea.startsWith("+") || linea.startsWith("+++")) continue
    if (!esArchivoDeTest(actual)) continue

    const contenido = linea.slice(1)
    for (const rx of DEFINICION) {
      const m = rx.exec(contenido)
      if (!m) continue
      if (!porArchivo.has(actual)) porArchivo.set(actual, new Set())
      porArchivo.get(actual).add(m[2])
      break
    }
  }
  return porArchivo
}

/**
 * Los tests que este cambio dejó muertos por colisión de nombre.
 *
 * Función pura: recibe el diff y el contenido final de los archivos. Todo lo que
 * decide está aquí, y nada necesita disco.
 *
 * @param {object} o
 * @param {string} o.diff
 * @param {Record<string,string>} o.contenidos ruta → contenido final del archivo
 * @returns {{ruta: string, nombre: string, lineas: number[]}[]}
 */
export function testsSombreados({ diff, contenidos = {} }) {
  const sombras = []

  for (const [ruta, añadidas] of definicionesAñadidas(diff)) {
    const contenido = contenidos[ruta]
    // Un archivo que el diff nombra y que no se puede leer no se da por bueno:
    // simplemente no hay nada que comprobar en él, y eso lo dice el control de
    // alcance, no este.
    if (contenido === undefined) continue

    const definiciones = definicionesDeTest(contenido)
    for (const nombre of añadidas) {
      // El mismo nombre puede existir en varios ámbitos del archivo sin pisarse.
      // Solo es sombra el ámbito donde está definido dos veces.
      for (const [clave, lineas] of definiciones) {
        if (clave.split("\0")[1] !== nombre || lineas.length < 2) continue
        sombras.push({ ruta, nombre, lineas })
      }
    }
  }

  return sombras
}

/** La forma corta, para el motivo del veredicto. */
export function explicarSombras(sombras) {
  return sombras
    .map((s) => `${s.ruta}:${s.lineas.join(" y ")} definen ${s.nombre} dos veces; solo corre la última`)
    .join(" · ")
}
