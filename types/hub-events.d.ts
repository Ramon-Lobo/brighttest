// Contract: instrument hub events and commands (lib/instrument/events.js) and the hub controller Studio holds.

export type EventSource = 'agent' | 'hub' | 'runner';

/** An event as pushed to the log. `data` is device or app data: unknown until a validator narrows it. */
export interface HubEventInput {
  v?: 1;
  src?: EventSource;
  kind: string;
  ts?: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HubEvent extends HubEventInput {
  v: 1;
  seq: number;
  ts: number;
  session: string;
}

export interface HubCommand {
  op: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EventLogOptions {
  sessionId?: string;
  sessionDir?: string | null;
  max?: number;
  redactPaths?: string[];
}

export interface EventLog {
  file: string | null;
  push(ev: HubEventInput): HubEvent;
  since(after?: number): HubEvent[];
  readonly size: number;
  readonly lastSeq: number;
}

/** Shape of `net` as Studio sees it once a hub is up. Loose on purpose: only what callers null-check. */
export interface HubNet {
  proxy?: unknown;
  events?: unknown;
  hub?: { stateOps?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Studio's hub controller. The variable holding it is nullable (E-2140): callers must check it before
 * `ready()`, `net()` or `message()`.
 */
export interface HubCtl {
  ready(): Promise<void>;
  net(): HubNet | null;
  message(): string | null;
}

export type NullableHubCtl = HubCtl | null;
