/* @refresh reload */
import { render } from "solid-js/web";
import { HashRouter, Route, Router } from "@solidjs/router";

import { bootstrapTheme } from "./app/theme";
import "./app/index.css";
import AppEntry from "./app/entry";
import { PlatformProvider, type Platform } from "./app/context/platform";
import { getOpenWorkDeployment } from "./app/lib/openwork-deployment";
import { isTauriRuntime } from "./app/utils";
import { initLocale } from "./i18n";

bootstrapTheme();
initLocale();

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

root.dataset.openworkDeployment = getOpenWorkDeployment();

const RouterComponent = isTauriRuntime() ? HashRouter : Router;

function shouldOpenInCurrentTab(url: string) {
  return /^(mailto|tel):/i.test(url.trim());
}

function logUiExternalOpenIntent(source: string, rawUrl: string) {
  const trimmed = rawUrl.trim();
  let protocol = "unknown";
  let host = "unknown";
  try {
    const parsed = new URL(trimmed);
    protocol = parsed.protocol.replace(/:$/, "") || "unknown";
    host = parsed.host || "unknown";
  } catch {
    protocol = trimmed.split(":", 1)[0] || "unknown";
    host = protocol === "mailto" || protocol === "tel" ? protocol : "invalid-url";
  }
  console.info(`[ui] external open intent source=${source} protocol=${protocol} host=${host}`);
}

const platform: Platform = {
  platform: isTauriRuntime() ? "desktop" : "web",
  openLink(url: string): void | Promise<void> {
    logUiExternalOpenIntent("platform.openLink", url);
    if (isTauriRuntime()) {
      const openPromise = import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
        openUrl(url),
      );
      // Fire-and-forget call sites ignore the return value; attaching catch avoids
      // unhandled rejections while `await openLink(...)` still observes failures.
      openPromise.catch(() => undefined);
      return openPromise;
    }

    if (shouldOpenInCurrentTab(url)) {
      window.location.href = url;
      return;
    }

    window.open(url, "_blank");
  },
  restart: async () => {
    if (isTauriRuntime() && import.meta.env.DEV) {
      window.location.reload();
      return;
    }

    if (isTauriRuntime()) {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
      return;
    }

    window.location.reload();
  },
  notify: async (title, description, href) => {
    if (!("Notification" in window)) return;

    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission().catch(() => "denied")
        : Notification.permission;

    if (permission !== "granted") return;

    const inView = document.visibilityState === "visible" && document.hasFocus();
    if (inView) return;

    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
        });
        notification.onclick = () => {
          window.focus();
          if (href) {
            window.history.pushState(null, "", href);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
          notification.close();
        };
      })
      .catch(() => undefined);
  },
  storage: (name) => {
    const prefix = name ? `${name}:` : "";
    return {
      getItem: (key) => window.localStorage.getItem(prefix + key),
      setItem: (key, value) => window.localStorage.setItem(prefix + key, value),
      removeItem: (key) => window.localStorage.removeItem(prefix + key),
    };
  },
  fetch,
};

render(
  () => (
    <PlatformProvider value={platform}>
      <RouterComponent root={AppEntry}>
        <Route path="*all" component={() => null} />
      </RouterComponent>
    </PlatformProvider>
  ),
  root,
);

// Show the Tauri window now that SolidJS has rendered the first frame.
// The window starts hidden (visible:false in tauri.conf.json) to avoid
// a black/white flash while Vite compiles or the JS bundle loads.
// show() alone leaves a relaunched process (e.g. the one an in-app installer
// update starts) behind the window that holds the foreground.
if (isTauriRuntime()) {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      return appWindow.show().then(() => appWindow.setFocus());
    })
    .catch((e) => console.warn("[splash] Failed to show window:", e));
}
