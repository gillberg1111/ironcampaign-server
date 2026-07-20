import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v15 (foe_catalog.description)', () => {
  it('migration is idempotent and adds the column', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 20);

    const cols = db.pragma('table_info(foe_catalog)').map(c => c.name);
    assert.ok(cols.includes('description'));
  });

  it('registry allows the description field and rejects unknowns', () => {
    assert.ok(REGISTRY.foe_catalog.mutableFields.includes('description'));
    assert.ok(REGISTRY.foe_catalog.columns.includes('description'));
    assert.doesNotThrow(() => assertAllowed('foe_catalog', 'description'));
    assert.throws(() => assertAllowed('foe_catalog', 'bogus_field'), /not mutable/);
  });

  it('description round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const push = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'foe_catalog', uuid: 'fc-1', field: 'name', value: 'Test Foe', hlc: '019077fd307b0001', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-1', field: 'tier', value: 'minion', hlc: '019077fd307b0002', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-1', field: 'max_hp', value: 40, hlc: '019077fd307b0003', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-1', field: 'xp_reward', value: 20, hlc: '019077fd307b0004', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-1', field: 'encounter_weight', value: 50, hlc: '019077fd307b0005', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-1', field: 'enabled', value: true, hlc: '019077fd307b0006', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-1', field: 'description', value: 'A test foe description', hlc: '019077fd307b0007', deviceId: 'dev-a' },
        ],
      }, authHeader(token));
      assert.equal(push.data.applied, 7);

      const row = db.prepare('SELECT description FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?').get('fc-1', 'p1');
      assert.equal(row.description, 'A test foe description');

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const descChange = pull.data.changes.find(c => c.field === 'description');
      assert.equal(descChange.value, 'A test foe description');
    } finally { srv.close(); }
  });

  it('description can be null', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      const push = await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'foe_catalog', uuid: 'fc-2', field: 'name', value: 'Null Desc', hlc: '019077fd307b0010', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-2', field: 'tier', value: 'heavy', hlc: '019077fd307b0011', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-2', field: 'max_hp', value: 90, hlc: '019077fd307b0012', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-2', field: 'xp_reward', value: 60, hlc: '019077fd307b0013', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-2', field: 'encounter_weight', value: 30, hlc: '019077fd307b0014', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-2', field: 'enabled', value: true, hlc: '019077fd307b0015', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-2', field: 'description', value: null, hlc: '019077fd307b0016', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      const row = db.prepare('SELECT description FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?').get('fc-2', 'p1');
      assert.equal(row.description, null);
    } finally { srv.close(); }
  });

  it('catalog seeding includes description', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const res = await postJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, {}, authHeader(token));
      const seeded = await postJson(`http://localhost:${srv.address().port}/api/v1/data/catalog`, {}, authHeader(token));
      // Just GET the catalog; seeding happens on first access.
      const catRes = await fetch(`http://localhost:${srv.address().port}/api/v1/data/catalog`, {
        headers: authHeader(token),
      });
      const body = await catRes.json();
      assert.ok(Array.isArray(body.catalog));

      const shortcut = body.catalog.find(c => c.name === 'The Shortcut');
      assert.ok(shortcut, 'The Shortcut must be in the catalog');
      assert.ok(shortcut.description, 'The Shortcut must have a description');
      assert.ok(shortcut.description.includes('path of least resistance'));
    } finally { srv.close(); }
  });
});
