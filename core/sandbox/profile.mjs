/**
 * El recinto, descrito sin decir con qué se construye.
 *
 * Por qué existe esta capa, si el policy gate ya niega lo que no toca:
 *
 *   El gate es una puerta muy bien hecha en una pared de papel. Niega la llamada
 *   `write` fuera de alcance — y lo hace bien, está demostrado en fase-2. Pero un
 *   agente que puede escribir un test y correr `npm test` ejecuta código con los
 *   permisos del PROCESO, no con los del agente, y desde ahí hace lo que al gate
 *   le negaron. Ninguna regla nueva en el gate cierra eso: el agujero no está en
 *   la política, está en que la política es la única capa.
 *
 *   Y hay un segundo motivo, más incómodo: el mecanismo del que depende el gate
 *   —lanzar desde `tool.execute.before`— no es una API documentada. Es un
 *   comportamiento que verificamos en opencode 1.18.18. Nadie promete que la
 *   1.19 lo mantenga. Una garantía de seguridad no puede descansar sobre un
 *   efecto secundario de un proveedor.
 *
 * Así que la frontera baja una capa: lo prohibido no se DENIEGA, se vuelve
 * IMPOSIBLE. El gate se queda arriba, porque da el mensaje legible y el registro
 * de auditoría, y eso vale. Pero deja de ser lo único.
 *
 * Este archivo no sabe qué es bubblewrap. Describe QUÉ tiene que ser cierto;
 * `bwrap.mjs` traduce eso a un mecanismo concreto. Es la misma separación que
 * entre `core/policies/policy.mjs` y el plugin: si mañana el recinto se construye
 * con otra cosa, se reescribe el traductor y no la intención.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Lo mínimo que necesita cualquier proceso para arrancar. Se monta de solo
 * lectura: el agente puede USAR el sistema, no cambiarlo.
 */
const SISTEMA = ["/usr", "/etc/ssl", "/etc/ca-certificates", "/etc/alternatives"]

/**
 * Enlaces que en Debian/Ubuntu apuntan dentro de /usr. Recrearlos es más barato
 * y más honesto que montar /bin aparte: así el recinto tiene la misma forma que
 * el host sin duplicar nada.
 */
const ENLACES = { "/bin": "usr/bin", "/lib": "usr/lib", "/lib64": "usr/lib64", "/sbin": "usr/sbin" }

/**
 * Resolver `localhost` NO es "tener red", y confundir las dos cosas costó un
 * falso rojo entero.
 *
 * El recinto sin red conserva su interfaz de loopback: un proceso de dentro
 * puede levantar un servidor en 127.0.0.1 y hablar consigo mismo, que es como
 * funciona la mitad de las suites de integración que existen. Lo que NO puede
 * hacer sin estos dos archivos es traducir el nombre "localhost" a esa
 * dirección: `getaddrinfo` devuelve EAI_AGAIN y el test falla.
 *
 * Se descubrió verificando una corrida real de BUILD. El endpoint estaba bien,
 * el test estaba bien, y el veredicto salía RECHAZADO por el nombre de una
 * máquina. Un verificador que rechaza trabajo correcto se desactiva en una
 * semana, y entonces ya no protege nada.
 *
 * Van siempre, haya red o no. No abren nada: son dos tablas de nombres de solo
 * lectura, y sin `--share-net` no hay a dónde ir.
 */
const NOMBRES_LOCALES = ["/etc/hosts", "/etc/nsswitch.conf"]

/**
 * Lo que hace falta para resolver nombres de FUERA. Esto sí es red, y solo se
 * monta cuando se ha concedido explícitamente.
 */
const RED = ["/etc/resolv.conf"]

/**
 * Variables que se dejan pasar. La lista es blanca a propósito.
 *
 * El entorno es el canal de fuga más fácil que existe y el que menos se vigila:
 * heredar el entorno del padre mete ahí, sin que nadie lo escriba en ningún
 * sitio, la clave del proveedor, tokens de git, rutas a credenciales y el
 * historial de medio sistema. `printenv` no es una llamada a herramienta: el
 * gate no la ve.
 */
