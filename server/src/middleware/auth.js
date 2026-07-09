import { authenticateDevice } from '../../../questlog-critical/sync-auth/pairing.js';

// Shared auth middleware. profileUuid derives ONLY from the device token row
// (spec §8.B invariant A1) — never from the request body/query/headers the client controls.
export function makeAuth(db) {
  return (req, res, next) => {
    try {
      const auth = authenticateDevice(db, req.headers.authorization);
      req.profileUuid = auth.profileUuid;
      req.deviceTokenId = auth.deviceTokenId;
      next();
    } catch (e) {
      res.status(e.status || 401).json({ error: 'unauthorized' });
    }
  };
}
