// Contract: the Claude Code PreToolUse hook JSON that lib/device-hook.js reads and writes.

/** Input on stdin. Anything may be missing or malformed: evaluate() allows on any doubt. */
export interface HookPayload {
  tool_name?: string;
  tool_input?: { command?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Classification {
  decision: 'allow' | 'deny';
  rule: string;
  reason?: string;
}

export interface ClassifyContext {
  hosts?: string[];
  leaseValid?: (token: string) => boolean;
  ports?: number[];
}

export interface HookDenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}
