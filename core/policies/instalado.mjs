/**
 * El alcance que de verdad se aplicó, que no siempre es el que dice el contrato.
 *
 * Este archivo arregla una desincronización que estaba lista para producir el
 * peor tipo de fallo que tiene este proyecto: un rojo falso con un motivo
 * plausible.
 *
 * Así estaba. El contrato de BUILD declara `scope.write: ["src/**", "tests/**"]`.
 * Eso no es un alcance universal: es la forma de `lab/`, que es Node. Cuando el
 * ciclo corre contra un proyecto real, el instalador ata esa intención a las
 * rutas del proyecto —`--alcance "server/**"` en un proyecto Python— y deja el
 * resultado en `scopes.generated.json`, que es lo que el policy gate lee en cada
 * llamada. **El gate aplicaba `server/**`. El verificador medía contra
 * `src/**`.** Dos copias de la misma verdad, exactamente el fallo que este
 * repositorio ya se comió una vez.
 *
 * El efecto: BUILD escribe donde se le autorizó, el gate lo permite —bien—, y
 * acto seguido el verificador declara RECHAZADO «fuera del alcance:
 * server/detectores.py». Trabajo impecable, rojo, y un motivo tan creíble que se
 * cree. Un control que se equivoca así se aprende a ignorar, y un control que se
 * ignora es peor que no tenerlo.
 *
 * La regla, entonces: **se mide contra lo que se aplicó**. El contrato solo
 * gobierna cuando no hay instalación, y en ese caso se dice.
 */

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Dónde deja cada adaptador el alcance atado al proyecto. El orden importa solo
 * para el desempate, y el desempate se explica en `elegirAlcance`.
 */
export const INSTALACIONES = {
  opencode: join(".opencode", "scopes.generated.json"),
  "claude-code": join(".claude", "hooks", "scopes.generated.json"),
}

/**
 * Lee las instalaciones que haya en el proyecto. Una que exista pero esté rota
 * NO se ignora: se devuelve con su error. Ignorarla en silencio dejaría al
 * verificador cayendo al contrato —a `src/**`— justo en el proyecto donde
 * alguien se tomó el trabajo de declarar otra cosa.
 */
export function leerInstalaciones(proyecto) {
  const encontradas = {}
  for (const [runtime, relativa] of Object.entries(INSTALACIONES)) {
    const ruta = join(proyecto, relativa)
    if (!existsSync(ruta)) continue
    try {
      encontradas[runtime] = { ruta: relativa, datos: JSON.parse(readFileSync(ruta, "utf8")) }
    } catch (e) {
      encontradas[runtime] = { ruta: relativa, error: `no se pudo leer: ${e.message}` }
    }
  }
  return encontradas
}

const mismaLista = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

/**
 * Qué alcance se usa para medir, y de dónde salió.
 *
 * Función pura: recibe lo ya leído. Todas las decisiones están aquí y ninguna
 * necesita disco, que es la única forma de que tengan prueba de unidad.
 *
 * @param {object} o
 * @param {Record<string,{ruta:string,datos?:object,error?:string}>} o.instalaciones lo que devuelve `leerInstalaciones`
 * @param {object} o.contrato   el `agent.json` del agente
 * @param {string} [o.agente]   qué agente se mide (el que escribe)
 * @param {string} [o.runtime]  qué runtime corrió de verdad el ciclo
 * @returns {{write: string[], shell: string[], fuente: string, avisos: string[]}}
 */
export function elegirAlcance({ instalaciones = {}, contrato, agente = "build", runtime = "opencode" }) {
  const avisos = []
  const delContrato = {
    write: contrato?.scope?.write ?? [],
    shell: contrato?.scope?.shell ?? [],
  }

  for (const [id, inst] of Object.entries(instalaciones)) {
    if (inst.error) avisos.push(`la instalación de ${id} (${inst.ruta}) ${inst.error}`)
  }

  const utiles = Object.entries(instalaciones).filter(([, i]) => i.datos?.agents?.[agente])
  if (!utiles.length) {
    // Sin instalación, el contrato es lo único que hay. Pero decirlo importa:
    // en un proyecto que no sea Node con `src/`, medir contra el contrato es
    // medir contra la forma de otro proyecto.
    avisos.push(
      `no hay alcance instalado para "${agente}" en este proyecto; se mide contra el contrato (${delContrato.write.join(", ") || "vacío"})`,
    )
    return { ...delContrato, fuente: "contrato", avisos }
  }

  // Se prefiere la instalación del runtime que de verdad corrió. Si el ciclo
  // corrió en OpenCode, el alcance que se aplicó es el de OpenCode, por muy
  // instalado que esté el otro adaptador.
  const elegida = utiles.find(([id]) => id === runtime) ?? utiles[0]
  const [idElegido, inst] = elegida
  if (idElegido !== runtime) {
    avisos.push(`el ciclo corrió en ${runtime} pero el único alcance instalado es el de ${idElegido}`)
  }

  // Dos instalaciones que no dicen lo mismo no se resuelven eligiendo: se dicen.
  // Sea cual sea la que gane, la otra está gobernando alguna corrida con otro
  // alcance, y eso lo arregla una persona, no un desempate.
  for (const [id, otra] of utiles) {
    if (id === idElegido) continue
    if (!mismaLista(otra.datos.agents[agente].write, inst.datos.agents[agente].write)) {
      avisos.push(
        `las instalaciones no coinciden: ${idElegido} escribe en [${inst.datos.agents[agente].write.join(", ")}] y ${id} en [${otra.datos.agents[agente].write.join(", ")}]`,
      )
    }
  }

  const alcance = inst.datos.agents[agente]
  return {
    write: alcance.write ?? [],
    shell: alcance.shell ?? [],
    fuente: `instalación de ${idElegido} (${inst.ruta})`,
    avisos,
  }
}

/**
 * Lo de arriba, con el disco puesto. Es la que llaman las etapas del flujo.
 */
export function alcanceEfectivo({ proyecto, contrato, agente = "build", runtime = "opencode" }) {
  return elegirAlcance({ instalaciones: leerInstalaciones(proyecto), contrato, agente, runtime })
}

/**
 * De los comandos permitidos, cuál es el de correr las pruebas.
 *
 * El verificador necesita saber cómo se corre la suite de ESTE proyecto, y esa
 * respuesta ya está escrita en la instalación: `--comandos` la puso ahí. Sin
 * esto, quien dispara el ciclo tiene que acordarse de repetirla a mano en cada
 * etapa, y el día que se le olvide el verificador corre `npm test` en un
 * proyecto Python, no encuentra suite y produce —otra vez— un rojo con un motivo
 * plausible.
 *
 * Los comandos de solo mirar (`git status`, `git diff`, `git log`) no son la
 * suite: están en el alcance de todos los proyectos y no prueban nada.
 */
export function comandoDePruebas(shell = []) {
  const mirar = /^git\s+(status|diff|log|show)\b/
  const candidato = shell.find((c) => !mirar.test(c.trim()))
  return candidato ? candidato.trim().split(/\s+/) : null
}
