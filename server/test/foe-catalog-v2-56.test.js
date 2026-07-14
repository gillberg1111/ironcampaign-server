import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { makeDb, claimOwner, seedVillain } from './helpers.js';
import { seedFoeCatalogIfNeeded, deterministicUUID, CONSOLE_DEVICE_ID } from '../src/services/consoleWriter.js';
import { REGISTRY } from '../src/sync/registry.js';
import { CONSTANT_FOES } from '../src/services/combat.js';
import * as encounter from '../src/services/encounter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(__dirname, '..', 'src', 'data', 'foe-catalog.json');

describe('Foe catalog – v2.56', () => {
  it('catalog JSON has 18 entries', () => {
    const data = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 18, 'catalog must contain 18 built-in foes');
    const ids = data.map(e => e.builtin_id);
    assert.ok(ids.includes('sugar_rush'));
    assert.ok(ids.includes('distraction'));
    assert.ok(ids.includes('gravity_well'));
    assert.ok(ids.includes('ghost_weight'));
    assert.ok(ids.includes('burnout'));
  });

  it('every catalog builtin_id has art on disk', () => {
    const data = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    const artDir = path.join(__dirname, '..', 'public', 'images', 'foes');
    for (const entry of data) {
      const artPath = path.join(artDir, entry.builtin_id + '.jpg');
      assert.ok(fs.existsSync(artPath), `missing art for builtin_id=${entry.builtin_id}`);
    }
  });

  it('description is in foe_catalog mutableFields', () => {
    const fc = REGISTRY.foe_catalog;
    assert.ok(fc.mutableFields.includes('description'), 'description must be a mutable field');
  });

  it('seeds a fresh profile with all 18 builtins', () => {
    const db = makeDb();
    const { profileUuid: puid } = claimOwner(db, 'admin', 'password123');
    const result = seedFoeCatalogIfNeeded(db, puid);
    assert.equal(result.seeded, 18);
    const rows = db.prepare(
      'SELECT builtin_id FROM foe_catalog WHERE profile_uuid = ? AND builtin_id IS NOT NULL AND deleted = 0'
    ).all(puid);
    assert.equal(rows.length, 18);
  });

  it('seeder appends only new builtins to an existing profile', () => {
    const db = makeDb();
    const { profileUuid: puid } = claimOwner(db, 'admin', 'password123');

    // Simulate a pre-v2.56 profile with 13 of 18 entries seeded
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    const first13 = catalog.filter(e =>
      !['sugar_rush', 'distraction', 'gravity_well', 'ghost_weight', 'burnout'].includes(e.builtin_id)
    );
    for (const entry of first13) {
      const uuid = deterministicUUID(puid, entry.builtin_id);
      db.prepare(
        `INSERT INTO foe_catalog (uuid, profile_uuid, name, tier, max_hp, xp_reward, encounter_weight, enabled, builtin_id, description, created_at, updated_at, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0)`
      ).run(uuid, puid, entry.name, entry.tier, entry.max_hp, entry.xp_reward, entry.encounter_weight, entry.builtin_id, entry.description ?? null, Date.now(), Date.now());
    }

    const before = db.prepare(
      'SELECT COUNT(*) as cnt FROM foe_catalog WHERE profile_uuid = ? AND builtin_id IS NOT NULL AND deleted = 0'
    ).get(puid).cnt;
    assert.equal(before, 13);

    const result = seedFoeCatalogIfNeeded(db, puid);
    assert.equal(result.seeded, 5, 'should seed exactly 5 new builtins');
    assert.equal(result.refreshed, 0, 'no descriptions should refresh since they are fresh');

    const after = db.prepare(
      'SELECT COUNT(*) as cnt FROM foe_catalog WHERE profile_uuid = ? AND builtin_id IS NOT NULL AND deleted = 0'
    ).get(puid).cnt;
    assert.equal(after, 18);
  });

  it('seeder refreshes stale descriptions', () => {
    const db = makeDb();
    const { profileUuid: puid } = claimOwner(db, 'admin', 'password123');

    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    const snoozeCat = catalog.find(e => e.builtin_id === 'snooze');
    const uuid = deterministicUUID(puid, 'snooze');
    const staleDesc = 'OLD DESCRIPTION TEXT';

    db.prepare(
      `INSERT INTO foe_catalog (uuid, profile_uuid, name, tier, max_hp, xp_reward, encounter_weight, enabled, builtin_id, description, created_at, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0)`
    ).run(uuid, puid, snoozeCat.name, snoozeCat.tier, snoozeCat.max_hp, snoozeCat.xp_reward, snoozeCat.encounter_weight, 'snooze', staleDesc, Date.now(), Date.now());

    const before = db.prepare('SELECT description FROM foe_catalog WHERE uuid = ?').get(uuid);
    assert.equal(before.description, staleDesc);

    const result = seedFoeCatalogIfNeeded(db, puid);
    assert.equal(result.refreshed, 1, 'should refresh 1 stale description');

    const after = db.prepare('SELECT description FROM foe_catalog WHERE uuid = ?').get(uuid);
    assert.equal(after.description, snoozeCat.description);
  });

  it('encounter: both bosses are eligible when boss gated in', () => {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    const bosses = catalog.filter(e => e.tier === 'boss');
    assert.equal(bosses.length, 2, 'should have two boss-tier entries');
    assert.ok(bosses.some(b => b.builtin_id === 'the_quit'));
    assert.ok(bosses.some(b => b.builtin_id === 'burnout'));

    for (const b of bosses) {
      assert.ok(b.encounter_weight > 0, `${b.builtin_id} must have positive encounter_weight`);
    }

    const { weightedPick } = encounter;
    const active = catalog
      .filter(e => e.tier !== 'boss' && e.encounter_weight > 0)
      .map(e => ({ ...e, enabled: true, deleted: false }));
    const bossEntries = bosses
      .filter(e => e.encounter_weight > 0)
      .map(e => ({ ...e, enabled: true, deleted: false }));
    assert.equal(bossEntries.length, 2);

    const bossGatedIn = true;
    const candidates = [...active, ...bossEntries];
    assert.ok(candidates.some(c => c.builtin_id === 'the_quit'));
    assert.ok(candidates.some(c => c.builtin_id === 'burnout'));

    let quitCount = 0, burnoutCount = 0;
    for (let i = 0; i < 1000; i++) {
      const pick = weightedPick(candidates, bossGatedIn);
      if (pick.builtin_id === 'the_quit') quitCount++;
      if (pick.builtin_id === 'burnout') burnoutCount++;
    }
    assert.ok(quitCount > 0, 'The Quit should be selected at least once (was: ' + quitCount + ')');
    assert.ok(burnoutCount > 0, 'The Burnout should be selected at least once (was: ' + burnoutCount + ')');
  });

  it('owner.html has no data-tab="console" and default view is today', () => {
    const htmlPath = path.join(__dirname, '..', 'public', 'owner.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    assert.ok(!html.includes('data-tab="console"'), 'console tab must be removed');
    assert.ok(html.includes("switchTab('today')"), 'default tab must be today');
  });

  it('pairing elements are in settings view', () => {
    const htmlPath = path.join(__dirname, '..', 'public', 'owner.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    // Pairing phrase generator and devices table must be in Settings
    assert.ok(html.includes('id="phraseBox"'));
    assert.ok(html.includes('id="devices"'));
    assert.ok(html.includes('id="pairMsg"'));
  });

  it('constant-foe exact strings are unchanged', () => {
    // The Drought and The Rust descriptions must remain byte-identical
    assert.equal(
      CONSTANT_FOES.heavy.description,
      'Iron left out in the rain doesn\u2019t rust overnight\u2014it fades one thin layer at a time. Three days off is all it takes for the joints to stiffen. Get back under the bar before the surface hardens.'
    );
    assert.equal(
      CONSTANT_FOES.minion.description,
      'Your body runs on water the way an engine runs on oil. When the tank runs low, everything grinds a little harder. Fill up before you start the engine.'
    );
  });
});
