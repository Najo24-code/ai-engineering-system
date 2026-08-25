/**
 * El traductor: de la descripción del recinto a bubblewrap.
 *
 * Por qué bubblewrap y no Docker, que es lo que todo el mundo alcanza primero:
 *
 *   - No hay demonio ni root. El recinto arranca en milisegundos, así que el
 *     banco de contención se puede correr en cada cambio en vez de "cuando toque".
 *     Una prueba de seguridad que tarda se deja de correr, y una que no se corre
 *     no protege nada.
 *   - No hay imagen que mantener. Con Docker habría que empaquetar node, el
 *     binario de opencode y las librerías, y esa imagen se desincroniza del host
 *     en silencio hasta que un día la prueba mide algo que ya no es el sistema.
 *   - El default de Docker es MÁS permisivo justo donde importa: raíz escribible
 *     entera y la costumbre de montar `$HOME` de un tirón.
 *
 * La regla de construcción es una sola: **se niega por omisión**. No hay lista
 * de prohibiciones. Lo que no se monta, no existe dentro. Esa es la diferencia
 * entre esta capa y el policy gate, que enumera lo que niega y por tanto solo
 * puede negar lo que alguien se acordó de enumerar.
 */

import { existsSync } from "node:fs"

/**
 * @param {object} recinto  lo que devuelve profile.mjs
 * @param {string[]} comando  argv del proceso a correr dentro
 * @returns {string[]} argv completo de bwrap
 */
export function argv(recinto, comando) {
  if (!comando?.length) throw new Error("no hay comando que correr dentro del recinto")

  const a = [
    // Todo separado del host: usuarios, procesos, IPC, cgroups, hostname y red.
    // Lo que se necesita se devuelve después, uno por uno y a propósito.
    "--unshare-all",
    // Si el padre muere, el recinto muere. Un agente que sobrevive a quien lo
    // lanzó es un agente sin dueño.
    "--die-with-parent",
    // El entorno se construye entero; no se hereda ni una variable por descuido.
    "--clearenv",
    "--new-session",
  ]

  if (recinto.red) a.push("--share-net")

  // El orden importa: primero lo efímero, que crea el esqueleto vacío, y encima
  // los montajes reales. Al revés, un tmpfs taparía lo que acabas de montar.
  for (const ruta of recinto.efimeras) a.push("--tmpfs", ruta)

  a.push("--proc", "/proc", "--dev", "/dev")

  for (const [enlace, destino] of Object.entries(recinto.enlaces ?? {})) {
    a.push("--symlink", destino, enlace)
  }

  for (const ruta of recinto.lectura) {
    if (existsSync(ruta)) a.push("--ro-bind", ruta, ruta)
  }

  for (const ruta of recinto.escritura) {
    if (!existsSync(ruta)) throw new Error(`la ruta de escritura "${ruta}" no existe`)
    a.push("--bind", ruta, ruta)
  }

  for (const [k, v] of Object.entries(recinto.entorno)) a.push("--setenv", k, String(v))

  a.push("--chdir", recinto.proyecto, "--")
  return [...a, ...comando]
}

/** Para el informe y para el registro de la corrida: qué recinto fue, exactamente. */
export function resumen(recinto) {
  return {
    mecanismo: "bubblewrap",
    escribible: recinto.escritura,
    efimero: recinto.efimeras,
    solo_lectura: recinto.lectura,
    red: recinto.red ? "SÍ — el agente puede hablar con el exterior" : "no",
    entorno_expuesto: Object.keys(recinto.entorno),
    fuera_de_alcance: recinto.invisible,
  }
}
