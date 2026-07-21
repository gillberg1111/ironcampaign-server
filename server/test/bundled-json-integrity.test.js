import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'src', 'data');
const iosDir = path.join(__dirname, '..', '..', 'ios', 'IronCampaign', 'Resources');

// These files are hand-edited (foes added in v2.68, kettlebell exercises in v2.70) and are
// keyed into dictionaries on the client. A duplicate key used to be a launch crash
// (Dictionary(uniqueKeysWithValues:) traps); the client now takes first-wins, so a duplicate
// would instead SILENTLY drop an entry. Catch it here, where the message is obvious.
// The existing parity gate can't help: two identical files share a duplicate happily.
const FILES = [
  { file: 'exercise-library.json', key: 'builtin_id' },
  { file: 'foe-catalog.json', key: 'builtin_id' },
  { file: 'vocabulary.json', key: 'term' },
];

describe('Bundled JSON integrity', () => {
  for (const { file, key } of FILES) {
    it(`${file}: ${key} values are unique`, () => {
      const rows = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
      assert.ok(Array.isArray(rows) && rows.length > 0, `${file} must be a non-empty array`);
      const seen = new Map();
      const dupes = [];
      for (const row of rows) {
        const k = row[key];
        assert.ok(k != null && k !== '', `${file}: every entry needs a ${key}`);
        if (seen.has(k)) dupes.push(k); else seen.set(k, true);
      }
      assert.deepEqual(dupes, [], `${file} has duplicate ${key}: ${dupes.join(', ')}`);
    });

    it(`${file}: iOS bundle copy has the same unique keys`, () => {
      const iosPath = path.join(iosDir, file);
      if (!fs.existsSync(iosPath)) return; // vocabulary/foe copies are parity-gated elsewhere
      const serverKeys = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8')).map(r => r[key]);
      const iosKeys = JSON.parse(fs.readFileSync(iosPath, 'utf-8')).map(r => r[key]);
      assert.deepEqual(iosKeys, serverKeys, `${file}: iOS copy diverges from server copy`);
    });
  }
});
