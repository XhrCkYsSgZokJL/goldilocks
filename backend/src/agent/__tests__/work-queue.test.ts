import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WorkQueue } from '../work-queue.js';

describe('WorkQueue', () => {
  it('runs tasks strictly sequentially even when enqueued at the same tick', async () => {
    const q = new WorkQueue('test');
    const events: string[] = [];

    const slow = q.enqueue('slow', async () => {
      events.push('slow:start');
      await new Promise((r) => setTimeout(r, 50));
      events.push('slow:end');
    });
    const fast = q.enqueue('fast', async () => {
      events.push('fast:start');
      events.push('fast:end');
    });

    await Promise.all([slow, fast]);

    // The "fast" task only gets to start after "slow" finishes — that's
    // the contract that prevents the duplicate-MLS-group race.
    assert.deepEqual(events, ['slow:start', 'slow:end', 'fast:start', 'fast:end']);
  });

  it('a rejected task does NOT break the chain — subsequent tasks still run', async () => {
    const errors: Array<{ label: string; err: Error }> = [];
    const q = new WorkQueue('test', (label, err) => errors.push({ label, err }));

    const failed = q.enqueue('failer', async () => {
      throw new Error('boom');
    });
    const followup = q.enqueue('followup', async () => 'ok');

    await assert.rejects(failed, /boom/);
    assert.equal(await followup, 'ok');
    assert.equal(errors.length, 1);
    const captured = errors[0];
    assert.ok(captured);
    assert.equal(captured.label, 'failer');
    assert.match(captured.err.message, /boom/);
  });

  it('drain() resolves only after every queued task has completed', async () => {
    const q = new WorkQueue('test');
    const completed: string[] = [];

    void q.enqueue('a', async () => { await new Promise((r) => setTimeout(r, 10)); completed.push('a'); });
    void q.enqueue('b', async () => { await new Promise((r) => setTimeout(r, 10)); completed.push('b'); });
    void q.enqueue('c', async () => { await new Promise((r) => setTimeout(r, 10)); completed.push('c'); });

    await q.drain();
    assert.deepEqual(completed, ['a', 'b', 'c']);
  });

  it('returns the resolved value of the inner task', async () => {
    const q = new WorkQueue('test');
    const result = await q.enqueue('echo', async () => 42);
    assert.equal(result, 42);
  });
});
