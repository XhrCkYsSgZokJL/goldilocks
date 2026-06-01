// Pino redaction paths used by the Fastify logger.
//
// Lives in its own module so the server bootstrap (src/server.ts) and
// the test suite (src/observability/redact-paths.test.ts) can pull from
// the same constant. Adding a path here propagates everywhere.
//
// What goes in this list
// ----------------------
// Anything that, if it ever landed in a structured log record (via
// Fastify's default `req` serializer, an ad-hoc `req.log.info({ body },
// ...)`, or an error object whose .toString() includes a sensitive
// field) would be a meaningful leak. The list is defensive — most of
// these fields aren't logged today, but redaction is free and the cost
// of forgetting one is real.

export const REDACT_PATHS = [
  // Headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-convos-authtoken"]',        // our JWT header
  'req.headers["stripe-signature"]',
  // Auth / SIWE bodies
  'req.body.signature',
  'req.body.siweMessage',
  'req.body.message',                          // alternate SIWE field name
  // Refresh-token rotation
  'req.body.refreshToken',
  'req.body.refresh_token',
  'req.body.token',                            // any token in a body
  // Device registration
  'req.body.pushToken',
  // Admin upgrade code (16-digit, brute-force-sensitive)
  'req.body.code',
  'req.body.upgradeCode',
  // Notification subscription HMAC keys
  'req.body.hmacKeys',
  'req.body.topics[*].hmacKeys',
  // Generic top-level keys for ad-hoc structured logs.
  // If any of these strings appear as a JSON key anywhere in a log
  // record (object passed to log.info / log.warn / log.error), Pino
  // censors the value before serialisation.
  'pushToken',
  'upgradeCode',
  'signature',
  'siweMessage',
  'privateKey',
  'private_key',
  'privateKeyHex',
  'hmacKeys',
  'hmac_keys',
  'refreshToken',
  'refresh_token',
  'token',                                      // catches JWT in many shapes
  'accessToken',
  'access_token',
  'jwt',
  'apiKey',
  'api_key',
  'webhookSecret',
  'webhook_secret',
  'sealedKey',
  'agePrivateKey',
  // Apple IAP
  'req.body.receiptData',
  'req.body.transactionId',
  'req.body.signedPayload',
  'receiptData',
  'appStoreReceipt',
  'originalTransactionId',
  'signedPayload',
  'applePrivateKey',
  'apple_private_key',
  // Hopscotch crypto deposits
  'req.body.walletAddress',
  'walletAddress',
  'depositAddress',
  'hopscotchApiKey',
  'hopscotchWebhookSecret',
];
