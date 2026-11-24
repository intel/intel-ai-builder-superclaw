/**
 * Polls for skills the skill-creator agent writes outside the UI's knowledge.
 *
 * The agent creates skill files directly on disk, so nothing notifies the app
 * when one appears. The watch re-reads the skill list until the set actually
 * changes, then stops. It gives up after `WATCH_TIMEOUT_MS` so a run that
 * produces no skill cannot poll forever.
 *
 * Each call supersedes any watch already running. A generation counter, rather
 * than the timer handle alone, is what makes that safe: an in-flight refresh
 * from the previous watch can still resolve after the new one starts, and it
 * must not clear the new timer or bump caches on the new watch's behalf.
 */
import { onCleanup } from "solid-js";
import type { Accessor } from "solid-js";

const WATCH_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_500;

type SkillCreatorWatchDeps = {
  skills: Accessor<readonly { name?: string | null }[]>;
  refreshSkills: (options?: { force?: boolean }) => Promise<void>;
  /** Invalidates the slash-command list, which is derived from the skill set. */
  bumpCommandsVersion: () => void;
};

export const createSkillCreatorWatch = (deps: SkillCreatorWatchDeps) => {
  const { skills, refreshSkills, bumpCommandsVersion } = deps;

  let refreshTimer: number | null = null;
  let generation = 0;

  const skillSetFingerprint = () =>
    skills()
      .map((skill) => skill.name)
      .filter(Boolean)
      .sort()
      .join("\n");

  const clearTimer = () => {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  const startSkillCreatorRefreshWatch = () => {
    generation += 1;
    const thisGeneration = generation;

    clearTimer();

    const startedAt = Date.now();
    const initialSkillSet = skillSetFingerprint();
    let busy = false;

    const expired = () => Date.now() - startedAt >= WATCH_TIMEOUT_MS;
    const superseded = () => thisGeneration !== generation;

    const stopRefreshWatch = () => {
      if (superseded()) return;
      clearTimer();
    };

    const refreshSkillAndCommandCaches = async () => {
      if (busy) return;
      busy = true;
      try {
        await refreshSkills({ force: true });
        if (superseded()) return;
        bumpCommandsVersion();
        if (skillSetFingerprint() !== initialSkillSet || expired()) {
          stopRefreshWatch();
        }
      } catch {
        if (expired()) {
          stopRefreshWatch();
        }
      } finally {
        busy = false;
      }
    };

    refreshTimer = window.setInterval(() => {
      if (superseded() || expired()) {
        stopRefreshWatch();
        return;
      }
      void refreshSkillAndCommandCaches();
    }, POLL_INTERVAL_MS);

    void refreshSkillAndCommandCaches();
  };

  /** A write to a skill already listed needs one refresh, not a watch for the set to change. */
  const refreshWrittenSkill = (name?: string) => {
    if (!name || !skills().some((skill) => skill.name === name)) {
      startSkillCreatorRefreshWatch();
      return;
    }
    void refreshSkills({ force: true }).then(bumpCommandsVersion, () => undefined);
  };

  onCleanup(() => {
    generation += 1;
    clearTimer();
  });

  return { startSkillCreatorRefreshWatch, refreshWrittenSkill };
};
