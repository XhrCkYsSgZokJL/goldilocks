// Person activation — Stripe subscription model.
//
// When a new person is enabled:
//   1. Charge the flat one-time $100 initial-report fee off-session.
//   2. Mark them as fee-paid and set their recurring-billing start date
//      (the 1st of the month after next — the $100 covers them until then).
//   3. Upsert a `covered_persons` row with enabled=true.
//   4. Recompute the client's covered_people count.
//
// Re-enabling a person who already paid the fee is free — they keep their
// fee-paid flag and rejoin recurring billing on the next 1st.
//
// When a person is disabled:
//   1. Set the `covered_persons` row to enabled=false.
//   2. Recompute covered_people and lower the subscription seat quantity
//      (Stripe issues a proration credit for anyone already being billed).
//
// The daily tick promotes people into the subscription quantity once their
// recurring-start date arrives; activation itself never bills recurring.

import { and, eq, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, coveredPersons, screeningEvents } from '../db/schema.js';
import { INITIAL_REPORT_FEE_CENTS, recurringStartsAt } from './pricing.js';
import { applyReferralCreditsForPayingClient, chargeInitialReportFee, setSeatQuantity } from './subscriptions.js';
import { logger } from '../observability/logger.js';

const log = logger.child({ module: 'billing.person-activation' });

export interface PersonToggleInput {
  clientId: string;
  personId: string;
  displayName: string;
  enabled: boolean;
}

export interface PersonToggleResult {
  activated: boolean;
  deductedCents: number;
  needsInitialReport: boolean;
}

type ClientRow = typeof clients.$inferSelect;

// The next 1st of the month at 00:00 UTC.
function nextMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// Count enabled people whose recurring window has started — i.e. those who
// should currently be billed in the subscription quantity.
async function recurringSeatCount(clientId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(coveredPersons)
    .where(
      and(
        eq(coveredPersons.clientId, clientId),
        eq(coveredPersons.enabled, true),
        lte(coveredPersons.recurringStartsAt, now),
      ),
    );
  return row?.count ?? 0;
}

export async function togglePersonCoverage(
  input: PersonToggleInput,
): Promise<PersonToggleResult> {
  const { clientId, personId, displayName, enabled } = input;
  if (enabled) {
    return activatePerson(clientId, personId, displayName);
  }
  return deactivatePerson(clientId, personId);
}

async function activatePerson(
  clientId: string,
  personId: string,
  displayName: string,
): Promise<PersonToggleResult> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    throw new Error('client_not_found');
  }

  const [existing] = await db
    .select()
    .from(coveredPersons)
    .where(and(eq(coveredPersons.clientId, clientId), eq(coveredPersons.personId, personId)))
    .limit(1);

  if (existing?.enabled) {
    return { activated: false, deductedCents: 0, needsInitialReport: false };
  }

  const now = new Date();
  const needsInitialReport: boolean = !existing?.initialReportSentAt;
  const isEmerald: boolean = client.emeraldMembershipEnabled;

  // Emerald clients are billed externally — no card, no $100 fee, no
  // Stripe subscription — but their granted seat allowance is enforced.
  if (isEmerald) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(coveredPersons)
      .where(and(eq(coveredPersons.clientId, clientId), eq(coveredPersons.enabled, true)));
    const enabledCount: number = row?.count ?? 0;
    if (enabledCount >= client.emeraldSeatLimit) {
      throw new Error('seat_limit_reached');
    }
  }

  // Charge the $100 fee only the first time a person is enabled. A person
  // who already paid (initialFeePaidAt set) re-enables for free; Emerald
  // people never pay through Stripe at all.
  const alreadyPaid: boolean = existing?.initialFeePaidAt != null;
  const chargeCents: number = isEmerald || alreadyPaid ? 0 : INITIAL_REPORT_FEE_CENTS;

  if (chargeCents > 0) {
    await chargeInitialReportFee(client); // throws 'no_payment_method' if no card on file
    // The client just became a paying member — settle any referral reward.
    await applyReferralCreditsForPayingClient(clientId, log);
  }

  // New people are covered by the $100 until the 1st of the month after
  // next. Free re-enables rejoin recurring billing on the next 1st.
  // Emerald people never enter the subscription quantity.
  let recurringStart: Date | null = null;
  let feePaidAt: Date | null = existing?.initialFeePaidAt ?? null;
  if (!isEmerald) {
    recurringStart = alreadyPaid ? nextMonthStart(now) : recurringStartsAt(now);
    if (!alreadyPaid) {
      feePaidAt = now;
    }
  }

  if (existing) {
    await db
      .update(coveredPersons)
      .set({ enabled: true, displayName, initialFeePaidAt: feePaidAt, recurringStartsAt: recurringStart })
      .where(eq(coveredPersons.id, existing.id));
  } else {
    await db.insert(coveredPersons).values({
      clientId,
      personId,
      displayName,
      enabled: true,
      initialFeePaidAt: feePaidAt,
      recurringStartsAt: recurringStart,
    });
  }

  await recountCoveredPeople(clientId);

  try {
    await db.insert(screeningEvents).values({ clientId, personId, kind: 'activation' });
  } catch (error) {
    log.warn({ clientId, personId, error }, 'failed to record activation screening event');
  }

  log.info(
    { clientId, personId, displayName, chargedCents: chargeCents, reactivation: alreadyPaid },
    'person activated',
  );

  return { activated: true, deductedCents: chargeCents, needsInitialReport };
}

async function deactivatePerson(
  clientId: string,
  personId: string,
): Promise<PersonToggleResult> {
  await db
    .update(coveredPersons)
    .set({ enabled: false })
    .where(and(eq(coveredPersons.clientId, clientId), eq(coveredPersons.personId, personId)));

  await recountCoveredPeople(clientId);

  // Lower the subscription seat quantity for anyone who was already being
  // billed. Only touch Stripe if a subscription exists — people still in
  // their initial $100 window aren't in the quantity yet.
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (client?.stripeSubscriptionId) {
    const qty: number = await recurringSeatCount(clientId, new Date());
    try {
      await setSeatQuantity(client, qty);
    } catch (error) {
      log.warn({ clientId, personId, error }, 'failed to lower subscription seat quantity');
    }
  }

  log.info({ clientId, personId }, 'person deactivated');
  return { activated: false, deductedCents: 0, needsInitialReport: false };
}

// Recompute covered_people (and the deprecated billing_seats mirror, which
// the status endpoint still reads for the monthly-rate display) from the
// source-of-truth covered_persons table.
async function recountCoveredPeople(clientId: string): Promise<void> {
  await db
    .update(clients)
    .set({
      coveredPeople: sql`(
        SELECT count(*) FROM covered_persons
        WHERE client_id = ${clientId} AND enabled = true
      )`,
      billingSeats: sql`(
        SELECT count(*) FROM covered_persons
        WHERE client_id = ${clientId} AND enabled = true
      )`,
    })
    .where(eq(clients.id, clientId));
}

export { recurringSeatCount };
export type { ClientRow };
