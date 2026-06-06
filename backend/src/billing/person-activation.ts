// Person activation — deduct the initial monthly fee when a person is
// enabled on a client's plan, and track them in `covered_persons` for
// report delivery.
//
// When a person is enabled:
//   1. Check the client has sufficient balance (or is Emerald).
//   2. Deduct one month's fee from the prepaid balance.
//   3. Upsert a `covered_persons` row with enabled=true.
//   4. Update the client's `covered_people` count.
//   5. Return the new billing status.
//
// When a person is disabled:
//   1. Set the `covered_persons` row to enabled=false.
//   2. Update the client's `covered_people` count.
//   3. Return the new billing status.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { clients, coveredPersons, screeningEvents } from '../db/schema.js';
import { MONTHLY_PRICE_CENTS } from './pricing.js';
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
  const [client] = await db
    .select()
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);

  if (!client) {
    throw new Error('client_not_found');
  }

  const deductionCents: number = MONTHLY_PRICE_CENTS;
  const isEmerald: boolean = client.emeraldMembershipEnabled;

  // Check if person already exists and is enabled.
  const [existing] = await db
    .select()
    .from(coveredPersons)
    .where(
      and(
        eq(coveredPersons.clientId, clientId),
        eq(coveredPersons.personId, personId),
      ),
    )
    .limit(1);

  if (existing?.enabled) {
    return { activated: false, deductedCents: 0, needsInitialReport: false };
  }

  const needsInitialReport: boolean = !existing?.initialReportSentAt;

  // Only charge on first activation. Re-enabling a previously
  // activated person is free — they already paid.
  const isReactivation: boolean = existing != null;
  const chargeAmount: number = isReactivation ? 0 : deductionCents;

  const totalAvailable: number = client.referralCreditCents + client.billingBalanceCents;
  if (chargeAmount > 0 && !isEmerald && totalAvailable < chargeAmount) {
    throw new Error('insufficient_balance');
  }

  // Draw from referral credit first, then prepaid balance.
  let remaining: number = chargeAmount;
  let newReferralCredit: number = client.referralCreditCents;
  const fromReferral: number = Math.min(newReferralCredit, remaining);
  newReferralCredit -= fromReferral;
  remaining -= fromReferral;

  const newBalance: number = isEmerald
    ? client.billingBalanceCents - remaining
    : Math.max(0, client.billingBalanceCents - remaining);

  await db
    .update(clients)
    .set({
      billingBalanceCents: newBalance,
      referralCreditCents: newReferralCredit,
      coveredPeople: sql`(
        SELECT count(*) FROM covered_persons
        WHERE client_id = ${clientId} AND enabled = true
      ) + 1`,
    })
    .where(eq(clients.id, clientId));

  // Upsert the covered person row.
  if (existing) {
    await db
      .update(coveredPersons)
      .set({ enabled: true, displayName })
      .where(eq(coveredPersons.id, existing.id));
  } else {
    await db.insert(coveredPersons).values({
      clientId,
      personId,
      displayName,
      enabled: true,
    });
  }

  // Record the screening event for the admin stats trend. Best-effort:
  // analytics must never fail an activation.
  try {
    await db.insert(screeningEvents).values({ clientId, personId, kind: 'activation' });
  } catch (error) {
    log.warn({ clientId, personId, error }, 'failed to record activation screening event');
  }

  log.info(
    { clientId, personId, displayName, deductedCents: chargeAmount, reactivation: isReactivation },
    'person activated',
  );

  return {
    activated: true,
    deductedCents: chargeAmount,
    needsInitialReport,
  };
}

async function deactivatePerson(
  clientId: string,
  personId: string,
): Promise<PersonToggleResult> {
  await db
    .update(coveredPersons)
    .set({ enabled: false })
    .where(
      and(
        eq(coveredPersons.clientId, clientId),
        eq(coveredPersons.personId, personId),
      ),
    );

  // Recount covered people from the source-of-truth table.
  await db
    .update(clients)
    .set({
      coveredPeople: sql`(
        SELECT count(*) FROM covered_persons
        WHERE client_id = ${clientId} AND enabled = true
      )`,
    })
    .where(eq(clients.id, clientId));

  log.info({ clientId, personId }, 'person deactivated');

  return { activated: false, deductedCents: 0, needsInitialReport: false };
}
