import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

// Spec v2.11 §5 — server-side coverage for the first post-v2.3 full-stack schema change.
describe('Schema v5 (sagas.current_chapter_uuid)', () => {
  it('migration is idempotent and adds the column', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db); // second run must be a no-op, not a crash
    const cols = db.pragma('table_info(sagas)').map(c => c.name);
    assert.ok(cols.includes('current_chapter_uuid'));
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 18);
  });

  it('registry allows the new field (and still rejects unknowns)', () => {
    assert.ok(REGISTRY.sagas.mutableFields.includes('current_chapter_uuid'));
    assert.doesNotThrow(() => assertAllowed('sagas', 'current_chapter_uuid'));
    assert.throws(() => assertAllowed('sagas', 'bogus_field'));
  });

  it('current_chapter_uuid round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      const push = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'sagas', uuid: 's1', field: 'name', value: 'Foundation', hlc: '019077fd307b0001', deviceId: 'dev-a' },
          { table: 'sagas', uuid: 's1', field: 'current_chapter_uuid', value: 'ch-2', hlc: '019077fd307b0002', deviceId: 'dev-a' },
        ],
      }, authHeader(token));
      assert.equal(push.data.applied, 2);

      const row = db.prepare('SELECT current_chapter_uuid FROM sagas WHERE uuid = ?').get('s1');
      assert.equal(row.current_chapter_uuid, 'ch-2');

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const chapterChange = pull.data.changes.find(c => c.field === 'current_chapter_uuid');
      assert.equal(chapterChange.value, 'ch-2');
    } finally { srv.close(); }
  });
});
