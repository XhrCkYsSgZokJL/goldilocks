// Format admin-initiated audit events into the narrative lines that
// land in the alerts group. Kept in its own module (rather than
// inlined in agent/index.ts) so the wording is easy to find and edit.

import type { AuditEventPayload } from './listener.js';

export function formatAuditLine(payload: AuditEventPayload): string {
  const actor: string = `Admin #${payload.admin_number}`;
  const target: string = `Client #${payload.client_number}`;
  switch (payload.kind) {
    case 'people_enable':
      return `${actor} enabled someone on ${target}`;
    case 'people_disable':
      return `${actor} disabled someone on ${target}`;
    case 'emerald_enable':
      return `${actor} enabled Emerald membership for ${target}`;
    case 'emerald_disable':
      return `${actor} disabled Emerald membership for ${target}`;
    case 'review_requested':
      return `${actor} requested ${target} review.`;
    case 'review_closed':
      return `${actor} closed ${target} review.`;
  }
}
