/**
 * La versión contra la que se verificó, y la que hay puesta.
 *
 * `runtime.json` guarda los hechos medidos de un runtime —cómo se niega una
 * llamada, dónde se aplica la política, cómo se llama cada herramienta— y su
 * propio comentario lo dice sin rodeos: *«Al subir de versión hay que volver a
 * verificarlo Y volver a correr el banco: este archivo caduca.»*
 *
 * **Nadie comprobaba la caducidad.** Peor: los dos instaladores imprimían
 * `verified_version` al terminar, con una frase —«4 agentes sincronizados con
 * opencode 1.18.18»— que se lee como si alguien hubiera mirado la instalación.
 * No la miraba nadie. El 2026-08-26, montando una instalación limpia para G6.4,
 * salió que la máquina donde se construyó el sistema **también** tenía 1.18.23:
 * los hechos del runtime llevaban cinco versiones sin revalidar, en silencio, y
 * el instalador imprimía un número que parecía medido.
 *
 * Avisa, no impide. Un salto de parche casi nunca mueve una frontera, y un gate
 * que bloquee el trabajo por eso se desactiva la primera semana. Lo que no puede
 * es pasar callado: la diferencia entre «esto está verificado» y «esto estaba
 * verificado hace cinco versiones» es justo lo que el informe tiene que decir.
 */

import { execFileSync } from "node:child_process"

/**
 * Extrae el primer `x.y.z` de una salida. Los runtimes contestan cosas distintas
 * —`1.18.23` a secas uno, `2.1.246 (Claude Code)` el otro— y lo que importa es el
 * número, no el adorno que lo rodea.
 */
export function versionDeSalida(salida) {
  const m = /\b(\d+\.\d+\.\d+)\b/.exec(String(salida ?? ""))
  return m ? m[1] : null
}

/**
 * Qué versión hay puesta de verdad.
 *
 * Devuelve `null` cuando no se puede saber, y quien llame tiene que tratar ese
 * `null` como «no se sabe», nunca como «coincide». Es la regla de siempre: lo
 * que no se puede medir no pasa por bueno.
 */
export function versionInstalada(comando) {
  if (!Array.isArray(comando) || !comando.length) return null
  try {
    return versionDeSalida(execFileSync(comando[0], comando.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
  } catch {
    return null
  }
}

/**
 * El veredicto sobre la pareja, dicho para que lo lea una persona que acaba de
 * instalar.
 *
 * @returns {{estado: "coincide"|"difiere"|"desconocida", linea: string, aviso: string|null}}
 */
export function compararVersion({ runtime, instalada, verificada }) {
  if (!instalada) {
    return {
      estado: "desconocida",
      linea: `${runtime}: no se pudo medir la versión instalada; los hechos del runtime se verificaron contra ${verificada}`,
      aviso:
        `no se sabe qué versión de ${runtime} hay puesta. Los hechos de runtime.json ` +
        `—cómo se niega una llamada, cómo se llama cada herramienta— se midieron contra ${verificada}. ` +
        `Sin poder compararlos, no se puede decir que sigan siendo ciertos aquí`,
    }
  }
  if (instalada === verificada) {
    return { estado: "coincide", linea: `${runtime} ${instalada} (verificado contra esta misma versión)`, aviso: null }
  }
  return {
    estado: "difiere",
    linea: `${runtime} ${instalada} instalado · los hechos del runtime se verificaron contra ${verificada}`,
    aviso:
      `hay ${runtime} ${instalada} y runtime.json se midió contra ${verificada}. ` +
      `Nada dice que las fronteras sigan aplicándose igual: para volver a darlo por cierto hay que ` +
      `correr el banco (npm run gate:boundary) y actualizar verified_version`,
  }
}
