import { createContext, useContext, type ParentProps } from "solid-js";

const SessionGlobalSearchOpenContext = createContext<
  (() => void) | undefined
>(undefined);

export function SessionGlobalSearchProvider(
  props: ParentProps<{ open: () => void }>,
) {
  return (
    <SessionGlobalSearchOpenContext.Provider value={props.open}>
      {props.children}
    </SessionGlobalSearchOpenContext.Provider>
  );
}

export function useSessionGlobalSearchOpen() {
  return useContext(SessionGlobalSearchOpenContext);
}
