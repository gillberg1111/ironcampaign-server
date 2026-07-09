import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, applyBatch } from '../../questlog-critical/hlc-merge/merge.js';
import { SqliteStorageAdapter } from '../src/sync/adapter.js';
import { makeDb, seedVillain } from './helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(path.join(__dirname, '../../questlog-critical/hlc-merge/test-vectors.json'), 'utf8'));

class ObjectStore {
  constructor() {
    this.fields = {};
    this.meta = {};
    this.rows = {};
    this.rowData = {};
  }
  _ensureField(table, uuid) {
    if (!this.fields[table]) this.fields[table] = {};
    if (!this.fields[table][uuid]) this.fields[table][uuid] = {};
    return this.fields[table][uuid];
  }
  _ensureMeta(table, uuid) {
    if (!this.meta[table]) this.meta[table] = {};
    if (!this.meta[table][uuid]) this.meta[table][uuid] = {};
    return this.meta[table][uuid];
  }
  getFieldMeta(table, uuid, field) {
    return this._ensureMeta(table, uuid)[field] ?? null;
  }
  setFieldMeta(table, uuid, field, hlc, deviceId) {
    this._ensureMeta(table, uuid)[field] = { hlc, deviceId };
  }
  applyField(table, uuid, field, value) {
    this._ensureField(table, uuid)[field] = value;
  }
  rowExists(table, uuid) {
    if (!this.rows[table]) this.rows[table] = new Set();
    return this.rows[table].has(uuid);
  }
  insertRow(table, uuid, value) {
    if (!this.rows[table]) this.rows[table] = new Set();
    this.rows[table].add(uuid);
    if (!this.rowData[table]) this.rowData[table] = {};
    this.rowData[table][uuid] = value;
  }
  isDeleted(table, uuid) {
    const meta = this._ensureMeta(table, uuid).deleted;
    if (!meta) return null;
    const deleted = this._ensureField(table, uuid).deleted;
    return deleted ? meta : null;
  }
  getState(table, uuid) {
    return this.fields[table]?.[uuid] ?? {};
  }
  getRows(table) {
    return this.rows[table] ? [...this.rows[table]].sort() : [];
  }
}

describe('Merge parity', () => {
  describe('Engine vs shared vectors (applyChange sequential)', () => {
    for (const tc of vectors.merge_cases) {
      it(tc.name, () => {
        const store = new ObjectStore();

        for (const pre of tc.pre) {
          applyChange(store, pre);
        }

        const decisions = tc.changes.map(c => applyChange(store, c));
        assert.deepStrictEqual(decisions, tc.expectDecisions, `${tc.name}: decisions mismatch`);

        if (tc.expectState) {
          if (tc.expectState.rows) {
            for (const table of Object.keys(store.rows)) {
              const actualRows = store.getRows(table);
              assert.deepStrictEqual(actualRows, tc.expectState.rows, `${tc.name}: rows mismatch`);
            }
          }
          for (const [uuid, expected] of Object.entries(tc.expectState)) {
            if (uuid === 'rows') continue;
            const state = store.getState('workout_templates', uuid);
            for (const [key, val] of Object.entries(expected)) {
              assert.equal(state[key], val, `${tc.name}: field ${uuid}.${key} mismatch`);
            }
          }
        }
      });
    }
  });

  describe('SqliteStorageAdapter end-to-end', () => {
    it('R1: different fields both apply', () => {
      const db = makeDb();
      const store = new SqliteStorageAdapter(db, 'profile-1');
      seedVillain(db, 'profile-1', { uuid: 'v1' });

      const changes = [
        { table: 'villains', uuid: 'v1', field: 'name', value: 'Dorf', hlc: '019077fd307b0001', deviceId: 'dev-1' },
        { table: 'villains', uuid: 'v1', field: 'max_hp', value: 150, hlc: '019077fd307b0002', deviceId: 'dev-1' },
      ];

      const results = applyBatch(store, changes);
      const decisions = results.map(r => r.decision);
      assert.deepStrictEqual(decisions, ['applied', 'applied']);

      const villain = db.prepare('SELECT name, max_hp FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'profile-1');
      assert.equal(villain.name, 'Dorf');
      assert.equal(villain.max_hp, 150);
    });

    it('R2: higher HLC wins, field_meta scoped', () => {
      const db = makeDb();
      const store = new SqliteStorageAdapter(db, 'profile-1');
      seedVillain(db, 'profile-1', { uuid: 'v1' });

      const changes = [
        { table: 'villains', uuid: 'v1', field: 'name', value: 'Old', hlc: '019077fd307b0001', deviceId: 'dev-1' },
        { table: 'villains', uuid: 'v1', field: 'name', value: 'New', hlc: '019077fd307b0002', deviceId: 'dev-1' },
      ];

      const results = applyBatch(store, changes);
      assert.equal(results[0].decision, 'applied');
      assert.equal(results[1].decision, 'applied');

      const villain = db.prepare('SELECT name FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'profile-1');
      assert.equal(villain.name, 'New');

      const meta = db.prepare(
        'SELECT hlc, device_id FROM field_meta WHERE profile_uuid = ? AND table_name = ? AND row_uuid = ? AND field_name = ?'
      ).get('profile-1', 'villains', 'v1', 'name');
      assert.ok(meta, 'field_meta entry exists');
      assert.equal(meta.hlc, '019077fd307b0002');
      assert.equal(meta.device_id, 'dev-1');
    });
  });
});
