// Contract: device lease records on disk (lib/device-lease.js). Files are untrusted input: a parsed record is
// only a LeaseRecord after the `leaseId` check in readHolder.

export interface LeaseHolder {
  agent?: string;
  purpose?: string;
  verb?: string;
  pid?: number;
  pidStart?: string | null;
  hostname?: string;
  cwd?: string;
  worktree?: string | null;
  branch?: string | null;
  claudeSessionId?: string | null;
  /** "interactive" for Studio; absent for a command holder. */
  kind?: 'interactive';
  yieldAfterMs?: number;
  idleReleaseMs?: number;
  /** ISO time of the last user action (interactive holders). */
  activityAt?: string;
  /** A run or install is in flight (interactive holders). */
  busy?: boolean;
  [key: string]: unknown;
}

export interface LeaseDevice {
  key: string;
  host: string;
  port: number | null;
  serialHash: string | null;
}

export interface LeaseRecord {
  schema: number | string;
  leaseId: string;
  mode: string;
  device: LeaseDevice;
  holder: LeaseHolder;
  acquiredAt: string;
  heartbeatAt: string;
  /** null for non-session leases. */
  expiresAt: string | null;
  idleMs: number;
  deadline: string;
  expectMs: number | null;
  [key: string]: unknown;
}

/** Result of readHolder: a record, a corrupt marker, or null (free). */
export type HolderRead =
  | { lease: LeaseRecord; mtimeMs: number; corrupt?: undefined }
  | { corrupt: true; ageMs: number; mtimeMs: number; lease?: undefined }
  | null;

/** One line of events.ndjson. */
export interface LeaseEvent {
  t: string;
  key: string;
  ev: string;
  leaseId?: string;
  agent?: string;
  purpose?: string;
  verb?: string;
  [key: string]: unknown;
}
