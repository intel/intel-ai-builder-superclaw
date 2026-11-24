export type View = "onboarding" | "dashboard" | "session" | "proto";

export type OnboardingStep = "welcome" | "local" | "server" | "connecting";

export type DashboardTab =
  | "scheduled"
  | "skills"
  | "mcp"
  | "identities"
  | "agent"
  | "config"
  | "settings"
  | "data";

export type SettingsTab = "den" | "model" | "voice" | "app" | "privacy";

/** Where keyboard focus goes when a modal or picker closes. */
export type PromptFocusReturnTarget = "none" | "composer";
