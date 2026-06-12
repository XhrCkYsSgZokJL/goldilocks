// Monthly seat promotion tick.
//
// Run once per day (via the agent process). On the 1st of each month it
// promotes people whose initial $100 coverage window has ended into the
// per-seat Stripe subscription quantity, so Stripe bills them from that
// month on. On other days it is a no-op.
//
// Stripe does the actual charging and proration — this tick only keeps the
// subscription quantity in sync with the people who should now be billed.
// Idempotent within a calendar month via last_balance_tick_at.

import { and, eq, gt, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, coveredPersons } from '../db/schema.js';
import { setSeatQuantity } from './subscriptions.js';
import { logger } from '../observability/logger.js';
import { emitBillingEvent } from '../observability/billing-events.js';

const log = logger.child({ module: 'billing.monthly-tick' });

export interface TickResult {
  processed: number;
  deducted: number;
  lapsed: number;
  skipped: number;
}

export async function runDailyBalanceTick(): Promise<TickResult> {
  const now = new Date();
  const dayOfMonth = now.getUTCDate();

  // Only promote seats on the 1st of the month.
  if (dayOfMonth !== 1) {
    return { processed: 0, deducted: 0, lapsed: 0, skipped: 0 };
  }

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const eligible = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.coverageEnabled, true),
        gt(clients.coveredPeople, 0),
        or(isNull(clients.lastBalanceTickAt), lt(clients.lastBalanceTickAt, monthStart)),
      ),
    );

  const result: TickResult = { processed: 0, deducted: 0, lapsed: 0, skipped: 0 };

  for (const client of eligible) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(coveredPersons)
      .where(
        and(
          eq(coveredPersons.clientId, client.id),
          eq(coveredPersons.enabled, true),
          lte(coveredPersons.recurringStartsAt, now),
        ),
      );
    const recurringQty: number = row?.count ?? 0;

    try {
      await setSeatQuantity(client, recurringQty);
    } catch (error) {
      log.warn({ clientId: client.id, error }, 'failed to sync subscription seat quantity');
      result.skipped += 1;
      continue;
    }

    await db.update(clients).set({ lastBalanceTickAt: now }).where(eq(clients.id, client.id));

    if (recurringQty > 0) {
      result.processed += 1;
      // Best-effort renewal screening events for the admin stats trend.
      try {
        await db.execute(sql`
          INSERT INTO screening_events (client_id, person_id, kind, occurred_at)
          SELECT ${client.id}::uuid, person_id, 'renewal', ${now}
          FROM covered_persons
          WHERE client_id = ${client.id}::uuid AND enabled = true AND recurring_starts_at <= ${now}
        `);
      } catch (error) {
        log.warn({ clientId: client.id, error }, 'failed to record renewal screening events');
      }
      emitBillingEvent(log, {
        event: 'billing.balance.settled',
        clientId: client.id,
        inboxId: client.inboxId,
        context: { reason: 'monthly_promotion', recurringSeats: recurringQty },
      });
    } else {
      result.skipped += 1;
    }
  }

  log.info(result, 'monthly seat promotion tick complete');
  return result;
}
