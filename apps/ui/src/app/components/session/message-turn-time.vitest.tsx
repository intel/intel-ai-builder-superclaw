import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, test } from "vitest";
import { setLocale } from "~/i18n";
import { formatElapsedMs } from "./message-list.format";
import { formatAbsoluteTurnTime, formatTurnTimeTooltip } from "./message-turn-clock";
import { MessageTurnTime } from "./message-turn-time";

const CREATED = Date.parse("2026-11-13T19:26:00Z");
const REPLY = {
  role: "assistant",
  parentID: "msg_user",
  time: { created: CREATED + 10_000, completed: CREATED + 16_500 },
};

afterEach(() => {
  cleanup();
  setLocale("en");
});

function focusTurnTime(): HTMLElement {
  const time = screen.getByTestId("turn-time");
  const trigger = time.closest<HTMLElement>("[tabindex='0']");
  if (!trigger) throw new Error("Turn time tooltip trigger is not focusable");
  fireEvent.focusIn(trigger);
  return trigger;
}

describe("MessageTurnTime", () => {
  test("keyboard focus opens the absolute time and duration", () => {
    setLocale("en");
    render(() => (
      <MessageTurnTime
        info={{ role: "assistant", time: { created: CREATED, completed: CREATED + 30_000 } }}
      />
    ));

    focusTurnTime();
    const absolute = formatAbsoluteTurnTime(CREATED + 30_000);
    expect(screen.getByRole("tooltip").textContent).toContain(
      formatTurnTimeTooltip(absolute, formatElapsedMs(30_000)),
    );
  });

  test("a multi-step reply is timed from its prompt, with no chip outside debug", () => {
    setLocale("en");
    render(() => (
      <MessageTurnTime info={REPLY} turnStartById={new Map([["msg_user", CREATED]])} />
    ));

    focusTurnTime();
    const absolute = formatAbsoluteTurnTime(CREATED + 16_500);
    expect(screen.getByRole("tooltip").textContent).toContain(
      formatTurnTimeTooltip(absolute, formatElapsedMs(16_500)),
    );
    expect(screen.queryByLabelText("Run elapsed time")).toBeNull();
  });

  test("the debug chip keeps its own run timer", () => {
    setLocale("en");
    render(() => (
      <MessageTurnTime
        info={REPLY}
        turnStartById={new Map([["msg_user", CREATED]])}
        elapsedMs={17_200}
      />
    ));

    expect(screen.getByLabelText("Run elapsed time").textContent).toBe(formatElapsedMs(17_200));
  });

  test("a user timestamp tooltip has no duration", () => {
    setLocale("en");
    render(() => <MessageTurnTime info={{ role: "user", time: { created: CREATED } }} />);

    focusTurnTime();
    expect(screen.getByRole("tooltip").textContent).toContain(formatAbsoluteTurnTime(CREATED));
    expect(screen.getByRole("tooltip").textContent).not.toContain("Worked for");
  });
});
