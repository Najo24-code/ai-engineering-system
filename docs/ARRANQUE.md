# Prompt de arranque

Para pegar al empezar una sesión en OpenCode (o en cualquier runtime) sobre este
repositorio. Dice lo que hay, cómo se usa y qué cuesta horas si no se sabe.

**Mantenerlo corto es parte del diseño.** Un prompt de arranque largo se lee por
encima. Lo que no quepa aquí va en `docs/ARCHITECTURE.md` y `docs/ROADMAP.md`, y
este archivo dice dónde mirar.

---

```
Estás en ai-engineering-system: un sistema multiagente de ingeniería de software,
personal y privado. Lee docs/ROADMAP.md y docs/ARCHITECTURE.md antes de proponer
nada; las siete fases del plan están cerradas y cada una tiene su informe en
docs/audits/.

QUÉ HACE
Un issue de GitHub entra, y sale un pull request con una medición independiente
dentro. El ciclo es RECON (entiende) → BUILD (implementa) → verificador (MIDE) →
REVIEW (juzga), con vuelta a BUILD si hay rechazo. Lo orquesta ATLAS.

LA REGLA QUE GOBIERNA TODO
Lo que no se puede medir NO pasa. El sistema no le cree a ningún agente: corre la
suite él mismo, mide el diff él mismo y audita cada cita archivo:línea contra el
archivo. "El agente dijo que pasó" no es que pasara.

Y su corolario, que se ganó a base de golpes: UNA INSTRUCCIÓN NO ES UN MECANISMO.
Tres veces en un mismo día un agente incumplió una orden literal de su propio
prompt. Por eso nada importante se apoya en pedir: se apoya en que el runtime no
entregue la herramienta, en que el gate mire la ruta en cada llamada, o en que la
forma del dato no permita el error.

CÓMO SE CORRE
  npm test                          265 pruebas, ~1 s, CERO llamadas al modelo
  npm run gate:contencion           el recinto: ataques deterministas, cuesta 0
  npm run gate:cortes               que un fallo detiene el ciclo
  npm run relevo:seco               con qué proveedor correría cada agente
  node core/orquestador/atlas.mjs --task "..." --target /ruta
  node core/flow/publicar.mjs --run runs/<x>      (sin --confirmar no toca nada)

ANTES DE TOCAR UN PROYECTO AJENO
  node runtimes/opencode/sync.mjs --en /ruta --alcance "server/**" \
       --comandos "venv/bin/python -m pytest server/ -q"
--alcance y --comandos NO son opcionales fuera de un proyecto Node con src/:
dónde vive el código es propiedad del PROYECTO, no del rol del agente. Sin ellos
el gate niega toda escritura y parece que el agente falla.

LO QUE CUESTA HORAS SI NO SE SABE
- El runtime CAMBIA DE AGENTE EN SILENCIO: `opencode run --agent <subagente>` no
  falla, avisa con un "!" y corre el agente por defecto, con otro modelo y sin
  alcance. Está detectado y es TERMINAL, pero si lo ves en otro runtime,
  desconfía de un informe con buena pinta.
- No se le pide prosa a quien vigilas: la respuesta de un subagente sale del
  resultado del tool `task` (--format json), que lo escribe el runtime, no del
  texto del primario, que a veces resume.
- git diff NO ve los archivos que el agente CREA. Usa diffCompleto() de
  core/verification/verdict.mjs, nunca `git diff` a secas.
- El recinto (bubblewrap) exige user namespaces sin privilegios. Sin ellos fallan
  5 pruebas de la suite con mensajes que parecen defectos del verificador.
- Los bancos que tocan la red se corren con dangerouslyDisableSandbox.

LO QUE NO SE HACE, NUNCA
- No se publica nada sin que lo decida una persona. Ningún agente abre un PR.
- No se añaden excepciones al escáner de secretos. Una excepción es una puerta
  trasera que el propio agente vigilado puede escribirse.
- No se declara "verificado" nada que no tenga prueba de cableado CON control
  positivo. Una frontera que "aguanta" porque el agente nunca intentó nada es un
  verde falso, y un banco cuyo control positivo no discrimina no mide nada.
- No se emite `memory:` en el frontmatter de un agente: añade Write y Edit en
  silencio aunque `tools` no los liste.

CÓMO SE TRABAJA AQUÍ
Cada regla nueva necesita su prueba, y las pruebas caras —las que llaman al
modelo— van en bancos aparte, nunca en `npm test`. Un control que cuesta tres
corridas se corre el día que se escribe y nunca más.

Cuando encuentres un defecto, mira primero LA COSTURA entre dos piezas: casi
todos los de este repositorio estaban ahí, no dentro de una pieza. Dos copias de
la misma verdad que se desincronizan es el patrón más repetido.

Y un rojo falso es PEOR que un verde falso: un control que se equivoca con un
motivo plausible se aprende a ignorar, y un control ignorado es peor que no
tenerlo.
```
