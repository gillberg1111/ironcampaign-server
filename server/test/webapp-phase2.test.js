import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addDevice, authHeader, addOwner, postJson, putJson } from './helpers.js';

async function delJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  return { status: r.status, data: d };
}

describe('Web app Phase 2 — schedule-rules, chapters, planned-workouts DELETE', () => {
  it('DELETE /data/schedule-rules/:uuid removes a rule', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}`;
      const create = await postJson(`${base}/api/v1/data/schedule-rules`, {
        name: 'Test Rule', startDate: '2026-01-01', recurrence: 'once',
      }, authHeader(token));
      assert.equal(create.status, 201);
      const uuid = create.data.uuid;

      const del = await delJson(`${base}/api/v1/data/schedule-rules/${uuid}`, null, authHeader(token));
      assert.equal(del.status, 200);

      const row = db.prepare(
        'SELECT deleted FROM schedule_rules WHERE uuid = ? AND profile_uuid = ?'
      ).get(uuid, 'p1');
      assert.ok(row, 'row still exists (tombstone)');
      assert.equal(row.deleted, 1);
    } finally { srv.close(); }
  });

  it('DELETE /data/chapters/:uuid removes chapter + cascade deletes planned workouts', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}`;
      const saga = await postJson(`${base}/api/v1/data/sagas`, {
        name: 'Test Saga',
      }, authHeader(token));
      assert.equal(saga.status, 201);

      const ch = await postJson(`${base}/api/v1/data/chapters`, {
        sagaUUID: saga.data.uuid, name: 'Chapter 1', weekIndex: 0,
      }, authHeader(token));
      assert.equal(ch.status, 201);

      const pw = await postJson(`${base}/api/v1/data/planned-workouts`, {
        chapterUUID: ch.data.uuid, name: 'Workout A', dayIndex: 0,
      }, authHeader(token));
      assert.equal(pw.status, 201);

      const del = await delJson(`${base}/api/v1/data/chapters/${ch.data.uuid}`, null, authHeader(token));
      assert.equal(del.status, 200);

      const chRow = db.prepare(
        'SELECT deleted FROM chapters WHERE uuid = ? AND profile_uuid = ?'
      ).get(ch.data.uuid, 'p1');
      assert.equal(chRow.deleted, 1);

      const pwRow = db.prepare(
        'SELECT deleted FROM planned_workouts WHERE uuid = ? AND profile_uuid = ?'
      ).get(pw.data.uuid, 'p1');
      assert.equal(pwRow.deleted, 1, 'planned workout cascaded to deleted');
    } finally { srv.close(); }
  });

  it('DELETE /data/planned-workouts/:uuid removes a workout', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}`;
      const saga = await postJson(`${base}/api/v1/data/sagas`, {
        name: 'Test Saga',
      }, authHeader(token));
      const ch = await postJson(`${base}/api/v1/data/chapters`, {
        sagaUUID: saga.data.uuid, name: 'Chapter 1', weekIndex: 0,
      }, authHeader(token));
      const pw = await postJson(`${base}/api/v1/data/planned-workouts`, {
        chapterUUID: ch.data.uuid, name: 'Workout A', dayIndex: 0,
      }, authHeader(token));
      assert.equal(pw.status, 201);

      const del = await delJson(`${base}/api/v1/data/planned-workouts/${pw.data.uuid}`, null, authHeader(token));
      assert.equal(del.status, 200);

      const pwRow = db.prepare(
        'SELECT deleted FROM planned_workouts WHERE uuid = ? AND profile_uuid = ?'
      ).get(pw.data.uuid, 'p1');
      assert.equal(pwRow.deleted, 1);
    } finally { srv.close(); }
  });

  it('PUT /data/catalog/:uuid with deleted:true tombstones a custom foe', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const base = `http://localhost:${srv.address().port}`;
      const create = await postJson(`${base}/api/v1/data/catalog`, {
        name: 'Delete Me', tier: 'minion', maxHP: 40, xpReward: 20, encounterWeight: 50,
      }, authHeader(token));
      assert.equal(create.status, 201);

      const del = await putJson(`${base}/api/v1/data/catalog/${create.data.uuid}`, {
        deleted: true,
      }, authHeader(token));
      assert.equal(del.status, 200);

      const row = db.prepare(
        'SELECT deleted FROM foe_catalog WHERE uuid = ? AND profile_uuid = ?'
      ).get(create.data.uuid, 'p1');
      assert.equal(row.deleted, 1);
    } finally { srv.close(); }
  });

  it('cannot delete a non-existent schedule rule (404)', async () => {
    const { app, db } = makeApp();
    const token = addDevice(db, 'p1');
    const srv = app.listen(0);
    try {
      const del = await delJson(`http://localhost:${srv.address().port}/api/v1/data/schedule-rules/bogus`, null, authHeader(token));
      assert.equal(del.status, 404);
    } finally { srv.close(); }
  });
});
