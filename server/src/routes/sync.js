import { Router } from 'express';
import { applyBatch } from '../../../questlog-critical/hlc-merge/merge.js';
import { SqliteStorageAdapter } from '../sync/adapter.js';
import { REGISTRY, assertAllowed, validateAppendColumns } from '../sync/registry.js';
import { makeAuth } from '../middleware/auth.js';
import { verifyAndConsumePairing, createPairing, revokeDevice } from '../../../questlog-critical/sync-auth/pairing.js';
import { bootstrapSnapshot } from '../services/compaction.js';

export default function syncRoutes(db) {
  const router = Router();
  const auth = makeAuth(db);

  const pairCreateLimit = new Map();

  function rateLimitPairCreate(ip) {
    const now = Date.now();
    const WINDOW_MS = 15 * 60 * 1000;
    const MAX = 10;
    const a = pairCreateLimit.get(ip);
    if (!a || now - a.windowStart > WINDOW_MS) {
      pairCreateLimit.set(ip, { count: 1, windowStart: now });
      return;
    }
    a.count += 1;
    if (a.count > MAX) { const e = new Error('rate limited'); e.status = 429; throw e; }
  }

  router.post('/sync/push', auth, (req, res) => {
    try {
    const { changes } = req.body;
    const profileUuid = req.profileUuid;

    if (!Array.isArray(changes) || changes.length === 0) {
      return res.json({ applied: 0, ignored: 0, results: [] });
    }
    // Explicit batch cap (mirrors the pull window; the client batches at 500 anyway). The 1MB
    // body limit bounds this incidentally — this makes the transaction size a contract.
    if (changes.length > 500) {
      return res.status(413).json({ error: 'batch too large (max 500 changes)' });
    }

    for (const c of changes) {
      assertAllowed(c.table, c.field);
      const entry = REGISTRY[c.table];
      if (entry && entry.appendOnly && typeof c.value === 'object' && c.value !== null) {
        validateAppendColumns(c.table, c.value);
      }
    }

    const store = new SqliteStorageAdapter(db, profileUuid);

    const apply = db.transaction(() => {
      const results = applyBatch(store, changes);
      const now = Date.now();
      const insertLog = db.prepare(
        `INSERT INTO change_log (profile_uuid, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const { change, decision } of results) {
        if (decision === 'applied' || decision === 'appended' || decision === 'undeleted') {
          insertLog.run(
            profileUuid,
            change.table,
            change.uuid,
            change.field,
            JSON.stringify(change.value),
            change.hlc,
            change.deviceId,
            change.changeId ?? null,
            now
          );
        }
      }

      const accepted = results.filter(r =>
        r.decision === 'applied' || r.decision === 'appended' || r.decision === 'undeleted'
      ).length;

      return {
        applied: accepted,
        ignored: results.length - accepted,
        results: results.map(r => ({ uuid: r.change.uuid, field: r.change.field, decision: r.decision })),
      };
    });

    res.json(apply());
    } catch (e) {
      const status = e.status || 500;
      res.status(status).json({ error: status === 500 ? 'internal error' : e.message });
    }
  });

  router.post('/sync/changes', auth, (req, res) => {
    const profileUuid = req.profileUuid;
    const since = typeof req.body.since === 'number' ? req.body.since : 0;
    // Optional echo suppression (spec v2.9): the caller's own device UUID. This is client-asserted
    // DATA, not identity (identity is the token) — a lying client only misfilters its own view, and
    // merge idempotency makes that correctness-neutral. Never use it for authorization.
    const excludeDeviceId = typeof req.body.deviceId === 'string' && req.body.deviceId.length > 0
      ? req.body.deviceId : null;

    // Persist the device's reported cursor (spec v2.49 compaction).
    if (req.deviceTokenId !== undefined && since > 0) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO device_cursors (profile_uuid, device_token_id, cursor_seq, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_uuid, device_token_id)
         DO UPDATE SET cursor_seq = MAX(cursor_seq, ?), last_seen_at = ?`
      ).run(profileUuid, req.deviceTokenId, since, now, since, now);
    }

    // Check for cursor expiry (spec v2.49): if the device's cursor is behind what exists in
    // change_log (rows were compacted), signal 410. The returned minSeq is the cursor the client
    // should reset to (oldest surviving seq minus 1) so it can resume pulling from that point.
    // DOCUMENTED v1 LIMITATION (spec §1): a device only reaches here if it was excluded from the
    // compaction MIN — i.e. offline past the 90-day window. Any changes OTHER devices made during
    // that absence were compacted and are NOT re-delivered by this reset; that device stays behind
    // on them until it re-pairs (which runs bootstrapSnapshot). Fully closing the gap needs
    // per-field field_meta HLCs on the bootstrap + a re-bootstrap on 410 — deferred.
    if (since > 0) {
      const minSeqRow = db.prepare(
        'SELECT MIN(seq) as min_seq FROM change_log WHERE profile_uuid = ?'
      ).get(profileUuid);
      const minSeq = minSeqRow?.min_seq ?? null;
      if (minSeq !== null && since < minSeq - 1) {
        return res.status(410).json({ error: 'cursor expired', minSeq: minSeq - 1 });
      }
    }

    const rows = db.prepare(
      'SELECT seq, table_name, row_uuid, field_name, value_json, hlc, device_id, change_id FROM change_log WHERE profile_uuid = ? AND seq > ? ORDER BY seq ASC LIMIT 500'
    ).all(profileUuid, since);

    // LOAD-BEARING: lastSeq reflects the SCANNED window, never the filtered result — a window
    // composed entirely of the caller's own changes must still advance the client's cursor, or
    // pagination stalls forever on that window.
    const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : since;

    const visible = excludeDeviceId ? rows.filter(r => r.device_id !== excludeDeviceId) : rows;

    const changes = visible.map(r => ({
      seq: r.seq,
      table: r.table_name,
      uuid: r.row_uuid,
      field: r.field_name,
      value: JSON.parse(r.value_json ?? 'null'),
      hlc: r.hlc,
      deviceId: r.device_id,
      changeId: r.change_id,
    }));

    res.json({ changes, lastSeq });
  });

  router.get('/sync/status', auth, (req, res) => {
    const profileUuid = req.profileUuid;
    const row = db.prepare(
      'SELECT MAX(seq) as s FROM change_log WHERE profile_uuid = ?'
    ).get(profileUuid);
    res.json({ lastSeq: row?.s ?? 0 });
  });

  router.post('/sync/pair', async (req, res) => {
    try {
      const { phrase, deviceName } = req.body;
      const result = await verifyAndConsumePairing(db, phrase ?? '', deviceName ?? '', req.ip);
      // Bootstrap snapshot for post-compaction convergence (spec v2.49): new devices need current
      // materialized state when older change_log rows have been compacted away.
      bootstrapSnapshot(db, result.profileUuid);
      res.json({ token: result.token, profileUuid: result.profileUuid });
    } catch (e) {
      const status = e.status || 500;
      res.status(status).json({ error: status === 500 ? 'internal error' : e.message });
    }
  });

  router.post('/sync/pairings', auth, async (req, res) => {
    try {
      rateLimitPairCreate(req.ip);
      const { phrase, expiresAt } = await createPairing(db, req.profileUuid);
      res.json({ phrase, expiresAt });
    } catch (e) {
      const status = e.status || 500;
      res.status(status).json({ error: status === 500 ? 'internal error' : e.message });
    }
  });

  router.get('/sync/devices', auth, (req, res) => {
    const rows = db.prepare(
      'SELECT id, device_name, created_at, last_seen_at, revoked_at FROM device_tokens WHERE profile_uuid = ? ORDER BY created_at DESC'
    ).all(req.profileUuid);
    res.json({ devices: rows });
  });

  router.post('/sync/devices/:id/revoke', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'invalid device id' });
    }

    const target = db.prepare(
      'SELECT id FROM device_tokens WHERE id = ? AND profile_uuid = ?'
    ).get(id, req.profileUuid);

    if (!target) {
      return res.status(404).json({ error: 'device not found' });
    }

    const revoked = revokeDevice(db, id);
    res.json({ revoked });
  });

  return router;
}
