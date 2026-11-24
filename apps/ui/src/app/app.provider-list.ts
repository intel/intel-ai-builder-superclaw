/**
 * Widens the provider list the server returns into the shape OpenCode's global
 * sync store expects.
 *
 * The two types overlap but are not the same: the store's model entries carry a
 * full capability and cost matrix that our config-sourced providers do not
 * report. Every one of those fields is therefore defaulted here rather than left
 * undefined, because the store's consumers index into them directly.
 */
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import type { ProviderListItem } from "./types";

type GlobalProviderListItem = ProviderListResponse["all"][number];
type GlobalProviderModel = GlobalProviderListItem["models"][string];

export const toGlobalProviderList = (
  value: readonly ProviderListItem[],
): GlobalProviderListItem[] =>
  value.map((provider) => ({
    ...provider,
    name: provider.name ?? provider.id,
    env: provider.env ?? [],
    models: Object.fromEntries(
      Object.entries(provider.models ?? {}).map(
        ([modelKey, model]): [string, GlobalProviderModel] => [
          modelKey,
          {
            ...model,
            name: model.name ?? model.id,
            status: "active",
            release_date: model.release_date ?? "",
            providerID: provider.id,
            limit: { context: 0, output: 0 },
            cost: {
              input: model.cost?.input ?? 0,
              output: model.cost?.output ?? 0,
              cache: { read: 0, write: 0 },
            },
            capabilities: {
              temperature: false,
              reasoning: model.capabilities?.reasoning ?? false,
              attachment: false,
              toolcall: false,
              input: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false,
              },
              output: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false,
              },
              interleaved: false,
            },
            options: {},
            headers: {},
            api: {
              id: model.id,
              url: model.api?.url ?? "",
              npm: model.api?.npm ?? "",
            },
          },
        ],
      ),
    ),
    source: "config",
    options: {},
  }));
