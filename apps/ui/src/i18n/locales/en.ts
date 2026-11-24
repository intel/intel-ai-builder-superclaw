/**
 * English translations, merged from the per-domain modules below.
 * Keys are looked up (never iterated), so cross-module order is irrelevant.
 */

import en_settings from "./en.settings";
import en_mcp from "./en.mcp";
import en_model_providers from "./en.model-providers";
import en_skills from "./en.skills";
import en_identities from "./en.identities";
import en_dashboard from "./en.dashboard";
import en_agents from "./en.agents";
import en_scheduled from "./en.scheduled";
import en_onboarding from "./en.onboarding";
import en_capability from "./en.capability";
import en_composer from "./en.composer";
import en_sessions from "./en.sessions";
import en_security from "./en.security";
import en_app_shell from "./en.app-shell";
import en_voice from "./en.voice";

export default {
  ...en_settings,
  ...en_mcp,
  ...en_model_providers,
  ...en_skills,
  ...en_identities,
  ...en_dashboard,
  ...en_agents,
  ...en_scheduled,
  ...en_onboarding,
  ...en_capability,
  ...en_composer,
  ...en_sessions,
  ...en_security,
  ...en_app_shell,
  ...en_voice,
};
