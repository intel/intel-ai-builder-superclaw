/**
 * The Windows notification that tells a user who is away from SuperClaw that it paused an action on
 * their computer because they used the mouse or keyboard.
 */
import { isTauriRuntime } from "~/shared/platform/runtime-env";

export type SendNotification = (title: string, body: string) => Promise<void>;

/** Through the notification plugin, asking for permission once if needed; outside Tauri, nothing. */
export const sendHostNotification: SendNotification = async (title, body) => {
  if (!isTauriRuntime()) return;
  const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
  let permitted = await isPermissionGranted();
  if (!permitted) permitted = (await requestPermission()) === "granted";
  if (permitted) sendNotification({ title, body });
};
