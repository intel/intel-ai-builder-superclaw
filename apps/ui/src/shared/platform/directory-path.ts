import { isWindowsPlatform } from "~/shared/platform/runtime-env";
import { normalizeDirectoryQueryPath } from "~/shared/util/format";

// Not in `util/` beside the sibling it calls: the answer depends on the host, which is
// the line `shared/README.md` draws between the two buckets.
export function normalizeDirectoryPath(input?: string | null) {
  const normalized = normalizeDirectoryQueryPath(input);
  if (!normalized) return "";
  return isWindowsPlatform() ? normalized.toLowerCase() : normalized;
}
