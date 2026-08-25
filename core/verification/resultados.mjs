/**
 * Leer lo que dijo la suite, la haya escrito el corredor que la haya escrito.
 *
 * Hasta ahora el verificador solo entendía el resumen TAP de `node --test`. Con
 * un laboratorio en Node eso no se nota. Se nota al apuntarlo a un proyecto de
 * verdad: **yunque** tiene 45 pruebas en pytest y **rafa-gym** las suyas en
 * vitest, y las dos salían RECHAZADAS. No porque fallaran —estaban en verde—
 * sino porque el lector devolvía `null` y arriba `null` significa "no medible",
 * que se traduce en rechazo.
 *
 * Un verificador que solo sabe leer el runner de su propio laboratorio no está
 * verificando: está reconociendo su casa. Y el rechazo era indistinguible de un
 * rechazo legítimo, que es la peor forma de estar roto.
 *
 * ── Las dos reglas ──────────────────────────────────────────────────────────
 *
 * **No medible no es aprobado.** Se hereda intacta. Si ningún lector reconoce la
 * salida, la respuesta es `null` y arriba se rechaza. Ampliar el lector no
 * afloja la puerta: le enseña más idiomas.
 *
 * **La ambigüedad tampoco es aprobado.** Si dos lectores reconocen la misma
 * salida y no dicen lo mismo, el resultado es `null`. Elegir uno «por orden de
 * la lista» sería exactamente adivinar, y el número adivinado saldría por el
 * otro lado con la misma cara de dato medido que uno real.
 *
 * Los formatos NO están sacados de la documentación: están capturados de
 * corridas reales en esta máquina el 2026-08-25, en verde y en rojo. Un formato
 * copiado de un README es una suposición con buena letra.
 */

/** Los colores del terminal no cambian el resultado, pero sí rompen un regex. */
const sinColor = (s) => s.replace(/\[[0-9;]*m/g, "")

/**
 * Cada lector devuelve `{pasaron, fallaron}` o `null` si no reconoce la salida.
 * El ancla de cada uno es deliberadamente estrecha: es preferible no reconocer
 * una salida a reconocerla mal.
 */
const LECTORES = {
  /**
   * `node --test`, formato TAP.
   *   # pass 66
   *   # fail 0
   */
  tap(s) {
    const pass = /^# pass (\d+)$/m.exec(s)
    const fail = /^# fail (\d+)$/m.exec(s)
    if (!pass || !fail) return null
    return { pasaron: Number(pass[1]), fallaron: Number(fail[1]) }
  },

  /**
   * pytest, línea de resumen final.
   *   45 passed in 0.77s
   *   2 failed, 2 passed in 0.02s
   *
   * El ancla es el ` in <n>s` del final: sin él, la línea «2 passed» de otro
   * corredor entraría por aquí.
   *
   * `error` cuenta como fallo. Un fichero que revienta al importarse no ejecuta
   * ni una prueba, y sin contarlo la suite más rota del mundo saldría con cero
   * fallos: el falso verde más barato de fabricar.
   */
  pytest(s) {
    const linea = /^=*\s*(\d+[^\n]*?)\s+in\s+[\d.]+s[^\n]*$/m.exec(sinColor(s))
    if (!linea) return null
    const cuerpo = linea[1]
    const cuenta = (etiqueta) => {
      const m = new RegExp(`(\\d+) ${etiqueta}`).exec(cuerpo)
      return m ? Number(m[1]) : 0
    }
    const pasaron = cuenta("passed")
    const fallaron = cuenta("failed") + cuenta("error(?:s)?")
    // Una línea de tiempo que no menciona ni una ni otra no es un resumen.
    if (!/passed|failed|error/.test(cuerpo)) return null
    return { pasaron, fallaron }
  },

  /**
   * vitest.
   *   Tests  3 passed (3)
   *   Tests  1 failed | 2 passed (3)
   *
   * Se distingue de jest por los dos puntos: jest escribe `Tests:`, vitest no.
   */
  vitest(s) {
    const linea = /^\s*Tests\s+([^\n:]+?)\((\d+)\)\s*$/m.exec(sinColor(s))
    if (!linea) return null
    const cuerpo = linea[1]
    const cuenta = (etiqueta) => {
      const m = new RegExp(`(\\d+) ${etiqueta}`).exec(cuerpo)
      return m ? Number(m[1]) : 0
    }
    return { pasaron: cuenta("passed"), fallaron: cuenta("failed") }
  },

  /**
   * jest.
   *   Tests:       3 passed, 3 total
   *   Tests:       1 failed, 2 passed, 3 total
   */
  jest(s) {
    const linea = /^Tests:\s+(.+?,\s*\d+ total)\s*$/m.exec(sinColor(s))
    if (!linea) return null
    const cuerpo = linea[1]
    const cuenta = (etiqueta) => {
      const m = new RegExp(`(\\d+) ${etiqueta}`).exec(cuerpo)
      return m ? Number(m[1]) : 0
    }
    return { pasaron: cuenta("passed"), fallaron: cuenta("failed") }
  },
}

/**
 * Lee el resultado de la suite probando todos los lectores.
 *
 * @returns {{pasaron: number, fallaron: number, formato: string}|null}
 *          `null` cuando nadie la entiende **o cuando dos la entienden distinto**.
 */
export function leerResultado(salida) {
  const reconocidos = []
  for (const [formato, lector] of Object.entries(LECTORES)) {
    const r = lector(salida)
    if (r) reconocidos.push({ ...r, formato })
  }

  if (reconocidos.length === 0) return null

  const [primero, ...resto] = reconocidos
  const discrepan = resto.some((r) => r.pasaron !== primero.pasaron || r.fallaron !== primero.fallaron)
  // Dos lectores que no se ponen de acuerdo sobre la misma salida no dejan un
  // resultado peor: dejan uno inventado. Se declara no medible.
  if (discrepan) return null

  return primero
}

/** Los formatos que este verificador sabe leer, para poder decirlo al rechazar. */
export const FORMATOS = Object.keys(LECTORES)
