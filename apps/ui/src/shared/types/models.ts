export type ProviderListItem = {
  id: string;
  name?: string;
  env?: string[];
  configured?: boolean;
  apiKeySet?: boolean;
  oauthSet?: boolean;
  models?: Record<
    string,
    {
      id: string;
      name?: string;
      status?: string;
      release_date?: string;
      cost?: { input?: number; output?: number };
      capabilities?: { reasoning?: boolean };
      api?: { url?: string; npm?: string };
    }
  >;
};

export type ModelRef = {
  providerID: string;
  modelID: string;
};

export type ModelOption = {
  providerID: string;
  modelID: string;
  title: string;
  description?: string;
  footer?: string;
  disabled?: boolean;
  isFree: boolean;
  isConnected: boolean;
  /** True when the provider runs locally (no PII detection needed) */
  isLocal: boolean;
};
