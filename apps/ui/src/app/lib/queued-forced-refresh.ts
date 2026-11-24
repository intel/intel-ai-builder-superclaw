/**
 * Wraps a list loader that ignores calls while a load is running.
 *
 * A forced call that arrives mid-load would otherwise be dropped, and the
 * running load may have read the data before the change the caller is
 * reacting to. Instead it queues one more load after the running one, and its
 * promise settles when that load does. Concurrent forced calls share the
 * queued load. A non-forced call during a load still returns immediately.
 */
export const createQueuedForcedRefresh = (
  load: (options?: { force?: boolean }) => Promise<void>,
) => {
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const refresh = (options?: { force?: boolean }): Promise<void> => {
    if (!running) {
      const current = load(options).finally(() => {
        if (running === current) running = null;
      });
      running = current;
      return current;
    }
    if (!options?.force) return Promise.resolve();
    queued ??= running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return refresh(options);
      });
    return queued;
  };

  return refresh;
};
