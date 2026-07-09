import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, addDevice, authHeader, postJson, getJson } from './helpers.js';

describe('Auth', () => {
  const endpoints = [
    ['POST', '/api/v1/sync/push', { changes: [] }],
    ['POST', '/api/v1/sync/changes', { since: 0 }],
    ['GET', '/api/v1/sync/status', null],
    ['POST', '/api/v1/combat/glancing-blow', { villainUUID: 'v1' }],
    ['POST', '/api/v1/combat/session', { villainUUID: 'v1', durationMinutes: 30 }],
    ['POST', '/api/v1/combat/confession', { villainUUID: 'v1' }],
  ];

  for (const [method, path, body] of endpoints) {
    it(`${method} ${path} without auth → 401`, async () => {
      const { app } = makeApp();
      const srv = app.listen(0);
      const base = `http://localhost:${srv.address().port}`;
      try {
        let res;
        if (method === 'GET') {
          res = await getJson(`${base}${path}`);
        } else {
          res = await postJson(`${base}${path}`, body, {});
        }
        assert.equal(res.status, 401);
      } finally {
        srv.close();
      }
    });
  }

  it('malformed Bearer token → 401', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await getJson(`${base}/api/v1/sync/status`, {
        Authorization: 'Bearer short',
      });
      assert.equal(res.status, 401);
    } finally {
      srv.close();
    }
  });

  it('revoked token → 401', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      db.prepare('UPDATE device_tokens SET revoked_at = ? WHERE profile_uuid = ?').run(Date.now(), 'p1');

      const res = await getJson(`${base}/api/v1/sync/status`, authHeader(token));
      assert.equal(res.status, 401);
    } finally {
      srv.close();
    }
  });

  it('valid token → 200 on sync/status', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const token = addDevice(db, 'p1');
      const res = await getJson(`${base}/api/v1/sync/status`, authHeader(token));
      assert.equal(res.status, 200);
    } finally {
      srv.close();
    }
  });
});
