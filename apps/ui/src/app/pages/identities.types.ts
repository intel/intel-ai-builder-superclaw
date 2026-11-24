/** Props for the Identities page. */
import type { OpenworkServerClient } from "../lib/openwork-server";
import type { OpenworkServerStatus } from "../lib/openwork-server";
import type { TavilyKeyView } from "~/features/tavily-api-key";
import type { InstanceApiClient } from "~/shared/platform/transport/instance-api";

/** What the Connections page asks of the host about channel credentials; null until ServiceHub is configured. */
export type ChannelCredentialsClient = Pick<
  InstanceApiClient,
  | "saveSlackIdentity"
  | "saveTelegramIdentity"
  | "deleteChannelIdentity"
  | "setChannelEnabled"
  | "sendChannelMessage"
  | "setChannelBinding"
  | "slackSenders"
  | "setSlackSender"
  | "startSlackInstall"
  | "slackInstallStatus"
  | "completeSlackInstall"
  | "cancelSlackInstall"
  | "setSlackIdentityEnabled"
  | "setTelegramIdentityEnabled"
>;

export type IdentitiesViewProps = {
  busy: boolean;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerUrl: string;
  openworkServerClient: OpenworkServerClient | null;
  openworkReconnectBusy: boolean;
  reconnectOpenworkServer: () => Promise<boolean>;
  openworkServerWorkspaceId: string | null;
  activeWorkspaceRoot: string;
  developerMode: boolean;
  /** Slack and Telegram tokens go to the host through ServiceHub, never through openwork-server. */
  channelCredentials: ChannelCredentialsClient | null;
  tavilyKeyView: TavilyKeyView;
  tavilyApiKeyStatus: "idle" | "loading" | "saving" | "error";
  refreshTavilyApiKey: () => Promise<void>;
  saveTavilyApiKey: (apiKey: string) => Promise<void>;
  clearTavilyApiKey: () => Promise<void>;
  /** Pause or resume the saved key; it stays with the host either way. */
  setTavilyApiKeyEnabled: (enabled: boolean) => Promise<void>;
};
