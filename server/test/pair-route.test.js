import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, postJson } from './helpers.js';
import { createPairing } from '../../questlog-critical/sync-auth/pairing.js';

describe('POST /api/v1/sync/pair', () => {
  it('valid phrase returns token + profileUuid', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { phrase } = await createPairing(db, 'profile-pair-test');

      const res = await postJson(`${base}/api/v1/sync/pair`, {
        phrase,
        deviceName: 'test-phone',
      });

      assert.equal(res.status, 200);
      assert.ok(res.data.token, 'token returned');
      assert.equal(res.data.profileUuid, 'profile-pair-test');
    } finally {
      srv.close();
    }
  });

  it('bad phrase → 401', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await postJson(`${base}/api/v1/sync/pair`, {
        phrase: 'bad-phrase-is-wrong-here-yes-fake-wrong',
        deviceName: 'test-phone',
      });

      assert.equal(res.status, 401);
    } finally {
      srv.close();
    }
  });

  it('reused phrase → 401', async () => {
    const { app, db } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const { phrase } = await createPairing(db, 'profile-pair-reuse');

      const res1 = await postJson(`${base}/api/v1/sync/pair`, { phrase, deviceName: 'dev1' });
      assert.equal(res1.status, 200);

      const res2 = await postJson(`${base}/api/v1/sync/pair`, { phrase, deviceName: 'dev2' });
      assert.equal(res2.status, 401);
    } finally {
      srv.close();
    }
  });

  it('missing body → 400', async () => {
    const { app } = makeApp();
    const srv = app.listen(0);
    const base = `http://localhost:${srv.address().port}`;
    try {
      const res = await postJson(`${base}/api/v1/sync/pair`, { phrase: '', deviceName: '' });

      assert.equal(res.status, 400);
    } finally {
      srv.close();
    }
  });
});
