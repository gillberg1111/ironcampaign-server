// questlog — Hybrid Logical Clock (HLC)
// Spec §5.1. MUST behave identically to HLC.swift. Verified by test-vectors.json.
// Representation: 16-char lowercase hex string = 48-bit wallclock ms + 16-bit counter.
// Fixed-width hex means lexicographic order === numeric order. Ties broken by deviceId (caller).

import { randomUUID } from 'node:crypto';

const MAX_COUNTER = 0xffff;
const MAX_DRIFT_MS = 60_000; // refuse remote clocks >60s ahead of us (corruption guard)

/** @param {number} ms @param {number} counter @returns {string} */
export function pack(ms, counter) {
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffffffffffff) throw new Error('hlc: ms out of range');
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) throw new Error('hlc: counter out of range');
  return ms.toString(16).padStart(12, '0') + counter.toString(16).padStart(4, '0');
}

/** @param {string} hlc @returns {{ms:number, counter:number}} */
export function unpack(hlc) {
  if (typeof hlc !== 'string' || !/^[0-9a-f]{16}$/.test(hlc)) throw new Error('hlc: malformed');
  return { ms: parseInt(hlc.slice(0, 12), 16), counter: parseInt(hlc.slice(12), 16) };
}

/** Compare two HLCs. Returns -1|0|1. Deterministic tie-break by deviceId if provided. */
export function compare(a, b, deviceA = '', deviceB = '') {
  if (a < b) return -1;
  if (a > b) return 1;
  if (deviceA < deviceB) return -1;
  if (deviceA > deviceB) return 1;
  return 0;
}

export class HLC {
  /**
   * @param {string} deviceId stable per-device UUID
   * @param {string|null} persisted last issued HLC (restore across restarts — REQUIRED for monotonicity)
   * @param {() => number} now injectable clock for tests
   */
  constructor(deviceId, persisted = null, now = Date.now) {
    this.deviceId = deviceId || randomUUID();
    this._now = now;
    const p = persisted ? unpack(persisted) : { ms: 0, counter: 0 };
    this.ms = p.ms;
    this.counter = p.counter;
  }

  /** Issue a new local timestamp (call for every local write). Monotonic even if wall clock regresses. */
  tick() {
    const wall = this._now();
    if (wall > this.ms) { this.ms = wall; this.counter = 0; }
    else {
      this.counter += 1;
      if (this.counter > MAX_COUNTER) { this.ms += 1; this.counter = 0; } // overflow: borrow 1ms
    }
    return pack(this.ms, this.counter);
  }

  /** Observe a remote HLC (call for every applied remote change). Keeps local clock ≥ everything seen. */
  receive(remote) {
    const r = unpack(remote);
    const wall = this._now();
    // Drift guard vs everything we know (wall AND local state): a locally-regressed wall clock
    // must not cause rejection of timestamps we've already legitimately observed.
    if (r.ms > Math.max(wall, this.ms) + MAX_DRIFT_MS) throw new Error('hlc: remote clock too far ahead; refusing');
    if (wall > this.ms && wall > r.ms) { this.ms = wall; this.counter = 0; }
    else if (r.ms > this.ms) { this.ms = r.ms; this.counter = r.counter + 1; }
    else if (r.ms === this.ms) { this.counter = Math.max(this.counter, r.counter) + 1; }
    else { this.counter += 1; }
    if (this.counter > MAX_COUNTER) { this.ms += 1; this.counter = 0; }
    return pack(this.ms, this.counter);
  }

  /** Current value for persistence (store on every tick/receive; restore in constructor). */
  current() { return pack(this.ms, this.counter); }
}
