export type FileCardInfo = {
  title: string;
  detail: string;
  mime: string;
};

type FileCardPart = {
  type?: unknown;
  filename?: unknown;
  url?: unknown;
  mime?: unknown;
  source?: unknown;
};

export const fileCardInfo = (part: FileCardPart): FileCardInfo | null => {
  if (part.type !== "file") return null;
  const source =
    part.source && typeof part.source === "object"
      ? (part.source as Record<string, unknown>)
      : {};
  const sourceType = typeof source.type === "string" ? source.type : "";
  const sourcePath = typeof source.path === "string" ? source.path : "";
  const sourceName = typeof source.name === "string" ? source.name : "";
  const sourceClient =
    typeof source.clientName === "string" ? source.clientName : "";
  const sourceUri = typeof source.uri === "string" ? source.uri : "";
  const filename = typeof part.filename === "string" ? part.filename : "";
  const url = typeof part.url === "string" ? part.url : "";
  const pathName = sourcePath
    ? (sourcePath.split(/[\\/]/).pop() ?? sourcePath)
    : "";
  const title = filename || pathName || sourceName || url || "File";
  const detail = (() => {
    if (sourceType === "symbol") {
      if (sourcePath) return `${sourceName || "symbol"} - ${sourcePath}`;
      return sourceName || "";
    }
    if (sourceType === "resource") {
      const details = [sourceClient, sourceUri].filter(Boolean).join(" - ");
      return details || url;
    }
    return sourcePath || url;
  })();
  const mime = typeof part.mime === "string" ? part.mime : "";
  return { title, detail, mime };
};
