// In-process serialization queue for an agent's public handlers.
//
// Each agent has its own instance. NOTIFY-driven handlers
// (`onClientRegistered`, `reconcile`, `recoverChannelsFor`) and the
// periodic tick all funnel through `enqueue()`, so they can never
// overlap.
//
// Without this, `client_registered` + `admin_changed` + `user_active`
// fire near-simultaneously on a fresh launch and each handler's
// `newGroup()` (the slow part) finishes before the existence check that
// would have stopped a second handler — so two MLS groups get created
// for the same `(client, role)` slot and the user receives duplicate
// welcomes.
//
// Failures don't break the chain: a rejected task propagates back to
// the caller (so they can `.catch()` if they care) but the queue itself
// recovers and runs the next task.

export class WorkQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly label: string,
    private readonly onError: (taskLabel: string, err: Error) => void = () => {},
  ) {}

  enqueue<T>(taskLabel: string, fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(() =>
      fn().catch((err) => {
        this.onError(taskLabel, err as Error);
        throw err;
      }),
    );
    // Don't propagate per-task rejections through the chain itself;
    // we want subsequent tasks to keep running.
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Resolves once every currently-queued task has run. Useful in tests. */
  drain(): Promise<void> {
    return this.chain;
  }
}
