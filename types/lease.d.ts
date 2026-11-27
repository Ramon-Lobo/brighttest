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
