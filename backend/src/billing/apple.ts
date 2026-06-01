// Apple App Store Server API v2 client.
//
// Mirrors the pattern of stripe.ts — lazy-initialised, optional config,
// routes return 503 when not configured.
//
// Uses the App Store Server API (JWT-based) for:
//   - Verifying signed transactions from StoreKit 2
//   - Looking up subscription status
//   - Processing Server Notifications v2 (signed JWS payloads)
//
// The @apple/app-store-server-library package handles JWT signing and
// JWS verification. Install it when ready to implement:
//   npm install @apple/app-store-server-library
//
// References:
//   https://developer.apple.com/documentation/appstoreserverapi
//   https://developer.apple.com/documentation/appstoreservernotifications

import { config } from '../config.js';

export function isAppleConfigured(): boolean {
  return !!(
    config.APPLE_BUNDLE_ID &&
    config.APPLE_KEY_ID &&
    config.APPLE_ISSUER_ID &&
    config.APPLE_PRIVATE_KEY &&
    config.APPLE_TEAM_ID
  );
}

export function getAppleEnvironment(): 'sandbox' | 'production' {
  return config.APPLE_ENVIRONMENT;
}

export interface AppleConfig {
  bundleId: string;
  teamId: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
  environment: 'sandbox' | 'production';
}

export function getAppleConfig(): AppleConfig {
  if (!isAppleConfigured()) {
    throw new Error('Apple IAP is not configured (missing APPLE_* env vars)');
  }
  return {
    bundleId: config.APPLE_BUNDLE_ID!,
    teamId: config.APPLE_TEAM_ID!,
    keyId: config.APPLE_KEY_ID!,
    issuerId: config.APPLE_ISSUER_ID!,
    privateKey: config.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    environment: config.APPLE_ENVIRONMENT,
  };
}
