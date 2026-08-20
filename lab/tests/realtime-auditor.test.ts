import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { readFile, unlink } from "node:fs/promises"
import { existsSync } from "node:fs"

const LOG = "/tmp/opencode-audit.jsonl"

describe("RealtimeAuditor", () => {
  let auditor: any

  beforeEach(async () => {
    if (existsSync(LOG)) await unlink(LOG)

    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    auditor = await mod.RealtimeAuditor()
  })

  afterEach(async () => {
    if (existsSync(LOG)) await unlink(LOG)
  })

  async function readLogLines(): Promise<Record<string, unknown>[]> {
    try {
      const content = await readFile(LOG, "utf8")
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  it("classifyRisk: read = LOW", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    assert.equal(mod.classifyRisk("read", { filePath: "/tmp/test.txt" }), "LOW")
  })

  it("classifyRisk: bash = HIGH", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    assert.equal(mod.classifyRisk("bash", { command: "pwd" }), "HIGH")
  })

  it("classifyRisk: edit = MEDIUM", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    assert.equal(
      mod.classifyRisk("edit", { filePath: "/tmp/test.txt" }),
      "MEDIUM",
    )
  })

  it("classifyRisk: unknown tool = HIGH", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    assert.equal(mod.classifyRisk("mystery_tool", {}), "HIGH")
  })

  it("classifyRisk: .env in args = HIGH", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    assert.equal(
      mod.classifyRisk("read", { filePath: "/home/user/.env" }),
      "HIGH",
    )
  })

  it("classifyRisk: rm -rf in bash = HIGH", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    assert.equal(
      mod.classifyRisk("bash", { command: "rm -rf /tmp/important" }),
      "HIGH",
    )
  })

  it("sanitizeArgs: redacts sensitive keys", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    const result = mod.sanitizeArgs({
      API_KEY: "sk-abc123secret",
      password: "hunter2",
      token: "ghp_abc123",
      name: "jonas",
    })
    assert.equal(result.API_KEY, "[REDACTED]")
    assert.equal(result.password, "[REDACTED]")
    assert.equal(result.token, "[REDACTED]")
    assert.equal(result.name, "jonas")
  })

  it("sanitizeArgs: redacts Bearer tokens in values", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    const result = mod.sanitizeArgs({
      auth: "Bearer eyJhbGciOiJIUzI1NiJ9.test",
    })
    assert.equal(result.auth, "[REDACTED]")
  })

  it("sanitizeArgs: truncates long strings", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    const longStr = "x".repeat(600)
    const result = mod.sanitizeArgs({ command: longStr })
    assert.ok((result.command as string).endsWith("…"))
    assert.ok((result.command as string).length < 600)
  })

  it("sanitizeResult: redacts tokens in output", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    const result = mod.sanitizeResult(
      "Response: Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature",
    )
    assert.ok((result as string).includes("[REDACTED]"))
    assert.ok(!(result as string).includes("eyJhbGciOiJIUzI1NiJ9"))
  })

  it("sanitizeResult: truncates large output", async () => {
    const mod = await import("../.opencode/plugins/realtime-auditor.ts")
    const bigStr = "a".repeat(3000)
    const result = mod.sanitizeResult(bigStr)
    assert.ok((result as string).endsWith("…"))
    assert.ok((result as string).length < 3000)
  })

  it("tool.execute.before logs event", async () => {
    await auditor["tool.execute.before"](
      { sessionID: "s1", callID: "c1", tool: "read" },
      { args: { filePath: "/tmp/test.txt" } },
    )

    const lines = await readLogLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0].event, "tool.before")
    assert.equal(lines[0].tool, "read")
    assert.equal(lines[0].risk, "LOW")
    assert.equal(lines[0].callID, "c1")
    assert.ok(lines[0].timestamp)
  })

  it("tool.execute.after logs event with duration", async () => {
    await auditor["tool.execute.before"](
      { sessionID: "s1", callID: "c2", tool: "bash" },
      { args: { command: "pwd" } },
    )

    await auditor["tool.execute.after"](
      { sessionID: "s1", callID: "c2", tool: "bash" },
      { output: "/home/user", title: "bash", status: "success" },
    )

    const lines = await readLogLines()
    assert.equal(lines.length, 2)
    assert.equal(lines[1].event, "tool.after")
    assert.equal(lines[1].durationMs >= 0, true)
    assert.equal(lines[1].risk, "HIGH")
    assert.equal(lines[1].result, "/home/user")
    assert.equal(lines[1].status, "success")
  })

  it("tool.execute.before: API_KEY in args is redacted", async () => {
    await auditor["tool.execute.before"](
      { sessionID: "s1", callID: "c3", tool: "bash" },
      {
        args: {
          command: 'curl -H "Authorization: Bearer sk-test123456789" https://api.example.com',
        },
      },
    )

    const lines = await readLogLines()
    assert.equal(lines.length, 1)
    const args = lines[0].args as Record<string, unknown>
    assert.ok((args.command as string).includes("[REDACTED]"))
  })

  it("tool.execute.before: .env path = HIGH risk", async () => {
    await auditor["tool.execute.before"](
      { sessionID: "s1", callID: "c4", tool: "read" },
      { args: { filePath: "/home/user/.env" } },
    )

    const lines = await readLogLines()
    assert.equal(lines[0].risk, "HIGH")
  })
})
