import path from "node:path";

export type PathApi = Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "sep">;

// Windows paths are case-insensitive, and stored bindings are lowercased there.
const foldCase = (value: string, pathApi: PathApi) => (pathApi.sep === "\\" ? value.toLowerCase() : value);

export function isWithinRoot(root: string, candidate: string, pathApi: PathApi = path): boolean {
  const resolvedRoot = pathApi.resolve(root);
  const resolved = pathApi.resolve(candidate || resolvedRoot);
  const relativePath = pathApi.relative(resolvedRoot, resolved);
  if (!relativePath || relativePath === ".") return true;
  if (relativePath.startsWith("..") || pathApi.isAbsolute(relativePath)) return false;
  const rootKey = foldCase(resolvedRoot, pathApi);
  const resolvedKey = foldCase(resolved, pathApi);
  const boundary = rootKey.endsWith(pathApi.sep) ? rootKey : `${rootKey}${pathApi.sep}`;
  return resolvedKey === rootKey || resolvedKey.startsWith(boundary);
}
