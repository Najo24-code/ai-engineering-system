import { appendFile } from "node:fs/promises"

const LOG = "/tmp/opencode-audit.jsonl"

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH"

interface ToolCall {
  sessionID: string
  callID: string
  tool: string
}

interface ToolCallArgs {
  args?: Record<string, unknown>
}

interface ToolResult {
  output?: string
  title?: string
  status?: string
}

const SENSITIVE_KEYS = [
  "api_key",
  "apikey",
  "API_KEY",
  "password",
  "PASSWORD",
  "token",
  "TOKEN",
  "secret",
  "SECRET",
  "authorization",
  "Authorization",
]

const SENSITIVE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9_\-.=]+/g,
  /sk-[A-Za-z0-9]+/g,
  /ghp_[A-Za-z0-9]+/g,
]

export function classifyRisk(
  tool: string,
  args: Record<string, unknown>,
): RiskLevel {
  const filePath = args.filePath as string | undefined
  const cmd = args.command as string | undefined

  if (filePath && /\.env($|\/)/.test(filePath)) {
    return "HIGH"
  }

  if (cmd && /rm\s+-rf/.test(cmd)) {
    return "HIGH"
  }

  switch (tool) {
    case "read":
      return "LOW"
    case "edit":
      return "MEDIUM"
    case "bash":
      return "HIGH"
    default:
      return "HIGH"
  }
}

export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEYS.includes(key)) {
      result[key] = "[REDACTED]"
      continue
    }

    if (typeof value === "string") {
      let sanitized = value

      for (const pattern of SENSITIVE_PATTERNS) {
        sanitized = sanitized.replace(pattern, "[REDACTED]")
      }

      if (sanitized.length > 500) {
        sanitized = sanitized.slice(0, 500) + "…"
      }

      result[key] = sanitized
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizeArgs(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }

  return result
}

export function sanitizeResult(result: unknown): unknown {
  if (typeof result === "string") {
    let sanitized = result

    for (const pattern of SENSITIVE_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]")
    }

    if (sanitized.length > 2000) {
      sanitized = sanitized.slice(0, 2000) + "…"
    }

    return sanitized
  }

  if (Array.isArray(result)) {
    return result.map(sanitizeResult)
  }

  if (typeof result === "object" && result !== null) {
    const output: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(result)) {
      output[key] = sanitizeResult(value)
    }

    return output
  }

  return result
}

const sessions: Record<string, { start: number; risk?: RiskLevel; tool?: string }> = {}

async function logEvent(entry: Record<string, unknown>): Promise<void> {
  try {
    const line = JSON.stringify(entry) + "\n"
    await appendFile(LOG, line)
  } catch {
    // Silently fail logging
  }
}

export const RealtimeAuditor = async () => ({
  "tool.execute.before": async (ctx: ToolCall, call: ToolCallArgs) => {
    const risk = classifyRisk(ctx.tool, call.args ?? {})
    sessions[ctx.callID] = {
      start: Date.now(),
      risk,
      tool: ctx.tool,
    }

    await logEvent({
      sessionID: ctx.sessionID,
      callID: ctx.callID,
      tool: ctx.tool,
      event: "tool.before",
      risk,
      args: sanitizeArgs(call.args ?? {}),
      timestamp: new Date().toISOString(),
    })
  },

  "tool.execute.after": async (ctx: ToolCall, result: ToolResult & { output?: unknown }) => {
    const session = sessions[ctx.callID]

    await logEvent({
      sessionID: ctx.sessionID,
      callID: ctx.callID,
      tool: ctx.tool,
      event: "tool.after",
      risk: session?.risk ?? "HIGH",
      durationMs: session ? Date.now() - session.start : 0,
      result: sanitizeResult(result.output ?? result.title),
      status: result.status ?? "unknown",
      timestamp: new Date().toISOString(),
    })

    delete sessions[ctx.callID]
  },
})

export default RealtimeAuditor
