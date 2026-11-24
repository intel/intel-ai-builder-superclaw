import { For, Show, createEffect, createMemo, createSignal, on } from "solid-js";
import { Shield, ShieldCheck, ShieldOff } from "lucide-solid";
import type { OpenworkServerClient } from "../lib/openwork-server";
import Card from "~/shared/ui/card";

export type PiiStatsViewProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerWorkspaceId: string | null;
  /** Optional current-session total to show a "this session" callout */
  currentSessionTotal?: number;
  /**
   * Reactive signature that changes when the workspace's session list changes
   * (e.g. a session is created or deleted). Used to refresh the aggregate
   * stats so deleted sessions stop contributing to the total.
   */
  sessionsSignature?: string;
};

type PiiTally = {
  total: number;
  types: Record<string, number>;
};

export default function PiiStatsView(props: PiiStatsViewProps) {
  const [tally, setTally] = createSignal<PiiTally | null>(null);
  const [loading, setLoading] = createSignal(false);

  const sortedTypes = createMemo(() => {
    const t = tally();
    if (!t) return [];
    return Object.entries(t.types)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a);
  });

  const TYPE_LABELS: Record<string, string> = {
    PERSON:      "Person",
    EMAIL:       "Email",
    PHONE:       "Phone",
    URL:         "URL",
    DATETIME:    "Date & time",
    ID:          "ID",
    ORG:         "Organisation",
    FINANCIAL:   "Financial data",
    SECRET:      "Secret & token",
    STREET:      "Street address",
    BUILDINGNUM: "Building number",
    ZIPCODE:     "Postcode / ZIP code",
    CITY:        "City",
    COUNTRY:     "Country",
    COUNTY:      "County",
    AGE:         "Age",
    SEX:         "Sex",
    GENDER:      "Gender",
    GPE:         "Places (geo-political)",
  };

  const typeLabel = (type: string) =>
    TYPE_LABELS[type] ??
    type.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

  createEffect(
    on(
      () =>
        [
          props.openworkServerClient,
          props.openworkServerWorkspaceId,
          props.sessionsSignature ?? "",
        ] as const,
      ([client, workspaceId, signature]) => {
        console.log("[pii-stats] effect run", {
          hasClient: Boolean(client),
          workspaceId,
          signature,
        });
        if (!client || !workspaceId?.trim()) {
          setTally(null);
          return;
        }
        setLoading(true);
        void client
          .getAllPiiStats(workspaceId.trim())
          .then((stats) => {
            console.log("[pii-stats] getAllPiiStats result", stats);
            if (stats) setTally(stats);
          })
          .catch((err) => console.warn("[pii-stats] getAllPiiStats failed", err))
          .finally(() => setLoading(false));
      },
    ),
  );

  return (
    <div class="space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-heading-lg font-semibold text-dls-text">PII Protection</h2>
          <p class="mt-1 text-body-lg text-dls-secondary">
            Total personally identifiable information masked across all sessions in this workspace
          </p>
        </div>
      </div>

      <Show when={loading()}>
        <Card>
          <div class="flex items-center justify-center py-12 text-body-lg text-dls-secondary">
            Loading PII statistics…
          </div>
        </Card>
      </Show>

      <Show when={!loading()}>
        <Show
          when={tally() && tally()!.total > 0}
          fallback={
            <Card>
              <div class="flex flex-col items-center justify-center py-12 text-center">
                <div class="mb-4 flex h-12 w-12 items-center justify-center rounded-pill bg-dls-hover">
                  <ShieldOff size={24} class="text-dls-secondary" />
                </div>
                <h3 class="text-body-xl leading-title font-medium text-dls-text">No PII entities detected yet</h3>
                <p class="mt-1 max-w-sm text-body-lg text-dls-secondary">
                  PII entities will appear here once messages containing personal information are processed.
                </p>
              </div>
            </Card>
          }
        >
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div class="rounded-inset border border-dls-border bg-dls-surface p-4 shadow-sm">
              <div class="flex items-center gap-3">
                <div class="flex h-10 w-10 items-center justify-center rounded-control bg-dls-success-bg">
                  <ShieldCheck size={20} class="text-dls-success-text" />
                </div>
                <div>
                  <p class="text-caption font-medium text-dls-secondary">Total Protected</p>
                  <p class="text-heading font-semibold text-dls-success-text">{tally()!.total.toLocaleString()}</p>
                </div>
              </div>
            </div>

            <Show when={(props.currentSessionTotal ?? 0) > 0}>
              <div class="rounded-inset border border-dls-border bg-dls-surface p-4 shadow-sm">
                <div class="flex items-center gap-3">
                  <div class="flex h-10 w-10 items-center justify-center rounded-control bg-dls-secondary-accent-bg">
                    <Shield size={20} class="text-dls-secondary-accent" />
                  </div>
                  <div>
                    <p class="text-caption font-medium text-dls-secondary">Current Session</p>
                    <p class="text-heading font-semibold text-dls-text">{(props.currentSessionTotal ?? 0).toLocaleString()}</p>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          <Show when={sortedTypes().length > 0}>
            <Card title="Breakdown by Entity Type">
              <div class="overflow-x-auto">
                <table class="w-full border-collapse">
                  <thead>
                    <tr class="border-b border-dls-border">
                      <th scope="col" class="py-3 text-left text-body-lg font-medium text-dls-secondary">Entity type</th>
                      <th scope="col" class="py-3 pl-4 text-left text-body-lg font-medium text-dls-secondary">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={sortedTypes()}>
                      {([type, count]) => (
                        <tr class="border-b border-dls-border/50">
                          <td class="py-3">
                            <div class="flex items-center gap-2">
                              <span aria-hidden="true" class="h-2 w-2 shrink-0 rounded-pill" />
                              <span class="text-body-lg font-medium text-dls-text">{typeLabel(type)}</span>
                            </div>
                          </td>
                          <td class="py-3 pl-8 text-body-lg font-semibold text-dls-text">{count.toLocaleString()}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                  <tfoot>
                    <tr class="border-t border-dls-border">
                      <th scope="row" class="pt-3 text-left text-body-lg font-semibold text-dls-text">Total</th>
                      <td class="pt-3 pl-8 text-body-lg font-semibold text-dls-text">{tally()!.total.toLocaleString()}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Card>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
