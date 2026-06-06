// Lazy-initialised Stripe client.
//
// Stripe is optional: the server boots fine without STRIPE_SECRET_KEY, and
// the billing routes return 503 until it is set. We construct the client
// on first use rather than at import time so a missing key is a per-request
// error, not a boot failure.

import Stripe from 'stripe';
import { config } from '../config.js';

let cached: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return !!config.STRIPE_SECRET_KEY;
}

export function getStripe(): Stripe {
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (!cached) {
    // No apiVersion pin — use the account's default so this code stays
    // compatible across Stripe SDK upgrades.
    cached = new Stripe(config.STRIPE_SECRET_KEY);
  }
  return cached;
}
