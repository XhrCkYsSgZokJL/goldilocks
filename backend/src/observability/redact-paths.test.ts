import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { Writable } from 'node:stream';
import { REDACT_PATHS } from './redact-paths.js';

// Round-trip every path Pino is told to redact. We feed Pino a record
// shaped like the production logger sees it (request + ad-hoc top-level
// fields), capture the serialised JSON output, and assert every
// sensitive value comes through as `[redacted]`.
//
// If a future change forgets to add a new sensitive field to
// `REDACT_PATHS`, the matching test below fails — and the failure points
// straight at the path that needs adding.

function captureLogger(): { logger: pino.Logger; output: () => string[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = pino(
    {
      redact: {
        paths: REDACT_PATHS,
        censor: '[redacted]',
        remove: false,
      },
    },
    sink,
  );
  return { logger, output: () => chunks };
}

// All the sensitive strings the test puts into a single log record.
// Each one MUST end up as `[redacted]` in the output JSON.
const SECRET_VALUES = {
  authorization: 'Bearer aaaaaa.bbbbbb.cccccc',
  cookie: 'session=topsecret',
  stripeSignature: 't=123,v1=deadbeef',
  signature: '0x' + 'a'.repeat(130),
  siweMessage: 'goldilocksdigital.xyz wants you to sign in…',
  refreshToken: 'rt_aaaaaaaa',
  pushToken: '0123abcdef0123abcdef',
  code: '1234567890123456',
  upgradeCode: '1234567890123456',
  hmacKey: 'sk_hmac_aaaaaaaaaa',
  privateKey: '0xprivatekey',
};

describe('observability/redact-paths', () => {
  it('redacts every sensitive header in req.headers', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: {
          headers: {
            authorization: SECRET_VALUES.authorization,
            cookie: SECRET_VALUES.cookie,
            'stripe-signature': SECRET_VALUES.stripeSignature,
          },
        },
      },
      'incoming',
    );
    const line = output().join('');
    for (const value of [
      SECRET_VALUES.authorization,
      SECRET_VALUES.cookie,
      SECRET_VALUES.stripeSignature,
    ]) {
      assert.ok(
        !line.includes(value),
        `Expected ${value.slice(0, 16)}… to be redacted, but found it in: ${line}`,
      );
    }
    assert.ok(line.includes('[redacted]'), 'Expected a [redacted] marker in the output.');
  });

  it('redacts SIWE + refresh-token body fields', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: {
          body: {
            signature: SECRET_VALUES.signature,
            siweMessage: SECRET_VALUES.siweMessage,
            refreshToken: SECRET_VALUES.refreshToken,
          },
        },
      },
      'siwe',
    );
    const line = output().join('');
    for (const value of [
      SECRET_VALUES.signature,
      SECRET_VALUES.siweMessage,
      SECRET_VALUES.refreshToken,
    ]) {
      assert.ok(!line.includes(value), `Expected ${value.slice(0, 16)}… to be redacted.`);
    }
  });

  it('redacts admin upgrade code under both spellings', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: {
          body: {
            code: SECRET_VALUES.code,
            upgradeCode: SECRET_VALUES.upgradeCode,
          },
        },
      },
      'admin',
    );
    const line = output().join('');
    assert.ok(!line.includes(SECRET_VALUES.code), 'req.body.code leaked');
    assert.ok(!line.includes(SECRET_VALUES.upgradeCode), 'req.body.upgradeCode leaked');
  });

  it('redacts push tokens', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: { body: { pushToken: SECRET_VALUES.pushToken } },
      },
      'device-register',
    );
    assert.ok(!output().join('').includes(SECRET_VALUES.pushToken), 'pushToken leaked');
  });

  it('redacts subscription HMAC keys at both the top level and inside topics[*]', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        req: {
          body: {
            hmacKeys: [{ thirtyDayPeriodsSinceEpoch: 1, key: SECRET_VALUES.hmacKey }],
            topics: [
              {
                topic: 't1',
                hmacKeys: [{ thirtyDayPeriodsSinceEpoch: 2, key: SECRET_VALUES.hmacKey }],
              },
            ],
          },
        },
      },
      'subscribe',
    );
    const line = output().join('');
    assert.ok(!line.includes(SECRET_VALUES.hmacKey), 'HMAC key leaked');
  });

  it('redacts the generic top-level keys (ad-hoc structured logs)', () => {
    const { logger, output } = captureLogger();
    logger.info(
      {
        pushToken: SECRET_VALUES.pushToken,
        upgradeCode: SECRET_VALUES.upgradeCode,
        signature: SECRET_VALUES.signature,
        siweMessage: SECRET_VALUES.siweMessage,
        privateKey: SECRET_VALUES.privateKey,
        refreshToken: SECRET_VALUES.refreshToken,
        hmacKeys: [{ key: SECRET_VALUES.hmacKey }],
      },
      'ad-hoc',
    );
    const line = output().join('');
    for (const value of [
      SECRET_VALUES.pushToken,
      SECRET_VALUES.upgradeCode,
      SECRET_VALUES.signature,
      SECRET_VALUES.siweMessage,
      SECRET_VALUES.privateKey,
      SECRET_VALUES.refreshToken,
      SECRET_VALUES.hmacKey,
    ]) {
      assert.ok(!line.includes(value), `Top-level "${value.slice(0, 16)}…" leaked`);
    }
  });
});
