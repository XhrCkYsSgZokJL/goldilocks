import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The encryptedJson codec is `JSON.stringify → encryptAtRest` on write
// and `decryptAtRest → JSON.parse` on read, with read-tolerance for
// rows that predate the encryption rollout (plain JSON, no v1 envelope).
//
// The cryptographic primitives are covered by at-rest.test.ts. Here we
// verify the serialisation contract — round-trip a structured value,
// confirm legacy plaintext is still parseable, and confirm the
// ENCRYPT_AT_REST_V1 flag gates the envelope.

const KEY = '0'.repeat(64);
const LABEL = 'subscriptions.hmac_keys';

interface HmacKey {
  thirtyDayPeriodsSinceEpoch: number;
  key: string;
}

async function loadCrypto(): Promise<typeof import('./at-rest.js')> {
  process.env.APP_ENCRYPTION_KEY = KEY;
  const mod = await import('./at-rest.js');
  mod._resetMasterKeyCacheForTests();
  return mod;
}

// Stand-in for the codec's two ops — same logic as src/crypto/encrypted-json.ts.
function writeJson<T>(value: T, encrypt: (s: string, l: string) => string): string {
  const serialised = JSON.stringify(value);
  if (process.env.ENCRYPT_AT_REST_V1 !== 'true') return serialised;
  return encrypt(serialised, LABEL);
}

function readJson<T>(
  value: string,
  isEncrypted: (s: string) => boolean,
  decrypt: (s: string, l: string) => string,
): T {
  const text = isEncrypted(value) ? decrypt(value, LABEL) : value;
  return JSON.parse(text) as T;
}

describe('crypto/encrypted-json (codec contract)', () => {
  beforeEach(() => {
    delete process.env.ENCRYPT_AT_REST_V1;
  });

  it('round-trips an array of HMAC keys when encryption is on', async () => {
    process.env.ENCRYPT_AT_REST_V1 = 'true';
    const { encryptAtRest, decryptAtRest, isEncryptedAtRest } = await loadCrypto();
    const value: HmacKey[] = [
      { thirtyDayPeriodsSinceEpoch: 42, key: 'aabbccdd' },
      { thirtyDayPeriodsSinceEpoch: 43, key: 'eeff0011' },
    ];
    const stored = writeJson(value, encryptAtRest);
    assert.match(stored, /^v1\./);
    const restored = readJson<HmacKey[]>(stored, isEncryptedAtRest, decryptAtRest);
    assert.deepStrictEqual(restored, value);
  });

  it('writes plaintext JSON when ENCRYPT_AT_REST_V1 is unset', async () => {
    const { encryptAtRest } = await loadCrypto();
    const value: HmacKey[] = [{ thirtyDayPeriodsSinceEpoch: 1, key: 'aa' }];
    const stored = writeJson(value, encryptAtRest);
    assert.strictEqual(stored, JSON.stringify(value));
    assert.ok(!stored.startsWith('v1.'));
  });

  it('reads legacy plaintext JSON rows during the rollout window', async () => {
    process.env.ENCRYPT_AT_REST_V1 = 'true';
    const { decryptAtRest, isEncryptedAtRest } = await loadCrypto();
    const legacy = '[{"thirtyDayPeriodsSinceEpoch":7,"key":"deadbeef"}]';
    const parsed = readJson<HmacKey[]>(legacy, isEncryptedAtRest, decryptAtRest);
    assert.deepStrictEqual(parsed, [{ thirtyDayPeriodsSinceEpoch: 7, key: 'deadbeef' }]);
  });

  it('encrypts the empty-array default cleanly', async () => {
    process.env.ENCRYPT_AT_REST_V1 = 'true';
    const { encryptAtRest, decryptAtRest, isEncryptedAtRest } = await loadCrypto();
    const stored = writeJson<HmacKey[]>([], encryptAtRest);
    assert.match(stored, /^v1\./);
    assert.deepStrictEqual(
      readJson<HmacKey[]>(stored, isEncryptedAtRest, decryptAtRest),
      [],
    );
  });
});
