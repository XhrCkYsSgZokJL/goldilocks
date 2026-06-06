import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, type ListenerHandlers } from '../listener.js';

const recordingHandlers = (): { handlers: ListenerHandlers; calls: Array<{ channel: string; payload: unknown }> } => {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const handlers: ListenerHandlers = {
    onAdminChanged: async (p) => { calls.push({ channel: 'admin_changed', payload: p }); },
    onClientRegistered: async (p) => { calls.push({ channel: 'client_registered', payload: p }); },
    onUserActive: async (p) => { calls.push({ channel: 'user_active', payload: p }); },
    onChannelsRecover: async (p) => { calls.push({ channel: 'channels_recover', payload: p }); },
    onPeopleListChanged: async (p) => { calls.push({ channel: 'people_list_changed', payload: p }); },
    onAuditEvent: async (p) => { calls.push({ channel: 'audit_event', payload: p }); },
    onAdvisoryMessage: async (p) => { calls.push({ channel: 'advisory_message', payload: p }); },
  };
  return { handlers, calls };
};

describe('listener.dispatch', () => {
  it('routes channels_recover to onChannelsRecover with the parsed payload', async () => {
    const { handlers, calls } = recordingHandlers();
    const payload = JSON.stringify({ client_id: 'uuid-1', inbox_id: 'inbox-abc' });

    await dispatch('channels_recover', payload, handlers);

    assert.equal(calls.length, 1);
    const first = calls[0];
    assert.ok(first);
    assert.equal(first.channel, 'channels_recover');
    assert.deepEqual(first.payload, { client_id: 'uuid-1', inbox_id: 'inbox-abc' });
  });

  it('routes people_list_changed to onPeopleListChanged with the parsed payload', async () => {
    const { handlers, calls } = recordingHandlers();
    const payload = JSON.stringify({ client_id: 'uuid-9' });

    await dispatch('people_list_changed', payload, handlers);

    assert.equal(calls.length, 1);
    const first = calls[0];
    assert.ok(first);
    assert.equal(first.channel, 'people_list_changed');
    assert.deepEqual(first.payload, { client_id: 'uuid-9' });
  });

  it('routes client_registered, admin_changed, user_active to their respective handlers', async () => {
    const { handlers, calls } = recordingHandlers();

    await dispatch('client_registered', JSON.stringify({ client_id: 'c-1', client_number: 1, inbox_id: 'inbox-1' }), handlers);
    await dispatch('admin_changed', JSON.stringify({ op: 'INSERT', inbox_id: 'inbox-2', name: 'Tillie' }), handlers);
    await dispatch('user_active', JSON.stringify({ client_id: 'c-3', inbox_id: 'inbox-3', is_admin: false }), handlers);

    assert.deepEqual(calls.map((c) => c.channel), ['client_registered', 'admin_changed', 'user_active']);
  });

  it('swallows malformed JSON without invoking any handler', async () => {
    const { handlers, calls } = recordingHandlers();
    await dispatch('channels_recover', '{ this is not json', handlers);
    assert.equal(calls.length, 0);
  });

  it('does not call any handler for an unknown channel', async () => {
    const { handlers, calls } = recordingHandlers();
    await dispatch('something_we_did_not_define', JSON.stringify({}), handlers);
    assert.equal(calls.length, 0);
  });

  it('catches handler errors so one bad event does not crash the listener loop', async () => {
    const handlers: ListenerHandlers = {
      onAdminChanged: async () => {},
      onClientRegistered: async () => { throw new Error('handler exploded'); },
      onUserActive: async () => {},
      onChannelsRecover: async () => {},
      onPeopleListChanged: async () => {},
      onAuditEvent: async () => {},
      onAdvisoryMessage: async () => {},
    };

    // Should not throw — dispatch swallows handler errors and logs them.
    await dispatch('client_registered', JSON.stringify({ client_id: 'x', client_number: 1, inbox_id: 'y' }), handlers);
    assert.ok(true);
  });
});
