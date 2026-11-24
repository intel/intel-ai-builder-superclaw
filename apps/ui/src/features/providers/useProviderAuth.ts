import { createSignal, type Accessor } from "solid-js"
import type { ProviderListItem } from "~/shared/types/models"
import {
    createProviderAuthService, type ProviderAuthMethod, type ProviderOAuthStartResult, type ProviderOAuthStatusResult,
} from "./providerAuthService";

export type LlmRouterAuthClient = {
    startOauthLogin: (providerId: string) => Promise<{
        flow_kind?: "device" | "auto" | "code" | "pkce";
        authorize_url?: string;
        verification_uri?: string;
        user_code?: string;
        expires_at?: number;
    }>;
    pollOauthStatus: (providerId: string) => Promise<{
        status:
            | "not_started"
            | "awaiting_callback"
            | "awaiting_authorization"
            | "exchanging"
            | "complete"
            | "cancelled"
            | "error";
        error?: { message?: string };
    }>;
    cancelOauthLogin: (providerId: string) => Promise<{ ok: boolean }>;
    putProvider?: (providerId: string, body: { api_key: string }) => Promise<{ ok: boolean }>;
    deleteProvider?: (providerId: string) => Promise<{ ok: boolean }>;
    deleteOauthSession?: (providerId: string) => Promise<{ ok: boolean }>;
    submitApiKey?: (providerId: string, apiKey: string) => Promise<void>;
} | null;

export type UseProviderAuthDeps = {
    llmRouterClient: () => LlmRouterAuthClient;
    refreshLlmRouterProviders: () => Promise<ProviderListItem[]>;
}

export function useProviderAuth(deps: UseProviderAuthDeps) {
    const service = createProviderAuthService(deps);
    const [providerAuthModalOpen, setProviderAuthModalOpen] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);
    const [authMethods, setAuthMethods] = createSignal<Record<string, ProviderAuthMethod[]>>({});
    const [loadingMethods, setLoadingMethods] = createSignal(false);


    const openAuthModal = async () => {
        setProviderAuthModalOpen(true);
        setError(null);

        if (Object.keys(authMethods()).length === 0) {
            setLoadingMethods(true);
            try {
                const next = await service.loadAuthMethods();
                setAuthMethods(next);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load providers.");
            } finally {
                setLoadingMethods(false);
            }
        }
    };



    const closeAuthModal = () => {
        setProviderAuthModalOpen(false);
        setError(null);
    };

    const startAuth = async (providerId: string): Promise<ProviderOAuthStartResult> => {
        setBusy(true);
        setError(null);

        try {
            return await service.startAuth(providerId);
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to start OAuth login.";
            setError(message);
            throw err;
        } finally {
            setBusy(false);
        }
    };

    const completeOAuth = async (
        providerId: string,
        methodIndex: number,
        code?: string,
    ): Promise<ProviderOAuthStatusResult> => {
        // Deliberately leaves `busy` alone. The modal re-drives this every 2s and
        // renders its whole body behind `<Show when={!loading}>`, so toggling the
        // signal per poll unmounts the device code mid-copy. Disabling the
        // controls during a user-initiated submit is the caller's `submitting`.
        setError(null);

        try {
            const result = await service.completeOAuth(providerId, methodIndex, code);
            // A non-terminal poll carries the raw flow status as its message
            // (e.g. "awaiting_authorization"), which is progress, not failure.
            // Gate on the terminal flag rather than the absence of `pending`, so
            // a future in-flight status that carries a message but forgets to set
            // `pending` cannot flash a red box on the device dialog again.
            if (!result.connected && result.message && result.terminated) {
                setError(result.message);
            }
            return result;
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "OAuth status poll failed.";
            setError(message);
            throw err;
        }
    };

    const cancelOAuth = async (providerId: string): Promise<void> => {
        setBusy(true);
        try {
            await service.cancelOAuth(providerId);
        } finally {
            setBusy(false);
        }
    };

    const submitApiKey = async (providerId: string, apiKey: string): Promise<string | void> => {
        setBusy(true);
        setError(null);

        try {
            await service.submitApiKey(providerId, apiKey);
            await deps.refreshLlmRouterProviders();
            return;
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to save API key.";
            setError(message);
            throw err;
        } finally {
            setBusy(false);
        }
    };

    const disconnectProvider = async (providerId: string): Promise<string | void> => {
        setBusy(true);
        setError(null);

        try {
            const result = await service.disconnectProvider(providerId);
            await deps.refreshLlmRouterProviders();
            return result;
        } catch (err) {
            const message =
                err instanceof Error ? err.message : "Failed to disconnect provider.";
            setError(message);
            throw err;
        } finally {
            setBusy(false);
        }
    };

    return {
        providerAuthModalOpen: providerAuthModalOpen as Accessor<boolean>,
        busy: busy as Accessor<boolean>,
        error: error as Accessor<string | null>,
        authMethods: authMethods as Accessor<Record<string, ProviderAuthMethod[]>>,
        loadingMethods: loadingMethods as Accessor<boolean>,
        openAuthModal,
        closeAuthModal,
        startAuth,
        completeOAuth,
        cancelOAuth,
        submitApiKey,
        disconnectProvider,
        refreshAuthMethods: async () => {
            setLoadingMethods(true);
            try {
                setAuthMethods(await service.loadAuthMethods());
            } finally {
                setLoadingMethods(false);
            }
        },
    };
}