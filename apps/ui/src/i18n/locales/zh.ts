/**
 * Chinese translations, merged from the per-domain modules below.
 * Keys are looked up (never iterated), so cross-module order is irrelevant.
 */

import zh_settings from "./zh.settings";
import zh_mcp from "./zh.mcp";
import zh_model_providers from "./zh.model-providers";
import zh_skills from "./zh.skills";
import zh_identities from "./zh.identities";
import zh_dashboard from "./zh.dashboard";
import zh_agents from "./zh.agents";
import zh_scheduled from "./zh.scheduled";
import zh_onboarding from "./zh.onboarding";
import zh_capability from "./zh.capability";
import zh_composer from "./zh.composer";
import zh_sessions from "./zh.sessions";
import zh_security from "./zh.security";
import zh_app_shell from "./zh.app-shell";
import zh_voice from "./zh.voice";

export default {
  ...zh_settings,
  ...zh_mcp,
  ...zh_model_providers,
  ...zh_skills,
  ...zh_identities,
  ...zh_dashboard,
  ...zh_agents,
  ...zh_scheduled,
  ...zh_onboarding,
  ...zh_capability,
  ...zh_composer,
  ...zh_sessions,
  ...zh_security,
  ...zh_app_shell,
  ...zh_voice,
};
