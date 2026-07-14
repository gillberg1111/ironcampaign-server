import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, seedVillain } from './helpers.js';
import { runDecaySweep } from '../src/services/decay.js';
import { SqliteStorageAdapter } from '../src/sync/adapter.js';
import { applyBatch } from '../../questlog-critical/hlc-merge/merge.js';

describe('Decay', () => {
  it('villain idle 15 days → heals and emits events', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000); // domain timestamps are SECONDS
    const fifteenDaysAgo = now - (15 * 24 * 60 * 60) - 1;

    seedVillain(db, 'p1', { uuid: 'v1', hp: 50, max_hp: 100, last_session_at: fifteenDaysAgo });

    const affected = runDecaySweep(db);
    assert.equal(affected, 1);

    const villain = db.prepare('SELECT hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'p1');
    assert.equal(villain.hp, 55, 'hp increased by DECAY_HP_PER_INTERVAL (5)');

    const event = db.prepare(
      'SELECT * FROM villain_events WHERE villain_uuid = ? AND profile_uuid = ? AND reason = ?'
    ).get('v1', 'p1', 'decay');
    assert.ok(event, 'decay event inserted');
    assert.equal(event.damage, 0);
    assert.equal(event.xp, 0);

    const log = db.prepare(
      'SELECT * FROM change_log WHERE profile_uuid = ? AND table_name = ? AND row_uuid = ?'
    ).all('p1', 'villains', 'v1');
    assert.ok(log.length > 0, 'change_log entry for hp change');

    const allLogs = db.prepare('SELECT device_id FROM change_log WHERE profile_uuid = ?').all('p1');
    for (const l of allLogs) assert.equal(l.device_id, 'server-decay');
  });

  it('field_meta consistency: decay wins over lower device HLC', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000); // domain timestamps are SECONDS
    const fifteenDaysAgo = now - (15 * 24 * 60 * 60) - 1;

    seedVillain(db, 'p1', { uuid: 'v1', hp: 50, max_hp: 100, last_session_at: fifteenDaysAgo });

    runDecaySweep(db);

    const meta = db.prepare(
      'SELECT hlc, device_id FROM field_meta WHERE profile_uuid = ? AND table_name = ? AND row_uuid = ? AND field_name = ?'
    ).get('p1', 'villains', 'v1', 'hp');
    assert.ok(meta, 'field_meta entry for hp after decay');
    assert.equal(meta.device_id, 'server-decay');

    const store = new SqliteStorageAdapter(db, 'p1');

    // Decay's HLC is derived from real Date.now(), so comparison HLCs must be built relative to it
    // (a hardcoded past timestamp would always be below decay and give a false pass).
    const bumpMs = (hlc, delta) =>
      (parseInt(hlc.slice(0, 12), 16) + delta).toString(16).padStart(12, '0') + hlc.slice(12);

    const lowerDeviceChange = {
      table: 'villains', uuid: 'v1', field: 'hp', value: 10,
      hlc: bumpMs(meta.hlc, -1000), deviceId: 'dev-a',
    };
    const r1 = applyBatch(store, [lowerDeviceChange]);
    assert.equal(r1[0].decision, 'ignored-older', 'lower HLC should be ignored after decay');

    const higherDeviceChange = {
      table: 'villains', uuid: 'v1', field: 'hp', value: 80,
      hlc: bumpMs(meta.hlc, 1000), deviceId: 'dev-a',
    };
    const r2 = applyBatch(store, [higherDeviceChange]);
    assert.equal(r2[0].decision, 'applied', 'higher HLC should apply');
  });

  it('villain idle 10 days → untouched', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000); // domain timestamps are SECONDS
    const tenDaysAgo = now - (10 * 24 * 60 * 60);

    seedVillain(db, 'p1', { uuid: 'v1', hp: 50, max_hp: 100, last_session_at: tenDaysAgo });

    const affected = runDecaySweep(db);
    assert.equal(affected, 0);

    const villain = db.prepare('SELECT hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'p1');
    assert.equal(villain.hp, 50);

    const events = db.prepare(
      'SELECT COUNT(*) as c FROM villain_events WHERE villain_uuid = ? AND profile_uuid = ?'
    ).get('v1', 'p1');
    assert.equal(events.c, 0);
  });

  it('hp=0, active=0, deleted=1, or null last_session_at → never decays', () => {
    const db = makeDb();
    const now = Date.now();
    const sixteenDaysAgo = now - (16 * 24 * 60 * 60 * 1000);

    seedVillain(db, 'p1', { uuid: 'v0', hp: 0, last_session_at: sixteenDaysAgo });
    seedVillain(db, 'p1', { uuid: 'vInactive', hp: 50, active: 0, last_session_at: sixteenDaysAgo });
    seedVillain(db, 'p1', { uuid: 'vDeleted', hp: 50, deleted: 1, last_session_at: sixteenDaysAgo });
    seedVillain(db, 'p1', { uuid: 'vNoSession', hp: 50, last_session_at: null });

    const affected = runDecaySweep(db);
    assert.equal(affected, 0);
  });

  it('idempotent progression: two sweeps both heal, cap at max_hp', () => {
    const db = makeDb();
    const now = Math.floor(Date.now() / 1000); // domain timestamps are SECONDS
    const sixteenDaysAgo = now - (16 * 24 * 60 * 60);

    seedVillain(db, 'p1', { uuid: 'v1', hp: 90, max_hp: 100, last_session_at: sixteenDaysAgo });

    runDecaySweep(db);

    let villain = db.prepare('SELECT hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'p1');
    assert.equal(villain.hp, 95);

    villain.last_session_at = sixteenDaysAgo;
    db.prepare('UPDATE villains SET hp = ?, last_session_at = ? WHERE uuid = ? AND profile_uuid = ?')
      .run(95, sixteenDaysAgo, 'v1', 'p1');

    runDecaySweep(db);

    villain = db.prepare('SELECT hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'p1');
    assert.equal(villain.hp, 100, 'capped at max_hp');
  });
});
