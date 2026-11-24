export type Settled = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export interface StartupLogger {
  info(message: string, attributes: Record<string, unknown>, component: string): void;
}

// The pretty log format prints no timestamps, so each start-up step carries its own (#3928).
export function startupMarker(logger: StartupLogger, startedAt: number): (step: string) => void {
  return (step) => {
    const now = Date.now();
    logger.info(
      `Startup mark step=${step} at=${new Date(now).toISOString()} elapsed_ms=${now - startedAt}`,
      { step, elapsedMs: now - startedAt },
      "openwork-orchestrator",
    );
  };
}

// Never rejects, so it can stay unawaited while other start-up waits run without tripping Node's
// default `--unhandled-rejections=throw`.
export async function settle(task: Promise<unknown>): Promise<Settled> {
  try {
    await task;
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function throwIfFailed(result: Settled): void {
  if (!result.ok) throw result.error;
}

// Waits for `main`, but a failure of `background` is thrown as soon as it happens, with its own
// error. Whichever of the two fails first is the error thrown. The other task is not cancelled: a
// caller must not outlive the throw with it still running.
export async function awaitFailingFast(main: Promise<Settled>, background: Promise<Settled>): Promise<void> {
  const backgroundFailure = (async (): Promise<Settled> => {
    const result = await background;
    return result.ok ? main : result;
  })();
  throwIfFailed(await Promise.race([main, backgroundFailure]));
}
