/**
 * Minimal `bun:test` ambient declarations for type-checking the package's
 * Vitest-style unit tests.
 *
 * We deliberately avoid pulling in the full `bun-types` package because its
 * global `fetch` declaration lacks DOM's `preconnect` property and conflicts
 * with the app's heavy DOM-`fetch` usage (see `lib/opencode.ts`). The shim
 * below covers only the symbols our tests actually import, which keeps the
 * conflict from materializing at type-check time.
 *
 * If we later add tests that need more of the `bun:test` API (e.g. `mock`,
 * `beforeAll`, `beforeEach`), extend this file rather than adopting
 * `bun-types` package-wide.
 */
declare module "bun:test" {
  type AnyFn = (...args: unknown[]) => unknown;

  interface Matchers<T> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toMatchObject(expected: unknown): void;
    toContain(expected: unknown): void;
    toMatch(expected: string | RegExp): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeInstanceOf(expected: unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledTimes(times: number): void;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<Awaited<T>>;
    not: Matchers<T>;
  }

  interface ExpectStatic {
    <T>(actual: T): Matchers<T>;
  }

  interface MockedFn {
    mockImplementation(fn: AnyFn): MockedFn;
    mockRestore(): void;
    mock: { calls: unknown[][] };
  }

  export const test: (name: string, fn: () => void | Promise<void>) => void;
  export const describe: (name: string, fn: () => void) => void;
  export const expect: ExpectStatic;
  export const beforeEach: (fn: () => void | Promise<void>) => void;
  export const afterEach: (fn: () => void | Promise<void>) => void;
  export const afterAll: (fn: () => void | Promise<void>) => void;
  export const spyOn: <T extends Record<string, unknown>>(
    obj: T,
    method: keyof T,
  ) => MockedFn;
  export const mock: {
    <T extends AnyFn>(implementation?: T): T & MockedFn;
    module(id: string, factory: () => unknown): void;
  };
}
