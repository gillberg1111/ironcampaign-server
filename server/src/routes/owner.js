import { Router } from 'express';
import { makeOwnerAuth } from '../auth/owner.js';
import { createPairing, revokeDevice } from '../../../questlog-critical/sync-auth/pairing.js';

export default function ownerRoutes(db) {
  const router = Router();
  const auth = makeOwnerAuth(db);

  router.post('/owner/pairings', auth, async (req, res) => {
    try {
      const { phrase, expiresAt } = await createPairing(db, req.ownerProfileUuid);
      res.json({ phrase, expiresAt });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  router.get('/owner/devices', auth, (req, res) => {
    const rows = db.prepare(
      'SELECT id, device_name, created_at, last_seen_at, revoked_at FROM device_tokens WHERE profile_uuid = ? ORDER BY created_at DESC'
    ).all(req.ownerProfileUuid);

    res.json({ devices: rows });
  });

  router.post('/owner/devices/:id/revoke', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'invalid device id' });
    }

    const target = db.prepare(
      'SELECT id FROM device_tokens WHERE id = ? AND profile_uuid = ?'
    ).get(id, req.ownerProfileUuid);

    if (!target) {
      return res.status(404).json({ error: 'device not found' });
    }

    const revoked = revokeDevice(db, id);
    res.json({ revoked });
  });

  return router;
}
