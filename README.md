<h1 align="center">
  <code>AI ENGINEERING SYSTEM</code>
</h1>

<p align="center">
  <em>Multi-agent software engineering: boundaries that are proven, not declared.</em>
</p>

<p align="center">
  <a href="https://github.com/Najo24-code/ai-engineering-system/actions/workflows/ci.yml">
    <img src="https://github.com/Najo24-code/ai-engineering-system/actions/workflows/ci.yml/badge.svg" alt="ci">
  </a>
  <img src="https://img.shields.io/badge/license-MIT-3fb950?style=flat-square&labelColor=0d1117" alt="MIT">
  <img src="https://img.shields.io/badge/node-22+-339933?style=flat-square&labelColor=0d1117" alt="Node 22+">
  <img src="https://img.shields.io/badge/phase-7_7-58a6ff?style=flat-square&labelColor=0d1117" alt="7/7 phases closed">
</p>

---

```text
$ cat /etc/motd
```

An agent is not defined by its prompt, but by what it **cannot** do
and what another mechanism **verifies** about its work.

> **A policy without a wiring test is considered NOT implemented.**
> Unit tests are not enough. You must prove, with the system running,
> that the forbidden action actually fails — with positive control,
> because a lazy agent and a solid boundary produce the same result.

Writing the rule and wiring the rule are two different jobs. Only the second protects something.

---

## `$ tree .`

```text
agents/       agent contracts, portable            (source of truth)
core/
  policies/     permission rules wired to hooks
  sandbox/      the enclosure: forbidden is not denied, it is impossible
  verification/ the one that measures and does not believe
  flow/         the stages of the cycle, triggered by a person
runtimes/
  opencode/   OpenCode adapter + policy gate plugin
  claude-code/  Claude Code adapter
lab/          test bench: the repo agents work on
docs/
  ARCHITECTURE.md  the five layers and where each blocks
  ROADMAP.md       the seven phases and the gate for each
  audits/          one report per phase; without it the phase stays open
```

Dependency rule: `agents/` imports nothing from `runtimes/`. When the runtime
changes, rewrite an adapter — not the agents.

---

## `$ cat cycle.md` — the loop

```text
ISSUE -> RECON -> BUILD -> [verifier] -> REVIEW -> (reject) -> BUILD
        understand  measure     judge
                                    -> [publish] -> PR
```

Enters through a GitHub issue, exits through a pull request. Both endpoints
are deterministic code, not agents: **no agent opens a PR**, because publishing
requires verifying things the one who did the work cannot verify about itself.

Between stages, a person presses the button. The orchestrator is Phase 5;
until the cycle is boringly reliable, automating the trigger only helps
you make mistakes faster.

| Agent | Can | Cannot |
|---|---|---|
| **RECON** | read | write, execute, delegate |
| **BUILD** | write where the project says, run verification | go out of scope, touch secrets or CI, install, commit |
| **REVIEW** | read | **modify nothing**, **execute nothing** — not even tests |

REVIEW not running the tests is deliberate: if it ran them and reported the
result, the system would again depend on an agent telling the truth about
the tests. The verifier measures that — and the verifier is not an agent.

---

## `$ layers --show` — the five control layers

Each layer is backed by evidence in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

| Layer | Name | Mechanism |
|---|---|---|
| **A** | Declarative | The runtime does not hand over the tool |
| **B** | Programmatic | The policy gate decides per route, per command, per call |
| **C** | Observational | Audits; does not block |
| **D** | The Enclosure | `core/sandbox/` — bubblewrap. Forbidden is not denied: it is **impossible** |
| **E** | The Verifier | `core/verification/verdict.mjs`. Does not block actions: rejects **claims** |

The verifier measures five things:

1. The full test suite (runs it, in isolation)
2. Suite regression (catches deleted-red-test state)
3. Diff scope
4. Secrets introduced
5. Report citations

---

## `$ cd /any/project` — point it at yours

### Prerequisites

Measured 2026-08-26 on a clean install from scratch. Not remembered.

