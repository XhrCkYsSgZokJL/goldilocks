# Subscription ↔ roster sync — Plan

_Generated 2026-05-21._

## What this is

Right now the Subscription screen lets a client build a people list, (eventually)
create a subscription, and send the list to their Advisory chat — but those three
things aren't tied together. This adds the rules that connect them:

- You can only **Send to Advisory** when you have a subscription **and** that
  subscription matches your current people list.
- After you change the people list, you must **Update Subscription** before you
  can send again.
- You can't **re-send the same list** to Advisory twice in a row — only after it
  actually changes.
- If you make a change and then undo it, you're automatically back to "all good"
  — no update or resend needed.

The whole thing is one idea: compare a *fingerprint* of the people list against
two saved snapshots. It is not a one-way "dirty" flag, which is what makes the
undo case work for free.

## Core concept: the roster fingerprint

A **fingerprint** is a canonical string that represents a people list. To build
it: for each person take their `email` (trimmed + lowercased) and their `tier`,
form `email|tier`, sort all entries, and join them. The same people at the same
tiers always produce the same fingerprint regardless of the order they were
added.

Email is each person's **identity key** — names can be blank or duplicated, but
email is required (Save is already gated on it) and is meant to be unique per
person.

**Recommendation — include `tier` in the fingerprint.** The Advisory message
lists each person's plan, and billing depends on tier, so moving someone from
Light to Active is a real change: it should require both a subscription update
and a fresh send. You described "email addresses as the unique factor" — this
plan treats email as the per-person key and folds tier in on top. If you'd
rather a tier change *not* count as a change, we drop `tier` from the
fingerprint; it's a one-line change.

## State stored on the device

All of this lives in `GoldilocksSeatPlan`, persisted to `UserDefaults` — exactly
where the people list already lives. None of it is ever sent to the backend.

| Field | Meaning |
|-------|---------|
| `members` | The current people list. Already exists. |
| `subscribedRoster` | The `email|tier` entries the subscription currently covers. `nil` until the first "Create Subscription". |
| `sentFingerprint` | The fingerprint of the list at the last successful "Send to Advisory". `nil` until the first send. |

`subscribedRoster` is stored as the list of entries (not just a hash) because the
people-row highlighting needs to know *which* specific people aren't covered yet.

## Derived values

Everything the UI needs is computed from those three fields:

- `currentFingerprint` — fingerprint of `members`.
- `subscribedFingerprint` — fingerprint of `subscribedRoster`, or `nil`.
- `hasSubscription` — `subscribedRoster != nil`.
- `subscriptionMatches` — `hasSubscription && subscribedFingerprint == currentFingerprint`.
- `subscriptionNeedsUpdate` — `hasSubscription && !subscriptionMatches`.
- `alreadySent` — `sentFingerprint == currentFingerprint`.
- A person row is **pending** — `hasSubscription` and that person's `email|tier`
  is not present in `subscribedRoster`.

## Rules

### Subscription button (in the Payment section)

One button whose label and enabled-state depend on the state:

| Situation | Label | Enabled |
|-----------|-------|---------|
| No people | Create Subscription | No |
| People, no subscription | Create Subscription | Yes |
| Subscription, needs update | Update Subscription | Yes |
| Subscription, matches | Subscription Up to Date | No |

Tapping it sets `subscribedRoster` to the current `email|tier` entries. (Stage 1:
purely local. Once billing is wired, the same tap also runs the Stripe / crypto
charge for the new seat counts — see "Billing" below.)

### Send to Advisory button

Enabled only when **all** of these hold: there is at least one person,
`hasSubscription`, `subscriptionMatches`, and `!alreadySent`.

The footer states exactly why it's disabled, in priority order:

1. No people → "Add at least one person." _(red)_
2. No subscription → "Create a subscription before sending." _(red)_
3. Needs update → "Update your subscription to match your current people." _(red)_
4. Already sent → "This list has already been sent to Advisory." _(grey — not an error)_
5. Otherwise → "Shares your people list with your Advisory chat." _(grey, button enabled)_

On a successful send, `sentFingerprint` is set to `currentFingerprint`.

### People rows

When a subscription exists, any person not covered by `subscribedRoster` (a newly
added person, or one whose tier changed) is **highlighted** — a small accent dot
or a "Pending" pill on the row — meaning "added or changed since your last
subscription update." When there is no subscription yet, nothing is highlighted;
the "Create Subscription" button is the cue at that stage.

## Worked examples (the flows you described)

1. **Happy path.** Add people → Create Subscription → Send to Advisory. After the
   send, Send is disabled with "already been sent."
2. **Add a person.** Add someone → their row highlights, the subscription button
   becomes "Update Subscription", Send is disabled with "Update your
   subscription…". Tap Update → the highlight clears, Send becomes enabled → Send.
3. **Undo a change.** Add a person (Send disabled, row highlighted) → then delete
   that same person. `currentFingerprint` returns to the subscribed value, so the
   highlight clears, the button reads "Subscription Up to Date", and because
   `sentFingerprint` already equals `currentFingerprint`, Send shows "already
   sent." You're exactly where you were — no update, no resend. This works
   because every check is a fingerprint comparison, never a one-way flag.
4. **Change a tier.** Move someone Light → Active → the fingerprint changes → you
   must Update Subscription, after which Send becomes available again (the list
   genuinely changed).
5. **Edit an email.** Editing a person's email is treated as remove + add — the
   fingerprint changes and an update is required. Same for removing someone.

## Privacy

The fingerprints and `subscribedRoster` live only in on-device `UserDefaults`,
alongside the people list that's already stored there. The Goldilocks / Hopscotch
backend never receives names, emails, or phone numbers. When billing is wired up,
the backend and Stripe receive only **seat counts per tier** (e.g. 2 Light,
1 Active) — never who the people are. The actual roster reaches the team only
through the end-to-end-encrypted Advisory XMTP group. This plan does not change
that: no new data leaves the device.

## Stage 1 vs. billing

Today "Create / Update Subscription" is an always-disabled stub. This plan makes
it a real, **local** action so the whole gate is usable and testable before
Stripe exists: tapping it records `subscribedRoster`. When Stripe and the crypto
provider are connected, the same button additionally performs the charge / seat-
quantity update; the local fingerprint tracking is unchanged. (This supersedes
the current "available soon" disabled state.)

## Files to change

- `Convos/App Settings/GoldilocksSeatPlan.swift` — add `subscribedRoster` and
  `sentFingerprint` (plus persistence), the fingerprint helper, the derived
  flags, `markSubscriptionSynced()`, and record `sentFingerprint` inside
  `sendRosterToAdvisory`.
- `Convos/App Settings/AppSettingsView.swift` (`SubscriptionView`) — the
  contextual subscription button, the Send gating + footer messages, and the
  pending-row highlight in `memberRow`.

## Open decisions

1. **Fingerprint includes tier** (recommended) vs. emails-only.
2. **Highlight style** for pending rows — accent dot, "Pending" pill, or tinted
   row background.
3. **Enforce unique emails** in the person editor? Recommended, since email is
   the identity key — two people sharing an email would collide in the
   fingerprint.
