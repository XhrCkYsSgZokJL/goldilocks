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
  'req.headers["stripe-signature"]',
  // Auth / SIWE bodies
  'req.body.signature',
  'req.body.siweMessage',
  // Refresh-token rotation
  'req.body.refreshToken',
  // Device registration
  'req.body.pushToken',
  // Admin upgrade code (16-digit, brute-force-sensitive)
  'req.body.code',
  'req.body.upgradeCode',
  // Notification subscription HMAC keys
  'req.body.hmacKeys',
  'req.body.topics[*].hmacKeys',
  // Generic top-level keys for ad-hoc structured logs
  'pushToken',
  'upgradeCode',
  'signature',
  'siweMessage',
  'privateKey',
  'hmacKeys',
  'refreshToken',
];
