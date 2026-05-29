// Manual entry point for the admin_inboxes.upgrade_code_lookup backfill.
// The same logic runs automatically as part of `npm run migrate` —
// this script is just a way to invoke it ad-hoc in dev without
// re-running migrations.
//
// Usage:
//   npm run backfill-admin-upgrade-lookups
//
// Idempotent: rows that already carry a lookup hash are skipped.
//
// Design: src/db/backfill-admin-upgrade-lookups.ts.

import { pool } from '../src/db/client.js';
import { backfillAdminUpgradeLookups } from '../src/db/backfill-admin-upgrade-lookups.js';

backfillAdminUpgradeLookups()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[backfill-admin-upgrade-lookups] failed:', err);
    pool.end().finally(() => process.exit(1));
  });
