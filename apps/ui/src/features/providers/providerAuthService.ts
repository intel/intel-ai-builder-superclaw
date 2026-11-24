import type { ProviderListItem } from "~/shared/types/models";

export type ProviderAuthMethod = {
    type: "oauth" | "api";
    label: string;
};

export type ProviderOAuthStartResult = {
    methodIndex: number;
    authorization: {
        url: string;
        method?: "auto" | "code" | "device";
        userCode?: string;
        verificationUri?: string;
        instructions?: string;
    };
    expiresAtMs?: number;
};

export type ProviderOAuthStatusResult = {
    connected: boolean;
    pending?: boolean;
    terminated?: boolean;
    message?: string;
};

export type ProviderAuthServiceDeps = {
    llmRouterClient: () => {
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
        submitApiKey?: (providerId: string, key: string) => Promise<void>;
    } | null;
    refreshLlmRouterProviders: () => Promise<ProviderListItem[]>;
};

const OAUTH_PROVIDER_IDS = new Set(["openai", "github_copilot"]);

export function createProviderAuthService(deps: ProviderAuthServiceDeps) {
    const loadAuthMethods = async (): Promise<Record<string, ProviderAuthMethod[]>> => {
        const providers = await deps.refreshLlmRouterProviders();
        return Object.fromEntries(
            providers.map((provider) => {
                const methods: ProviderAuthMethod[] = [];
                if (provider.id === "github_copilot") {
                    methods.push({ type: "oauth", label: "OAuth" });
                    return [provider.id, methods];
                }
                if (provider.id === "openai") {
                    methods.push({ type: "oauth", label: "OAuth" });
                }
                methods.push({ type: "api", label: "API key" });
                return [provider.id, methods];
            }),
        );
    };

    const startAuth = async (providerId: string): Promise<ProviderOAuthStartResult> => {
        const client = deps.llmRouterClient();
        if(!client) throw new Error("ServiceHub is not connected.");

        const started = await client.startOauthLogin(providerId);

        if (started.flow_kind === "device") {
            return {
                methodIndex: 0,
                authorization: {
                    url: started.verification_uri ?? "",
                    method: "device",
                    userCode: started.user_code ?? "",
                    verificationUri: started.verification_uri ?? "",
                },
                expiresAtMs: (started.expires_at ?? 0) * 1000,
            };
        }

        const method: ProviderOAuthStartResult["authorization"]["method"] =
            started.flow_kind === "code" ? "code" : "auto";

        return {
            methodIndex: 0,
            authorization: {
                url: started.authorize_url ?? "",
                method,
            },
            expiresAtMs: (started.expires_at ?? 0) * 1000,
        };
    };

    const completeOAuth = async ( providerId: string, methodIndex: number, code?: string ) : Promise<ProviderOAuthStatusResult> => {
        void methodIndex;
        void code;

        const client = deps.llmRouterClient();
        if (!client) throw new Error("ServiceHub is not connected.");

        const snapshot = await client.pollOauthStatus(providerId);

        if(snapshot.status === "complete"){
            await deps.refreshLlmRouterProviders();
            return { connected: true };
        }

        if(snapshot.status === "error" || snapshot.status === "cancelled" || snapshot.status === "not_started"){
            const detail = snapshot.error?.message || snapshot.status;
            // The flow is over, so release it server-side rather than leaving a
            // dead record that a later login has to step around. Best-effort by
            // design: cancelOAuth swallows the failure, and the caller is being
            // told the login is finished either way.
            void cancelOAuth(providerId);
            return {
                connected: false,
                terminated: true,
                message: snapshot.status === "not_started" ? "OAuth login session ended. Close this dialog and try again." :
                                                             `OAuth login ${snapshot.status}: ${detail}`,
            };
        }

        return {
            connected: false,
            pending: true,
            message: snapshot.status,
        };
    };

    const cancelOAuth = async (providerId: string): Promise<{ ok: boolean } | void> => {
        const client = deps.llmRouterClient();
        if(!client) return;

        try {
            return await client.cancelOauthLogin(providerId.trim());
        } catch {
            // no operation: end user is navigating away or auth already ended
        }
    };

    const submitApiKey = async (providerId: string, apiKey: string) : Promise<void> => {
        const client = deps.llmRouterClient();
        if(!client) throw new Error("ServiceHub is not connected.");

        const trimmedProviderId = providerId.trim();
        const trimmedApiKey = apiKey.trim();
        if(!trimmedProviderId || !trimmedApiKey){
            throw new Error("Provider ID and API key are required.");
        }

        if (client.putProvider) {
            const response = await client.putProvider(trimmedProviderId, { api_key: trimmedApiKey });
            if (!response.ok) {
                throw new Error("Failed to save API key.");
            }
            return;
        }

        if (client.submitApiKey) {
            await client.submitApiKey(trimmedProviderId, trimmedApiKey);
            return;
        }

        throw new Error("API key submission is not supported for this provider.");
    };

    const disconnectProvider = async (providerId: string): Promise<string | void> => {
        const client = deps.llmRouterClient();
        if (!client) {
            throw new Error("ServiceHub is not connected.");
        }

        const resolved = providerId.trim();
        if (!resolved) {
            throw new Error("Provider ID is required");
        }

        const providers = await deps.refreshLlmRouterProviders();
        const provider = providers.find((item) => item.id === resolved);

        let removed = false;
        try {
            if (provider?.apiKeySet && client.deleteProvider) {
                await client.deleteProvider(resolved);
                removed = true;
            }
            // Not gated on the listed oauthSet: that listing degrades to empty on error, and the DELETE is idempotent.
            if (OAUTH_PROVIDER_IDS.has(resolved) && client.deleteOauthSession) {
                try {
                    await client.deleteOauthSession(resolved);
                } catch (error) {
                    const status = (error as { status?: unknown }).status;
                    if (status !== 404) throw error;
                }
                removed = true;
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : "Failed to disconnect provider";
            throw new Error(message);
        }
        if (!removed) {
            throw new Error(`No stored credential found for ${resolved}.`);
        }
        return `Disconnected ${resolved}`;
    };

    return {
        loadAuthMethods,
        startAuth,
        completeOAuth,
        cancelOAuth,
        submitApiKey,
        disconnectProvider,
    };
};
