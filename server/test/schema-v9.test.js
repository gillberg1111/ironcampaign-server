import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/schema.js';
import { REGISTRY, assertAllowed } from '../src/sync/registry.js';
import { APPEND_ONLY_TABLES } from '../../questlog-critical/hlc-merge/merge.js';
import { makeApp, addDevice, authHeader, postJson } from './helpers.js';

describe('Schema v9 (foe_catalog)', () => {
  it('migration is idempotent and creates the table', () => {
    const db = new Database(':memory:');
    migrate(db);
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.ok(tables.includes('foe_catalog'));
    assert.equal(db.prepare('SELECT MAX(version) as v FROM schema_version').get().v, 18);

    const catalogCols = db.pragma('table_info(foe_catalog)').map(c => c.name);
    assert.ok(catalogCols.includes('name'));
    assert.ok(catalogCols.includes('tier'));
    assert.ok(catalogCols.includes('max_hp'));
    assert.ok(catalogCols.includes('xp_reward'));
    assert.ok(catalogCols.includes('encounter_weight'));
    assert.ok(catalogCols.includes('enabled'));
    assert.ok(catalogCols.includes('builtin_id'));
    assert.ok(catalogCols.includes('profile_uuid'));

    const villainCols = db.pragma('table_info(villains)').map(c => c.name);
    assert.ok(villainCols.includes('tier'));
    assert.ok(villainCols.includes('xp_reward'));
    assert.ok(villainCols.includes('slot'));
    assert.ok(villainCols.includes('catalog_uuid'));
  });

  it('registry parity: foe_catalog is LWW and not appendOnly', () => {
    assert.equal(REGISTRY.foe_catalog.appendOnly, false);
    assert.ok(!APPEND_ONLY_TABLES.has('foe_catalog'));
    assert.ok(REGISTRY.foe_catalog.mutableFields.includes('name'));
    assert.ok(REGISTRY.foe_catalog.mutableFields.includes('enabled'));
  });

  it('registry accepts new villain fields', () => {
    assert.ok(REGISTRY.villains.mutableFields.includes('tier'));
    assert.ok(REGISTRY.villains.mutableFields.includes('xp_reward'));
    assert.ok(REGISTRY.villains.mutableFields.includes('slot'));
    assert.ok(REGISTRY.villains.mutableFields.includes('catalog_uuid'));
  });

  it('registry rejects unknown foe_catalog field', () => {
    assert.throws(() => {
      assertAllowed('foe_catalog', 'bogus_field');
    }, /not mutable/);
  });

  it('foe_catalog row round-trips through push/pull', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'foe_catalog', uuid: 'fc-001', field: 'name', value: 'Test Foe', hlc: '019077fd307b0100', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-001', field: 'tier', value: 'minion', hlc: '019077fd307b0101', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-001', field: 'max_hp', value: 40, hlc: '019077fd307b0102', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-001', field: 'xp_reward', value: 20, hlc: '019077fd307b0103', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-001', field: 'encounter_weight', value: 50, hlc: '019077fd307b0104', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-001', field: 'enabled', value: true, hlc: '019077fd307b0105', deviceId: 'dev-a' },
        ],
      }, authHeader(token));

      const dbRow = db.prepare('SELECT * FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?').get('fc-001', 'p1');
      assert.equal(dbRow.name, 'Test Foe');
      assert.equal(dbRow.tier, 'minion');

      const pull = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(token));
      const changes = pull.data.changes.filter(c => c.uuid === 'fc-001');
      assert.ok(changes.length >= 1);
    } finally { srv.close(); }
  });

  it('scoping: profile A cannot read profile B catalog', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const tokenA = addDevice(db, 'p1');
      const tokenB = addDevice(db, 'p2');

      await postJson(`${base}/api/v1/sync/push`, {
        changes: [
          { table: 'foe_catalog', uuid: 'fc-scope', field: 'name', value: 'A Foe', hlc: '019077fd307b0200', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-scope', field: 'tier', value: 'heavy', hlc: '019077fd307b0201', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-scope', field: 'max_hp', value: 90, hlc: '019077fd307b0202', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-scope', field: 'xp_reward', value: 60, hlc: '019077fd307b0203', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-scope', field: 'encounter_weight', value: 30, hlc: '019077fd307b0204', deviceId: 'dev-a' },
          { table: 'foe_catalog', uuid: 'fc-scope', field: 'enabled', value: true, hlc: '019077fd307b0205', deviceId: 'dev-a' },
        ],
      }, authHeader(tokenA));

      const pullB = await postJson(`${base}/api/v1/sync/changes`,
        { since: 0, deviceId: 'dev-b' }, authHeader(tokenB));
      const bChanges = pullB.data.changes.filter(c => c.uuid === 'fc-scope');
      assert.equal(bChanges.length, 0);
    } finally { srv.close(); }
  });
});