const ENTORNO_PERMITIDO = ["PATH", "LANG", "LC_ALL", "TERM", "TZ"]

/**
 * Construye la descripción del recinto para un agente concreto.
 *
 * @param {object} o
 * @param {string} o.proyecto   ruta absoluta del árbol en el que trabaja
 * @param {string} o.home       HOME que verá el proceso (tmpfs, vacío)
 * @param {string[]} [o.herramientas] rutas de ejecutables externos que necesita
 * @param {string[]} [o.efimeras]     rutas que existen pero se pierden al salir
 * @param {boolean} [o.red]     si puede hablar con el exterior
 * @param {object} [o.entorno]  variables extra, explícitas, nunca heredadas
 */
export function perfil({ proyecto, home, herramientas = [], efimeras = [], red = false, entorno = {} }) {
  if (!proyecto?.startsWith("/")) throw new Error("el proyecto tiene que ser una ruta absoluta")
  if (!home?.startsWith("/")) throw new Error("el home tiene que ser una ruta absoluta")

  const lectura = [...SISTEMA, ...NOMBRES_LOCALES, ...(red ? RED : [])].filter(existsSync)

  for (const h of herramientas) {
    if (!existsSync(h)) throw new Error(`la herramienta "${h}" no existe; el recinto quedaría inservible`)
    lectura.push(h)
  }

  return {
    proyecto,
    home,
    // Solo lectura: puede usar el sistema, no modificarlo.
    lectura,
    // Lo único escribible que sobrevive a la corrida.
    escritura: [proyecto],
    // Existen, hacen falta, y se los lleva la corriente al terminar.
    efimeras: ["/tmp", home, ...efimeras],
    enlaces: ENLACES,
    red,
    entorno: { PATH: "/usr/bin:/bin", HOME: home, ...filtrarEntorno(), ...entorno },
    /**
     * Documental, no ejecutable: nada de esto se monta, así que no hace falta
     * "negarlo". Está escrito para que el informe pueda decir QUÉ deja de ser
     * alcanzable y para que se note si alguien lo monta por comodidad.
     */
    invisible: [
      `${home}/.ssh`,
      `${home}/.bashrc`,
      `${home}/.config/gh`,
      `${home}/.gitconfig`,
      `${home}/.npmrc`,
      `${home}/.claude`,
      `${home}/.local/share/opencode/auth.json`,
      "el resto de los proyectos del disco",
    ],
  }
}

function filtrarEntorno() {
  const salida = {}
  for (const k of ENTORNO_PERMITIDO) {
    if (process.env[k] !== undefined) salida[k] = process.env[k]
  }
  return salida
}

/**
 * El recinto de un agente que corre bajo OpenCode.
 *
 * El binario y el estado se tratan distinto a propósito: el binario entra de
 * solo lectura, y el estado (base de datos, logs, instantáneas, `auth.json`)
 * NO entra en absoluto — se le da un directorio efímero. Así cada corrida
 * arranca limpia y, sobre todo, las credenciales guardadas de otras sesiones no
 * existen dentro del recinto.
 */
export function perfilOpenCode({ proyecto, home, red, clave = null }) {
  const binario = join(process.env.HOME, ".opencode", "bin", "opencode")

  return perfil({
    proyecto,
    home,
    herramientas: [binario],
    efimeras: [join(home, ".local", "share", "opencode"), join(home, ".cache")],
    red,
    // La clave entra solo si se pide explícitamente. Ver la deuda del informe:
    // mientras el agente necesite hablar con el proveedor, la clave está a su
    // alcance. Lo que cierra eso es un relevo fuera del recinto, no un mount.
    entorno: clave ? { OPENROUTER_API_KEY: clave } : {},
  })
}
