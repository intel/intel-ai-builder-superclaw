import {
  createContext,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";

export type GlobalSessionSearchScrollTarget = {
  sessionId: string;
  /** Absent for title-only matches: nothing to scroll to, but the query still highlights. */
  messageId?: string;
  query: string;
};

type GlobalSessionSearchScrollContextValue = {
  scrollTarget: Accessor<GlobalSessionSearchScrollTarget | null>;
  /** Bumps whenever a new scroll target is requested (including repeat picks). */
  scrollRequestToken: Accessor<number>;
  setScrollTarget: (value: GlobalSessionSearchScrollTarget | null) => void;
};

const GlobalSessionSearchScrollContext =
  createContext<GlobalSessionSearchScrollContextValue>();

export function GlobalSessionSearchScrollProvider(props: ParentProps) {
  const [scrollTarget, setScrollTargetSignal] =
    createSignal<GlobalSessionSearchScrollTarget | null>(null);
  const [scrollRequestToken, setScrollRequestToken] = createSignal(0);

  const setScrollTarget = (value: GlobalSessionSearchScrollTarget | null) => {
    setScrollTargetSignal(value);
    if (value) {
      setScrollRequestToken((token) => token + 1);
    }
  };

  return (
    <GlobalSessionSearchScrollContext.Provider
      value={{ scrollTarget, scrollRequestToken, setScrollTarget }}
    >
      {props.children}
    </GlobalSessionSearchScrollContext.Provider>
  );
}

export function useGlobalSessionSearchScroll() {
  return useContext(GlobalSessionSearchScrollContext);
}
