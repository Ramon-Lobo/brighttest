// Contract: the brighttest-mcp/v1 tool definitions (lib/mcp/tools.js and the state and perf tool files).

/** The JSON Schema subset the tools use and `validate` understands. */
export interface ToolSchema {
  type?: string;
  properties?: Record<string, ToolSchema>;
  required?: string[];
  additionalProperties?: boolean | ToolSchema;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minProperties?: number;
  items?: ToolSchema;
  enum?: unknown[];
  description?: string;
  [key: string]: unknown;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: ToolSchema;
  [key: string]: unknown;
}

/** Errors thrown by tool handlers carry a typed `code` that becomes the tool result error code. */
export interface ToolError extends Error {
  code: string;
}
