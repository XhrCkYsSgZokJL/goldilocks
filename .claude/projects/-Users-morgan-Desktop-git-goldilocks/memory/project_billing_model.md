---
name: billing-model-v2
description: Billing model — $65/mo per person, $2/day daily burn, report delivery on 1st or 14th, Emerald status allows negative balance
metadata:
  type: project
---

Billing model for Goldilocks coverage:

- **Report day**: Client picks 1st or 14th of the month (applies to all their people)
- **Pricing**: $65/month per covered person = $2/day daily burn rate
- **Coverage starts**: When the report is delivered to the client (not when they toggle a person on)
- **Daily balance tick**: A cron/scheduled job runs once per day, deducts $2 × number of active covered people from the prepaid balance
- **Balance hits zero**: Coverage lapses, no more live events delivered
- **Emerald membership override**: When a client has Emerald status (admin-granted), their balance can go negative and coverage remains active regardless of balance

**Why:** Simplifies the previous continuous `settle()` math. Instead of computing elapsed time on every API call, a flat daily deduction keeps the balance field always current.

**How to apply:** When implementing the daily tick, check `emeraldMembershipEnabled` before halting coverage. The balance can go negative for Emerald clients — the admin sees the deficit but service continues uninterrupted.

Related: [[billing-payments-logging]]
