import { basename, dirname, extname, join } from "node:path/posix";

const numberedFilename = (filename: string, index: number) => {
  if (index === 1) return filename;
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem} (${index})${extension}`;
};

export const nextAvailableInboxPath = async (
  requestedPath: string,
  pathExists: (path: string) => Promise<boolean>,
) => {
  const directory = dirname(requestedPath);
  const filename = basename(requestedPath);
  for (let index = 1; ; index += 1) {
    const candidateName = numberedFilename(filename, index);
    const candidatePath = directory === "."
      ? candidateName
      : join(directory, candidateName);
    if (!(await pathExists(candidatePath))) return candidatePath;
  }
};

export const reserveNextAvailableInboxPath = async (
  requestedPath: string,
  reservePath: (path: string) => Promise<void>,
) => {
  const directory = dirname(requestedPath);
  const filename = basename(requestedPath);
  for (let index = 1; ; index += 1) {
    const candidateName = numberedFilename(filename, index);
    const candidatePath = directory === "."
      ? candidateName
      : join(directory, candidateName);
    try {
      await reservePath(candidatePath);
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
};

// Windows can transiently lock a just-created empty file (AV/indexer scanning
// the inbox reservation), making rename-over-it fail even though nothing else
// is writing to it. Retry a few times before giving up.
export const renameOverReservedPath = async (
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void>,
  options?: { retries?: number; delayMs?: number },
) => {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 50;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= retries || (code !== "EPERM" && code !== "EBUSY")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};