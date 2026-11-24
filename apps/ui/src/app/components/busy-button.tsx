import { Loader2 } from "lucide-solid";

import { t } from "../../i18n";
import Button from "./button";

/**
 * Spinner that takes the place of a card's Test Connection and Connect buttons
 * while either one runs. It has the same look and size as those buttons, so the
 * row does not change shape.
 */
export default function BusyButton(props: { "data-testid"?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      // Full opacity: the shared button fades when disabled.
      class="text-caption h-8 py-0 px-4 disabled:opacity-100 disabled:cursor-wait"
      data-testid={props["data-testid"]}
      aria-label={t("common.loading")}
      disabled
    >
      <Loader2 size={12} class="animate-spin" />
    </Button>
  );
}
