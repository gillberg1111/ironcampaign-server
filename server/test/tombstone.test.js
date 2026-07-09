import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorageAdapter } from '../src/sync/adapter.js';
import { applyBatch } from '../../questlog-critical/hlc-merge/merge.js';
import { assertAllowed } from '../src/sync/registry.js';
import { makeDb, seedVillain } from './helpers.js';

describe('Tombstone', () => {
  it('delete then stale name edit → ignored-tombstoned', () => {
    const db = makeDb();
    const store = new SqliteStorageAdapter(db, 'profile-1');
    seedVillain(db, 'profile-1', { uuid: 'v1', name: 'Doomed' });

    const preName = { table: 'villains', uuid: 'v1', field: 'name', value: 'Doomed', hlc: '019077fd307b0001', deviceId: 'dev-1' };
    applyBatch(store, [preName]);

    // Apply the delete first so the tombstone is in place, THEN the stale edit arrives.
    // (A single applyBatch would sort by hlc and apply the older edit before the delete, which
    //  is a different scenario — R4 suppression is about edits arriving after the tombstone.)
    const del = applyBatch(store, [
      { table: 'villains', uuid: 'v1', field: 'deleted', value: true, hlc: '019077fd307b0005', deviceId: 'dev-a' },
    ]);
    assert.equal(del[0].decision, 'applied', 'delete is applied');

    const staleEdit = applyBatch(store, [
      { table: 'villains', uuid: 'v1', field: 'name', value: 'StaleEdit', hlc: '019077fd307b0003', deviceId: 'dev-b' },
    ]);
    assert.equal(staleEdit[0].decision, 'ignored-tombstoned', 'stale edit is ignored-tombstoned');

    const villain = db.prepare('SELECT name, deleted FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'profile-1');
    assert.equal(villain.deleted, 1);
    assert.equal(villain.name, 'Doomed', 'name unchanged by stale edit');
  });

  it('undelete then edit in same batch', () => {
    const db = makeDb();
    const store = new SqliteStorageAdapter(db, 'profile-1');
    seedVillain(db, 'profile-1', { uuid: 'v1', name: 'Doomed', deleted: 1 },
    );

    db.prepare('INSERT INTO field_meta (profile_uuid, table_name, row_uuid, field_name, hlc, device_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run('profile-1', 'villains', 'v1', 'deleted', '019077fd307b0005', 'dev-a');

    const changes = [
      { table: 'villains', uuid: 'v1', field: 'deleted', value: false, hlc: '019077fd307b0008', deviceId: 'dev-b' },
      { table: 'villains', uuid: 'v1', field: 'name', value: 'Revived', hlc: '019077fd307b0009', deviceId: 'dev-b' },
    ];

    const results = applyBatch(store, changes);
    assert.equal(results[0].decision, 'undeleted');
    assert.equal(results[1].decision, 'applied');

    const villain = db.prepare('SELECT name, deleted FROM villains WHERE uuid = ? AND profile_uuid = ?').get('v1', 'profile-1');
    assert.equal(villain.deleted, 0);
    assert.equal(villain.name, 'Revived');
  });

  it('assertAllowed throws 400 for deleted on sessions', () => {
    assert.throws(() => {
      assertAllowed('sessions', 'deleted');
    });
  });

  it('deleted is allowed on villains', () => {
    assert.doesNotThrow(() => {
      assertAllowed('villains', 'deleted');
    });
  });
});
