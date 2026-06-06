import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The lookup hash is HMAC-SHA256 keyed by an HKDF derivation of
// APP_ENCRYPTION_KEY. We verify:
//   - determinism (same input → same output)
//   - label domain separation
//   - master-key separation
//   - resilience to whitespace mismatch (we don't normalise — callers must)

const KEY_A = '0'.repeat(64);
const KEY_B = 'f'.repeat(64);

async function loadLookup(key: string): Promise<typeof import('./lookup-hash.js')> {
  process.env.APP_ENCRYPTION_KEY = key;
  const mod = await import('./lookup-hash.js');
  mod._resetLookupKeyCacheForTests();
  return mod;
}

describe('crypto/lookup-hash', () => {
  beforeEach(() => {
    delete process.env.APP_ENCRYPTION_KEY;
  });

  it('is deterministic — same input + label + key produces the same hash', async () => {
    const { lookupHash } = await loadLookup(KEY_A);
    const a = lookupHash('1234567890123456', 'admin_inboxes.upgrade_code.lookup');
    const b = lookupHash('1234567890123456', 'admin_inboxes.upgrade_code.lookup');
    assert.strictEqual(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('separates labels (different label → different hash for same input)', async () => {
    const { lookupHash } = await loadLookup(KEY_A);
    const a = lookupHash('x', 'admin_inboxes.upgrade_code.lookup');
    const b = lookupHash('x', 'other_table.col.lookup');
    assert.notStrictEqual(a, b);
  });

  it('separates master keys (different APP_ENCRYPTION_KEY → different hash for same input)', async () => {
    const { lookupHash: hashA } = await loadLookup(KEY_A);
    const a = hashA('1234567890123456', 'admin_inboxes.upgrade_code.lookup');
    const { lookupHash: hashB } = await loadLookup(KEY_B);
    const b = hashB('1234567890123456', 'admin_inboxes.upgrade_code.lookup');
    assert.notStrictEqual(a, b);
  });

  it('does not normalise input — whitespace differences produce different hashes', async () => {
    const { lookupHash } = await loadLookup(KEY_A);
    const a = lookupHash('1234567890123456', 'admin_inboxes.upgrade_code.lookup');
    const b = lookupHash(' 1234567890123456', 'admin_inboxes.upgrade_code.lookup');
    assert.notStrictEqual(a, b);
  });

  it('rejects a missing or malformed APP_ENCRYPTION_KEY', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    const mod = await import('./lookup-hash.js');
    mod._resetLookupKeyCacheForTests();
    assert.throws(() => mod.lookupHash('x', 'admin_inboxes.upgrade_code.lookup'));

    process.env.APP_ENCRYPTION_KEY = 'not_hex';
    mod._resetLookupKeyCacheForTests();
    assert.throws(() => mod.lookupHash('x', 'admin_inboxes.upgrade_code.lookup'));
  });
});
