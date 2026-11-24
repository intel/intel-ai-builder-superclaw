// Serialises writes to a single adapter slot in the bridge's adapters map.
//
// An identity upsert stops the running adapter before installing its
// replacement, and that stop is an await point. Without a per-slot queue two
// concurrent upserts for the same identity can interleave there and leave the
// adapters map serving one request's credentials while the persisted config
// holds the other's (#2961 item 3). Deletes take the same slot, so a delete
// racing an upsert cannot drop the replacement either.

export type AdapterSlotQueue = {
  /** Runs `task` with no other writer for `key` in flight. */
  withSlot: <T>(key: string, task: () => Promise<T>) => Promise<T>;
};

export const createAdapterSlotQueue = (): AdapterSlotQueue => {
  const tails = new Map<string, Promise<void>>();

  const withSlot = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    // Resolves rather than rejects when the task fails, so one failed writer
    // does not reject every writer queued behind it.
    // Assigned by the executor below before this function reaches its first await.
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Claimed synchronously, before the first await, so writers queue in the
    // order they arrived.
    tails.set(key, settled);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(key) === settled) tails.delete(key);
    }
  };

  return { withSlot };
};
