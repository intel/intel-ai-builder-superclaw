/** Category toggles, custom skills/MCP, and optional category detail panel. */
import { For, Show, createEffect, createSignal } from "solid-js";
import { t } from "../../i18n";
import { Tooltip } from "~/shared/ui/tooltip";
import { agentCreatorSkillTooltip } from "./agent-creator-skill-tooltips";
import type { CapabilityCategory, CapabilityItem } from "./agent-creator.types";

export type AgentCreatorCapabilitySelectionProps = {
  visibleCategories: CapabilityCategory[];
  categoryEnabled: (categoryId: string) => boolean;
  onToggleCategory: (categoryId: string, enabled: boolean) => void;
  catalogError: string | null;
  expandedCategory: string | null;
  setExpandedCategory: (categoryId: string | null) => void;
  expandedCategoryLabel: string;
  categoryIncludedWhenChecked: (categoryId: string) => boolean;
  grantedDisplayRiskToolItems: (categoryId: string) => CapabilityItem[];
  grantedRiskSkillItems: (categoryId: string) => CapabilityItem[];
  customSkillItems: () => CapabilityItem[];
  isCustomSkillSelected: (name: string) => boolean;
  toggleCustomSkill: (name: string) => void;
  mcpBlockVisible: () => boolean;
  customMcpTools: () => Array<{ name: string; serverName: string }>;
  isCustomToolSelected: (name: string) => boolean;
  toggleCustomTool: (name: string) => void;
  protectedFilePipelineAvailable: boolean;
  protectedFilePipelineEnabled: boolean;
  onProtectedFilePipelineChange: (enabled: boolean) => void;
  /** Description for a bundled skill, or `undefined` when it has none. */
  skillDescription: (name: string) => string | undefined;
};

