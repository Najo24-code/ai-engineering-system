interface ToolCallArgs {
  command?: string
  filePath?: string
  [key: string]: unknown
}

const DENY_PATTERNS: RegExp[] = [
  /^\s*rm\s+-rf\s+\/$/,
  /^\s*rm\s+-rf\s+~/,
  /^\s*mkfs\./,
  /^\s*fdisk\s/,
  /^\s*dd\s+if=/,
  /^\s*shutdown\s/,
  /^\s*reboot/,
  /git\s+push\s+.*--force/,
  /git\s+push\s+-f\s/,
  /git\s+reset\s+--hard/,
  /chmod\s+-R\s+777/,
  /curl\s+.*\|\s*sh\b/,
  /wget\s+.*\|\s*sh\b/,
  /curl\s+.*\|\s*bash\b/,
  /wget\s+.*\|\s*bash\b/,
]

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH"

export type Action = "allow" | "ask" | "deny"

export interface PolicyDecision {
  action: Action
  risk: RiskLevel
}

export function isDenied(args: ToolCallArgs): boolean {
  const cmd = args.command ?? ""
  return DENY_PATTERNS.some((pattern) => pattern.test(cmd))
}

export function actionForRisk(risk: RiskLevel): Action {
  if (risk === "LOW") return "allow"
  return "ask"
}

export function evaluatePolicy(risk: RiskLevel, args: ToolCallArgs): PolicyDecision {
  if (risk === "LOW" && isDenied(args)) {
    return { action: "deny", risk }
  }

  if (risk === "MEDIUM" && isDenied(args)) {
    return { action: "deny", risk }
  }

  if (risk === "HIGH" && isDenied(args)) {
    return { action: "deny", risk }
  }

  return { action: actionForRisk(risk), risk }
}

export const PolicyGate = async () => ({
  tool: {
    policy_gate: {
      description: "Evaluates tool calls against security policy",
      args: {},
      async execute() {
        return { status: "ready" }
      },
    },
  },
})

export default PolicyGate
