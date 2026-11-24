import { createMemo, Show } from "solid-js";
import { t } from "../../../i18n";
import type { ModelBadgeDescriptor } from "~/shared/util/model-ref";
import { Tooltip } from "~/shared/ui/tooltip";

type MessageModelBadgeProps = {
  label: ModelBadgeDescriptor | null;
};

export function MessageModelBadge(props: MessageModelBadgeProps) {
  return (
    <Show when={props.label}>
      {(label) => <MessageModelBadgeContent label={label()} />}
    </Show>
  );
}

function MessageModelBadgeContent(props: { label: ModelBadgeDescriptor }) {
  const modelLabelText = createMemo(() => {
    const modelLabel = props.label;
    return (
      modelLabel.kind === "model"
        ? modelLabel.value
        : modelLabel.kind === "route"
          ? modelLabel.alias === "auto"
            ? t("session.model_badge_auto")
            : modelLabel.alias === "local-model"
              ? t("session.model_badge_local")
              : t("session.model_badge_cloud")
          : modelLabel.source === "hybrid"
            ? t("session.model_badge_hybrid")
            : modelLabel.source === "local"
              ? t("session.model_badge_local")
              : t("session.model_badge_cloud")
    );
  });
  const modelSourceText = createMemo(() => {
    const modelLabel = props.label;
    return modelLabel.kind === "model" && modelLabel.source === "local"
      ? t("session.model_badge_local")
      : modelLabel.kind === "model" && modelLabel.source === "cloud"
        ? t("session.model_badge_cloud")
        : "";
  });
  const modelTooltip = createMemo(() => {
    const modelLabel = props.label;
    return modelLabel.kind === "route" && modelLabel.alias === "auto"
      ? t("session.model_badge_auto_tooltip")
      : modelLabel.kind === "source" && modelLabel.source === "hybrid"
        ? t("session.model_badge_hybrid_tooltip")
        : ((modelLabel.kind === "route" && modelLabel.alias === "local-model") ||
              (modelLabel.kind === "source" && modelLabel.source === "local") ||
              (modelLabel.kind === "model" && modelLabel.source === "local"))
          ? t("session.model_badge_local_tooltip")
          : ((modelLabel.kind === "route" && modelLabel.alias === "cloud-model") ||
                (modelLabel.kind === "source" && modelLabel.source === "cloud") ||
                (modelLabel.kind === "model" && modelLabel.source === "cloud"))
            ? t("session.model_badge_cloud_tooltip")
            : t("session.model_badge_tooltip");
  });

  return (
    <div class="flex items-center gap-1.5 text-label text-dls-secondary">
      <Tooltip
        content={modelTooltip()}
        placement="top"
        maxWidthClass="max-w-[280px]"
        focusable
      >
        <span class="flex items-center gap-1.5 text-dls-secondary/80">
          <span>{modelLabelText()}</span>
          <Show when={modelSourceText()}>
            <span class="text-label">{modelSourceText()}</span>
          </Show>
        </span>
      </Tooltip>
    </div>
  );
}