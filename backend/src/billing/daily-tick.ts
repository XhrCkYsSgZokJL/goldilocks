// Monthly balance tick.
//
// Run once per day (via the agent process). On the 1st of each month,
// charges $125 per covered person from the prepaid balance. On other
// days this is a no-op. Emerald clients can go negative; others floor
// at zero and coverage lapses.
//
// Idempotent within a calendar month: skips clients whose
// last_balance_tick_at is already in the current month.

import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients } from '../db/schema.js';
import { computeMonthlyTick } from './balance.js';
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

  // Only charge on the 1st of the month.
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
        or(
          isNull(clients.lastBalanceTickAt),
          lt(clients.lastBalanceTickAt, monthStart),
        ),
      ),
    );

  const result: TickResult = { processed: 0, deducted: 0, lapsed: 0, skipped: 0 };

  for (const client of eligible) {
    const tick = computeMonthlyTick(client);

    if (tick.deductedCents === 0) {
      result.skipped += 1;
      continue;
    }

    await db
      .update(clients)
      .set({
        billingBalanceCents: tick.newBalanceCents,
        lastBalanceTickAt: now,
      })
      .where(eq(clients.id, client.id));

    result.processed += 1;
    result.deducted += tick.deductedCents;

    if (tick.coverageLapsed) {
      result.lapsed += 1;
      emitBillingEvent(log, {
        event: 'billing.balance.zeroed',
        clientId: client.id,
        inboxId: client.inboxId,
        context: { reason: 'monthly_tick', coveredPeople: client.coveredPeople },
      });
    } else {
      emitBillingEvent(log, {
        event: 'billing.balance.settled',
        clientId: client.id,
        inboxId: client.inboxId,
        context: {
          deductedCents: tick.deductedCents,
          newBalanceCents: tick.newBalanceCents,
          coveredPeople: client.coveredPeople,
          emerald: client.emeraldMembershipEnabled,
        },
      });
    }
  }

  log.info(result, 'monthly balance tick complete');
  return result;
}
