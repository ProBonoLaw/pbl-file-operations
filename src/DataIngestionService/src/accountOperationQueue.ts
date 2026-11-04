interface AccountState {
  exclusive: Promise<void>;
  sources: Map<string, Promise<void>>;
  pending: number;
}

export class AccountOperationQueue {
  private readonly accounts = new Map<string, AccountState>();
  private readonly waiters: Array<(release: () => void) => void> = [];
  private active = 0;

  constructor(private readonly maxConcurrency = 2) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) {
      throw new Error("DATA_INGESTION_MAX_CONCURRENCY must be an integer from 1 to 8");
    }
  }

  // Retain the account-wide operation for callers that need exclusive access.
  run<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    return this.schedule(accountId, null, operation);
  }

  runSource<T>(accountId: string, sourceId: string, operation: () => Promise<T>): Promise<T> {
    return this.schedule(accountId, sourceId === "PURGE_ACCOUNT" ? null : sourceId, operation);
  }

  private async schedule<T>(accountId: string, sourceId: string | null,
    operation: () => Promise<T>): Promise<T> {
    let state = this.accounts.get(accountId);
    if (!state) {
      state = { exclusive: Promise.resolve(), sources: new Map(), pending: 0 };
      this.accounts.set(accountId, state);
    }
    state.pending++;

    let releaseOperation!: () => void;
    const finished = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const predecessors = sourceId === null
      ? [state.exclusive, ...state.sources.values()]
      : [state.exclusive, state.sources.get(sourceId) ?? Promise.resolve()];
    if (sourceId === null) state.exclusive = finished;
    else state.sources.set(sourceId, finished);

    let releaseSlot: (() => void) | undefined;
    try {
      await Promise.all(predecessors);
      releaseSlot = await this.acquireSlot();
      return await operation();
    } finally {
      releaseSlot?.();
      releaseOperation();
      if (sourceId !== null && state.sources.get(sourceId) === finished)
        state.sources.delete(sourceId);
      state.pending--;
      if (state.pending === 0) this.accounts.delete(accountId);
    }
  }

  private acquireSlot(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return Promise.resolve(() => this.releaseSlot());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) next(() => this.releaseSlot());
    else this.active--;
  }
}
