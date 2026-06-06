import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// `config` validates process.env at import and exits if required vars are
// missing, so satisfy the minimum here before importing venice. Venice's own
// vars are left unset on purpose — these tests exercise the gating + error
// path with no network call (the feature is disabled by default).
process.env.DATABASE_URL ??= 'postgres://localhost:5432/test';
process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-xx';

const { isVeniceConfigured, veniceChat, VeniceError } = await import('./venice.js');

test('isVeniceConfigured is false without a key + model', () => {
  assert.equal(isVeniceConfigured(), false);
});

test('veniceChat throws VeniceError when unconfigured (no network call)', async () => {
  await assert.rejects(
    () => veniceChat([{ role: 'user', content: 'hello' }]),
    (err: unknown) => err instanceof VeniceError && /not configured/i.test((err as Error).message),
  );
});
