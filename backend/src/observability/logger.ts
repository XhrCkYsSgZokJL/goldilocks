// Standalone Pino logger for code that runs outside Fastify request context.
//
// The agent process and background workers don't have `req.log` available.
// This module gives them the same structured JSON output, redaction, and
// level controls as the Fastify logger — so all backend output is
// consistent and filterable.

import pino from 'pino';
import { config } from '../config.js';
import { REDACT_PATHS } from './redact-paths.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
    remove: false,
  },
  transport:
    config.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
});

export type Logger = pino.Logger;
