import { fetchOwtToken } from "~/shared/platform/transport/servicehub"
import {
    getServiceHubBootSnapshot, retryServiceHubBoot,
} from "~/shared/platform/tauri"
import { readOpenworkServerSettings, writeOpenworkServerSettings } from "~/shared/platform/transport/openwork-server"
import { startupOwtToken } from "~/shared/platform/capability/capability-startup-signal"
import { getRecoverableBootSnapshot } from "~/shared/util/backend-boot-policy"

export async function recoverBootSnapshot() {
    const snap = await getServiceHubBootSnapshot();
    return getRecoverableBootSnapshot(snap);
}

export async function connectDataPlaneIfNeeded() {
    const settings = readOpenworkServerSettings();
    const hubUrl = settings.hubUrl?.trim() ?? "";
    const hubToken = settings.hubToken?.trim() ?? "";

    if (!hubUrl || !hubToken) return { ok: false, reason: "missing-hub-settings" };

    const stashed = startupOwtToken();
    if (stashed) {
        const nextSettings = writeOpenworkServerSettings({
            ...settings,
            urlOverride: "http://127.0.0.1:8787",
            token: stashed,
        });
        return { ok: true, settings: nextSettings };
    }

    const result = await fetchOwtToken(hubUrl, hubToken);
    if (!result.ok) return { ok: false, reason: result.code };

    const nextSettings = writeOpenworkServerSettings({
        ...settings,
        urlOverride: "http://127.0.0.1:8787",
        token: result.token,
    });

    return { ok: true, settings: nextSettings };
}

export async function retryBoot() {
    return retryServiceHubBoot();
}