function CapabilityChipList(props: {
  tools: CapabilityItem[];
  skills: CapabilityItem[];
  skillDescription: (name: string) => string | undefined;
}) {
  return (
    <div class="space-y-2">
      <div>
        <div class="text-tiny font-semibold uppercase tracking-wide text-dls-secondary">{t("agents.tools_label")}</div>
        <Show
          when={props.tools.length > 0}
          fallback={<div class="mt-1 text-label text-dls-secondary">{t("agents.no_tools_found")}</div>}
        >
          <div class="mt-1 flex flex-wrap gap-1">
            <For each={props.tools}>
              {(item) => (
                <span
                  class="rounded-compact border border-dls-panel-badge-border bg-dls-panel-badge-bg px-1.5 py-0.5 text-label"
                  title={item.description ?? ""}
                >
                  {item.name}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      <div>
        <div class="text-tiny font-semibold uppercase tracking-wide text-dls-secondary">{t("agents.skills_label")}</div>
        <Show
          when={props.skills.length > 0}
          fallback={<div class="mt-1 text-label text-dls-secondary">{t("agents.no_skills_found")}</div>}
        >
          <div class="mt-1 flex flex-wrap gap-1">
            <For each={props.skills}>
              {(item) => (
                <span
                  class="rounded-compact border border-dls-panel-badge-border bg-dls-panel-badge-bg px-1.5 py-0.5 text-label"
                  title={agentCreatorSkillTooltip(item, props.skillDescription(item.name))}
                >
                  {item.name}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

export default function AgentCreatorCapabilitySelection(props: AgentCreatorCapabilitySelectionProps) {
  const [protectedDetailsOpen, setProtectedDetailsOpen] = createSignal(false);
  const categoryId = () => props.expandedCategory ?? "";
  const categoryKeySuffix = () => categoryId().replace(/-/g, "_");

  createEffect(() => {
    if (!props.protectedFilePipelineAvailable) setProtectedDetailsOpen(false);
  });

  return (
    <>
      <Show when={!props.expandedCategory && !protectedDetailsOpen()}>
        <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <div class="min-w-0">
            <div class="text-caption font-medium text-dls-text">{t("agents.capabilities_section_label")}</div>
            <div class="mt-2 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2">
              <div class="space-y-2" data-testid="agent-capabilities-list">
              <For each={props.visibleCategories}>
                {(category) => (
                  <div
                    data-testid="agent-category-row"
                    class={`flex items-center justify-between gap-3 rounded-inset px-3 py-2.5 text-dls-secondary transition-all duration-150 hover:bg-dls-hover/50 ${props.categoryEnabled(category.id) ? "border border-dls-success-border bg-dls-success-bg" : "border border-transparent"}`}
                  >
                    <label class="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 pl-0.5">
                      <input
                        type="checkbox"
                        class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-compact border-dls-border bg-dls-surface text-dls-success-text"
                        data-testid={`agent-category-checkbox-${category.id}`}
                        checked={props.categoryEnabled(category.id)}
                        onChange={(event) => {
                          props.onToggleCategory(category.id, event.currentTarget.checked);
                          event.currentTarget.checked = props.categoryEnabled(category.id);
                        }}
                        aria-label={t("agents.toggle_risk_selection").replace("{name}", t(category.labelKey))}
                      />
                      <Tooltip
                        content={t(category.descriptionKey)}
                        maxWidthClass="max-w-[280px]"
                        focusable
                      >
                        <span class="text-caption font-semibold text-dls-text">
                          {t(category.labelKey)}
                        </span>
                      </Tooltip>
                    </label>
                    <button
                      type="button"
                      class="shrink-0 pr-1 text-caption font-medium text-dls-secondary transition-colors hover:text-dls-text"
                      onClick={() => props.setExpandedCategory(category.id)}
                      aria-label={t("agents.open_category_details").replace("{name}", t(category.labelKey))}
                    >
                      {t("agents.details_label")}
                    </button>
                  </div>
                )}
              </For>
              <Show when={props.protectedFilePipelineAvailable}>
                <div
                  class={`flex items-center justify-between gap-3 rounded-inset px-3 py-2.5 text-dls-secondary transition-all duration-150 hover:bg-dls-hover/50 ${props.protectedFilePipelineEnabled ? "border border-dls-success-border bg-dls-success-bg" : "border border-transparent"}`}
                >
                  <label class="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 pl-0.5">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-compact border-dls-border bg-dls-surface text-dls-success-text"
                      data-testid="agent-protected-file-pipeline-checkbox"
                      checked={props.protectedFilePipelineEnabled}
                      onChange={(event) => props.onProtectedFilePipelineChange(event.currentTarget.checked)}
                    />
                    <span class="text-caption font-semibold text-dls-text">
                      {t("agents.protected_file_pipeline_label")}
                    </span>
                  </label>
                  <button
                    type="button"
                    class="shrink-0 pr-1 text-caption font-medium text-dls-secondary transition-colors hover:text-dls-text"
                    onClick={() => setProtectedDetailsOpen(true)}
                    aria-label={t("agents.open_category_details").replace("{name}", t("agents.protected_file_pipeline_label"))}
                  >
                    {t("agents.details_label")}
                  </button>
                </div>
              </Show>
              </div>
            </div>
          </div>

          <div class="min-w-0">
            <div class="text-caption font-medium text-dls-text">{t("agents.custom_skills_mcp_heading")}</div>
            <div
              class={`mt-2 max-h-48 overflow-x-hidden overflow-y-auto rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2.5 ${props.mcpBlockVisible() ? "grid gap-4 sm:grid-cols-2" : ""}`}
            >
              <div>
                <div class="text-tiny font-semibold uppercase tracking-wide text-dls-secondary">
                  {t("agents.custom_skills_section_label")}
                </div>
                <Show
                  when={props.customSkillItems().length > 0}
                  fallback={<div class="mt-1 text-label text-dls-secondary">{t("agents.custom_none_found")}</div>}
                >
                  <div class="mt-1 space-y-1.5">
                    <For each={props.customSkillItems()}>
                      {(item) => (
                        <label class="flex cursor-pointer items-start gap-2 py-0.5 text-caption text-dls-text">
                          <input
                            type="checkbox"
                            class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-compact border-dls-border bg-dls-surface text-dls-success-text"
                            checked={props.isCustomSkillSelected(item.name)}
                            onChange={() => props.toggleCustomSkill(item.name)}
                          />
                          <Tooltip
                            content={
                              agentCreatorSkillTooltip(item, props.skillDescription(item.name)) ||
                              t("agents.agent_description_unavailable")
                            }
                            maxWidthClass="max-w-[280px]"
                            class="min-w-0 flex-1 leading-5"
                            focusable
                          >
                            <span class="block min-w-0 break-words leading-5">{item.name}</span>
                          </Tooltip>
                        </label>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <Show when={props.mcpBlockVisible()}>
                <div>
                  <div class="text-tiny font-semibold uppercase tracking-wide text-dls-secondary">
                    {t("agents.custom_mcp_tools_section_label")}
                  </div>
                  <Show
                    when={props.customMcpTools().length > 0}
                    fallback={<div class="mt-1 text-label text-dls-secondary">{t("agents.custom_none_found")}</div>}
                  >
                    <div class="mt-1 space-y-1.5">
                      <For each={props.customMcpTools()}>
                        {(item) => (
                          <label class="flex cursor-pointer items-start gap-2 py-0.5 text-caption text-dls-text">
                            <input
                              type="checkbox"
                              class="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-compact border-dls-border bg-dls-surface text-dls-success-text"
                              checked={props.isCustomToolSelected(item.name)}
                              onChange={() => props.toggleCustomTool(item.name)}
                            />
                            <span class="min-w-0 flex-1 break-words leading-5">{item.serverName}</span>
                          </label>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={props.catalogError}>
        {(msg) => (
          <div class="mb-3 rounded-control border border-dls-danger-border bg-dls-danger-bg px-3 py-2 text-caption text-dls-danger-text">{msg()}</div>
        )}
      </Show>

      <Show when={props.expandedCategory || protectedDetailsOpen()}>
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-2 border-b border-dls-border pb-3">
            <div class="min-w-0">
              <div class="text-body-lg font-semibold text-dls-text">
                {protectedDetailsOpen() ? t("agents.protected_file_pipeline_label") : props.expandedCategoryLabel}
              </div>
              <Show when={protectedDetailsOpen() ? props.protectedFilePipelineEnabled : props.categoryIncludedWhenChecked(categoryId())}>
                <div class="mt-0.5 text-label text-dls-success-text">{t("agents.category_detail_included_hint")}</div>
              </Show>
            </div>
            <button
              type="button"
              class="shrink-0 text-caption font-medium text-dls-secondary transition-colors hover:text-dls-text"
              onClick={() => {
                setProtectedDetailsOpen(false);
                props.setExpandedCategory(null);
              }}
            >
              {t("agents.back_to_categories")}
            </button>
          </div>

          <Show
            when={protectedDetailsOpen()}
            fallback={
              <div>
                <div class="text-caption font-semibold text-dls-text">{t("agents.permissions_label")}</div>
                <ul class="mt-1 list-disc space-y-0.5 pl-4 text-caption text-dls-secondary">
                  <li>{t(`agents.package_low_line_${categoryKeySuffix()}`)}</li>
                  <li>{t(`agents.package_high_added_line_${categoryKeySuffix()}`)}</li>
                </ul>
                <div class="mt-3 rounded-control border border-dls-panel-inset-border bg-dls-panel-inset-bg px-3 py-2 text-caption text-dls-text">
                  <CapabilityChipList
                    tools={props.grantedDisplayRiskToolItems(categoryId())}
                    skills={props.grantedRiskSkillItems(categoryId())}
                    skillDescription={props.skillDescription}
                  />
                </div>
              </div>
            }
          >
            <div class="space-y-3">
              <p class="text-caption text-dls-secondary">{t("agents.protected_file_pipeline_description")}</p>
              <div>
                <div class="text-caption font-semibold text-dls-text">{t("agents.permissions_label")}</div>
                <p class="mt-1 text-label text-dls-secondary">{t("agents.protected_file_pipeline_permissions_intro")}</p>
                <ul class="mt-1 list-disc space-y-0.5 pl-4 text-caption text-dls-secondary">
                  <li><span class="font-semibold">confirm_file_protection</span>: {t("agents.protected_file_pipeline_confirm_permission")}</li>
                  <li><span class="font-semibold">protected-file-agent</span>: {t("agents.protected_file_pipeline_agent_permission")}</li>
                  <li><span class="font-semibold">run_protected_file_pipeline</span>: {t("agents.protected_file_pipeline_tool_permission")}</li>
                  <li><span class="font-semibold">local-file-agent</span>: {t("agents.protected_file_pipeline_local_agent_permission")}</li>
                </ul>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );
}
