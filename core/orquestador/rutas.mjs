/**
 * Las rutas: qué etapas se recorren para cada clase de tarea.
 *
 * Aquí está la decisión que define la Fase 5, y conviene decirla antes que el
 * código porque el código sale de ella:
 *
 *   **El modelo clasifica. El código ejecuta.**
 *
 * El gate G5.2 pide que ATLAS «no pueda saltarse la verificación». Si ATLAS
 * fuera un modelo decidiendo libremente la secuencia, eso no se podría *cumplir*:
 * sólo se le podría *pedir*. Y este proyecto ya midió dos veces, el mismo día,
 * que pedir no basta — PROBE resumió teniendo la orden literal de no resumir, y
 * REVIEW aprobó un cambio con la medición que lo rechazaba delante.
 *
 * Así que la secuencia no es una decisión: es un dato declarado, validado al
 * cargar este archivo. Lo que sí decide un modelo es **de qué clase es la
 * tarea**, que es un juicio y le corresponde. Si se equivoca de clase, el peor
 * resultado posible es recorrer la ruta equivocada —y todas las rutas terminan
 * en alto, ninguna publica—, nunca un resultado sin verificar.
 *
 * La otra mitad de la regla: **qué etapas escriben no se declara aquí**. Sale de
 * los contratos de `agents/`, que es donde vive esa verdad. Un agente nuevo que
 * escriba hereda la obligación de verificación sin que nadie se acuerde de
 * añadirlo a una lista.
 */

export const ETAPA = {
  RECON: "recon",
  BUILD: "build",
  VERIFICADOR: "verificador",
  REVIEW: "review",
  ALTO: "alto",
}

/**
 * Las rutas, por clase de tarea.
 *
 * `alto` no es decoración ni una etapa vacía: es el punto donde el ciclo entrega
 * a una persona. **Ninguna ruta publica.** Publicar sigue siendo de quien
 * responde por el repositorio, y la Fase 5 no cambia eso — cambia quién decide
 * el orden, no quién decide lo que sale de la máquina.
 */
export const RUTAS = {
  implementar: {
    porque: "hay que cambiar código, así que hace falta entender, escribir, medir y juzgar",
    etapas: [ETAPA.RECON, ETAPA.BUILD, ETAPA.VERIFICADOR, ETAPA.REVIEW, ETAPA.ALTO],
    reintenta: true,
  },
  diagnosticar: {
    porque: "hay que entender algo, no cambiarlo; escribir sería contestar una pregunta que nadie hizo",
    etapas: [ETAPA.RECON, ETAPA.ALTO],
    reintenta: false,
  },
  revisar: {
    porque: "el cambio ya existe: lo que falta es medirlo y juzgarlo, no volver a hacerlo",
    etapas: [ETAPA.VERIFICADOR, ETAPA.REVIEW, ETAPA.ALTO],
    reintenta: false,
  },
}

/**
 * El tope duro de vueltas (G5.4).
 *
 * Dos: el trabajo original y una corrección. Un ciclo que reintenta indefinidamente
 * no converge, gasta y esconde el problema — y el tercer intento casi nunca trae
 * el mismo defecto arreglado, trae otro distinto. Al agotarse no se decide nada:
 * se corta hacia una persona con lo que haya.
 */
export const MAX_VUELTAS = 2

/**
 * Qué etapas escriben en el proyecto, según los contratos.
 *
 * Se deriva, no se declara: `agents/<id>/agent.json` ya dice quién puede escribir
 * y dónde. Una segunda lista aquí se desincronizaría el primer día que alguien
 * cambiara un contrato, y este repositorio ya se comió esa lección dos veces —el
 * alcance del verificador contra el del gate, y el prompt contra la instalación.
 *
 * @param {Record<string, object>} contratos  id → agent.json
 */
export function etapasQueEscriben(contratos) {
  return Object.entries(contratos ?? {})
    .filter(([, c]) => (c?.scope?.write ?? []).length > 0)
    .map(([id]) => id)
}

/**
 * Si una ruta es válida. Se comprueba al cargar, no al correr.
 *
 * Una ruta mal formada que se descubre a mitad de una corrida ya gastó llamadas
 * al modelo y dejó el árbol tocado. Una que se descubre al importar el módulo no
 * llega a arrancar.
 *
 * @returns {string[]} problemas; vacío significa válida
 */
export function problemasDeRuta(nombre, ruta, contratos) {
  const problemas = []
  const etapas = ruta?.etapas ?? []
  const escriben = new Set(etapasQueEscriben(contratos))

  if (!etapas.length) return [`la ruta "${nombre}" no tiene etapas`]

  if (etapas.at(-1) !== ETAPA.ALTO) {
    problemas.push(`la ruta "${nombre}" no termina en alto: un ciclo sin punto de entrega no entrega, sigue`)
  }

  const desconocidas = etapas.filter((e) => !Object.values(ETAPA).includes(e))
  if (desconocidas.length) problemas.push(`la ruta "${nombre}" nombra etapas que no existen: ${desconocidas.join(", ")}`)

  // LA REGLA. Toda etapa que escribe tiene que estar seguida —en algún punto
  // posterior, no necesariamente el siguiente— por el verificador. Es G5.2
  // convertido en una propiedad de la forma de la ruta, comprobable sin correr
  // nada y sin preguntarle a ningún modelo.
  for (let i = 0; i < etapas.length; i++) {
    if (!escriben.has(etapas[i])) continue
    if (!etapas.slice(i + 1).includes(ETAPA.VERIFICADOR)) {
      problemas.push(
        `la ruta "${nombre}" deja que "${etapas[i]}" escriba y llega al final sin verificador: ` +
          `un cambio sin medir es exactamente lo que el sistema existe para no producir`,
      )
    }
  }

  // Reintentar sólo tiene sentido donde hay algo que rehacer.
  if (ruta.reintenta && !etapas.some((e) => escriben.has(e))) {
    problemas.push(`la ruta "${nombre}" dice que reintenta pero ninguna de sus etapas escribe: no hay qué corregir`)
  }

  if (!String(ruta.porque ?? "").trim()) {
    problemas.push(`la ruta "${nombre}" no dice por qué es así; una ruta sin porqué no se puede discutir ni auditar`)
  }

  return problemas
}

/** Todas las rutas declaradas, revisadas de una vez. */
export function problemasDeTodas(rutas, contratos) {
  return Object.entries(rutas ?? {}).flatMap(([n, r]) => problemasDeRuta(n, r, contratos))
}
