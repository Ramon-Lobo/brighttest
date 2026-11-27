// Type-only pins for the contract types (TS-A1). Run by `npm run typecheck` (tsconfig.strict.json), not by Vitest.
// A line marked @ts-expect-error fails the check when it STOPS being an error, so each one pins a mistake that must
// stay a mistake.
import type { BrighttestConfig } from '../../types/config';
import type { NullableHubCtl } from '../../types/hub-events';
import type { HolderRead } from '../../types/lease';

declare const cfg: BrighttestConfig;
declare const hubCtl: NullableHubCtl;
declare const holder: HolderRead;

// instrument.net.redact is the config path (net-headless reads instrument.net.redact).
export const redact = cfg.instrument.net?.redact;
// @ts-expect-error there is no top-level cfg.net.redact (the E-2140 era mistake).
export const wrongRedact = cfg.net.redact;

// E-2140: Studio's hubCtl is nullable. Calling it without a null check must not compile.
// @ts-expect-error hubCtl may be null.
export const unguarded = hubCtl.ready();
export const guarded = hubCtl ? hubCtl.ready() : undefined;
export const optional = hubCtl?.message();

// A holder read is null (free), a record, or a corrupt marker: the record is only there after a narrowing check.
// @ts-expect-error holder may be null.
export const unguardedLease = holder.lease;
export const leaseId = holder && holder.lease ? holder.lease.leaseId : null;
