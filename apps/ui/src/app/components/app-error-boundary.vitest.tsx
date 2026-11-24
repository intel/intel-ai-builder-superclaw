import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AppErrorBoundary, describeError } from "./app-error-boundary";

afterEach(() => cleanup());

/** Throws on first render, succeeds afterwards — lets us exercise reset(). */
function FlakyChild(props: { failures: { count: number } }) {
  if (props.failures.count > 0) {
    props.failures.count -= 1;
    throw new Error("boom from child");
  }
  return <div data-testid="child-ok">recovered</div>;
}

describe("describeError", () => {
  test("prefers Error.message", () => {
    expect(describeError(new Error("kaboom"))).toBe("kaboom");
  });

  test("falls back to the error name when the message is empty", () => {
    expect(describeError(new TypeError(""))).toBe("TypeError");
  });

  test("passes strings through", () => {
    expect(describeError("plain string")).toBe("plain string");
  });

  test("serialises non-Error values", () => {
    expect(describeError({ code: 42 })).toBe('{"code":42}');
  });

  test("survives values that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});

describe("AppErrorBoundary", () => {
  test("contains a render throw instead of unmounting the tree", () => {
    // Solid logs the caught error; keep the test output clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(() => (
      <AppErrorBoundary scope="page:test">
        <FlakyChild failures={{ count: Infinity }} />
      </AppErrorBoundary>
    ));

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("boom from child")).toBeTruthy();
    // The child never rendered, but the boundary did — i.e. contained, not white-screened.
    expect(screen.queryByTestId("child-ok")).toBeNull();

    spy.mockRestore();
  });

  test("root variant offers reload, panel variant does not", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(() => (
      <AppErrorBoundary scope="root" variant="root">
        <FlakyChild failures={{ count: Infinity }} />
      </AppErrorBoundary>
    ));
    expect(screen.getByText("Reload")).toBeTruthy();
    cleanup();

    render(() => (
      <AppErrorBoundary scope="page:test">
        <FlakyChild failures={{ count: Infinity }} />
      </AppErrorBoundary>
    ));
    expect(screen.queryByText("Reload")).toBeNull();
    expect(screen.getByText("Try again")).toBeTruthy();

    spy.mockRestore();
  });

  test("Try again re-renders the subtree", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failures = { count: 1 };

    render(() => (
      <AppErrorBoundary scope="page:test">
        <FlakyChild failures={failures} />
      </AppErrorBoundary>
    ));

    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));

    expect(screen.getByTestId("child-ok")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    spy.mockRestore();
  });

  test("tags the fallback with its scope for triage", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(() => (
      <AppErrorBoundary scope="page:session">
        <FlakyChild failures={{ count: Infinity }} />
      </AppErrorBoundary>
    ));

    expect(screen.getByRole("alert").getAttribute("data-scope")).toBe("page:session");

    spy.mockRestore();
  });
});