| What | Why | How |
|---|---|---|
| `node` 22+ | the entire system | — |
| `git` | the verifier compares the tree against `HEAD` | `apt install git` |
| `bwrap` (bubblewrap) | **the enclosure** — 5 tests fail without it | `apt install bubblewrap` |
| `opencode` | the runtime | `curl -fsSL https://opencode.ai/install \| bash` |
| provider credential | model calls | `opencode auth login` |
| `gh` authenticated | **only** for `publicar.mjs` | `gh auth login` |

> **The credential does NOT go in the environment.** OpenCode Zen's credential
> lives where `opencode auth login` leaves it (`~/.local/share/opencode/auth.json`).

> **The enclosure requires user namespaces without privileges.** Without them
> `bwrap` does not start and **five `npm test` tests fail with messages that
> look like verifier defects.** Inside a container:

```bash
docker run --security-opt seccomp=unconfined \
           --security-opt apparmor=unconfined \
           --security-opt systempaths=unconfined ...
```

### The five steps

```bash
# 1. install the system in the project (creates its .opencode/)
node runtimes/opencode/sync.mjs --en /path/to/your-project \
  --alcance "server/**" --comandos "venv/bin/python -m pytest server/ -q"

# 2. RECON understands, BUILD implements — from an issue or a phrase
node core/flow/recon-build.mjs --target /path/to/your-project --issue 12
node core/flow/recon-build.mjs --target /path/to/your-project \
  --task "what needs to be done, in one sentence"

# 3. the verifier measures, REVIEW judges
node core/flow/review.mjs --run runs/<date>

# 4. if REVIEW rejects, work goes back to BUILD
node core/flow/rework.mjs --run runs/<date>
node core/flow/review.mjs --run runs/<date>/vuelta-2

# 5. if everything is green, publish. Without --confirmar it only says what it would do.
node core/flow/publicar.mjs --run runs/<date>
node core/flow/publicar.mjs --run runs/<date> --confirmar
```

Step 5 refuses to publish if there is no dictamen, if the dictamen was
discarded, if the verifier measured REJECTED, or if **the tree is no longer
the one that was verified** — it seals the content of every touched file
at measure-time and rechecks at publish-time.

Each run leaves `runs/<date>/` with what RECON understood, what BUILD says it
did, **what it actually did** (`cambios.diff`), what the policy denied, what was
measured, and what REVIEW ruled. `runs/` is not versioned.

---

## `$ npm test` — verify the boundaries still hold

```bash
npm test                  # 271 tests, ~1 s, ZERO provider calls
npm run gate:contencion   # the enclosure: 13 deterministic attacks, costs zero
npm run relevo            # regenerates runtimes/opencode/eleccion.json (gitignored)
npm run sync              # materializes lab/.opencode/ (gitignored)
npm run sync:check        # does installed match what sync just wrote?
```

The five above can run anytime. The ones that call the model (`wiring.mjs`
and `boundary.mjs`) cost real runs and are not part of `npm test`:
a suite that spends provider quota stops getting run,
and a suite that does not get run protects nothing.

---

## `$ phases` — status

| Phase | What it tests | Status |
|---|---|---|
| 0 · Foundation | know what's there | **closed** |
| 1 · Enclosed agent | that the boundary is real | **closed** |
| 2 · Write boundary | that BUILD stays in scope | **closed** |
| 3 · Verification | that the system does not believe | **closed** |
| 4 · Three-agent cycle | RECON -> BUILD -> REVIEW | **closed** |
| 5 · Orchestration | that ATLAS decides, not the model choosing routes | **closed** |
| 6 · Portability | that it survives outside OpenCode | **closed** |

**All seven phases of the original plan are closed** (2026-08-26).
Issue `Najo24-code/yunque#1` entered alone and left as a PR (`yunque#2`),
with a rejection round that required a real defect, not a simulated one.

Details in [`docs/ROADMAP.md`](docs/ROADMAP.md); one report per phase in
[`docs/audits/`](docs/audits/).

A phase does not close without its report. If the gate fails, the phase
stays open. No skipping ahead "while we're at it."

---

## `$ license`

[MIT](LICENSE)
