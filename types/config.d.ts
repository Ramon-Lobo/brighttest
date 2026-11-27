// Contract: the merged config returned by lib/config.js loadConfig (brighttest.json plus defaults).
// Values read from the user's file are loose until a validator narrows them; optional means "may be absent".

export interface DeviceLeaseConfig {
  pool?: string[];
  [key: string]: unknown;
}

export interface DeviceInfoConfig {
  model?: string;
  osVersion?: string;
  locale?: string;
  uiResolution?: string; // '480p' | '720p' | '1080p', validated at runtime
  connectionType?: string; // 'WiredConnection' | 'WiFiConnection', validated at runtime
  friendlyName?: string;
  country?: string;
}

export interface BuildsConfig {
  dir: string | null;
  record: boolean;
  maxCount: number;
  maxTotalMB: number;
  maxZipMB: number;
}

/** `instrument.net`: the redact block lives here (instrument.net.redact), never at cfg.net.redact. */
export interface InstrumentNetConfig {
  fixtures?: string | string[];
  unmatched?: string;
  upstreamHosts?: string[];
  redact?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InstrumentStateConfig {
  redact?: { paths?: string[] };
  publish?: { maxBytes?: number; intervalMs?: number };
  [key: string]: unknown;
}

export interface InstrumentConfig {
  strict: boolean;
  enabled?: boolean;
  exclude?: string[];
  state?: boolean | InstrumentStateConfig;
  net?: InstrumentNetConfig;
  [key: string]: unknown;
}

export interface BrighttestConfig {
  rootDir: string;
  sourceGlobs: string[];
  testsFilePattern: string;
  stagingDir: string;
  deviceLease: DeviceLeaseConfig;
  instrument: InstrumentConfig;
  builds: BuildsConfig;
  deviceIdleTimeout?: number;
  deviceInfo?: DeviceInfoConfig;
  instrumentExclude?: string[];
  [key: string]: unknown;
}

export interface HeadlessInstrument {
  enabled: boolean;
  state: false | InstrumentStateConfig;
  net: unknown;
  warning?: string;
}
