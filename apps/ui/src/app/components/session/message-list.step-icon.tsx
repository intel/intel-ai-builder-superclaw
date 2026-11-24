import type { JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { MessageWithParts } from "../../types";
import {
  BookOpenText,
  Bot,
  CalendarPlus,
  Eye,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Lightbulb,
  ListChecks,
  ListTree,
  Mail,
  MessageCircleQuestion,
  Pencil,
  Plug,
  ScanText,
  Search,
  ShieldCheck,
  Sparkles,
  Table,
  Terminal,
  Wrench,
} from "lucide-solid";
import { isWebSearchToolOutput } from "../../utils";
import { getWebSourcesFromPart } from "./message-list.exploration";
import { HDR_TOOL } from "./message-list.hdr-progress";

type Part = MessageWithParts["parts"][number];

export type StepIconKind =
  | "web"
  | "read"
  | "edit"
  | "write"
  | "search"
  | "list"
  | "terminal"
  | "plan"
  | "question"
  | "subagent"
  | "skill"
  | "document"
  | "spreadsheet"
  | "ocr"
  | "privacy"
  | "email"
  | "calendar"
  | "research"
  | "mcp-status"
  | "thinking"
  | "group"
  | "generic";

export const TOOL_KIND_MAP: Record<string, StepIconKind> = {
  webfetch: "web",
  websearch: "web",
  sc_search_web: "web",
  read: "read",
  edit: "edit",
  multiedit: "edit",
  write: "write",
  apply_patch: "write",
  patch: "write",
  grep: "search",
  glob: "search",
  search: "search",
  codesearch: "search",
  list: "list",
  list_files: "list",
  bash: "terminal",
  todoread: "plan",
  todowrite: "plan",
  question: "question",
  task: "subagent",
  skill: "skill",
  parse_pdf: "document",
  local_dr_read_docx: "document",
  local_dr_read_pptx: "document",
  local_dr_read_csv_xlsx: "spreadsheet",
  local_dr_query_table: "spreadsheet",
  ocr: "ocr",
  run_protected_file_pipeline: "privacy",
  confirm_file_protection: "privacy",
  run_email_pipeline: "email",
  email_send: "email",
  email_reply: "email",
  schedule_meeting: "calendar",
  hybrid_dr_post_polish_processor: "research",
  get_mcp_status: "mcp-status",
};

const KIND_ICON_MAP: Record<
  StepIconKind,
  (props: { size?: number; class?: string }) => JSX.Element
> = {
  web: Globe,
  read: Eye,
  edit: Pencil,
  write: FilePen,
  search: Search,
  list: FolderOpen,
  terminal: Terminal,
  plan: ListChecks,
  question: MessageCircleQuestion,
  subagent: Bot,
  skill: Sparkles,
  document: FileText,
  spreadsheet: Table,
  ocr: ScanText,
  privacy: ShieldCheck,
  email: Mail,
  calendar: CalendarPlus,
  research: BookOpenText,
  "mcp-status": Plug,
  thinking: Lightbulb,
  group: ListTree,
  generic: Wrench,
};

export function stepIconKind(part: Part): StepIconKind {
  if (part.type === "reasoning") {
    return "thinking";
  }

  if (part.type !== "tool") {
    return "generic";
  }

  const record = part as {
    tool?: unknown;
    state?: { output?: unknown };
  };

  const output =
    typeof record.state?.output === "string" ? record.state.output : "";
  const toolName =
    typeof record.tool === "string" ? record.tool.trim().toLowerCase() : "";
  // HDR carries its sidecar's web sources but stays a research step.
  if (
    toolName !== HDR_TOOL &&
    (isWebSearchToolOutput(output) || getWebSourcesFromPart(part).length > 0)
  ) {
    return "web";
  }

  if (Object.prototype.hasOwnProperty.call(TOOL_KIND_MAP, toolName)) {
    return TOOL_KIND_MAP[toolName];
  }

  return "generic";
}

export function StepIcon(props: {
  kind: StepIconKind;
  size?: number;
}): JSX.Element {
  // Dynamic keeps the icon in sync when a streaming step's kind changes.
  return (
    <Dynamic
      component={KIND_ICON_MAP[props.kind]}
      size={props.size ?? 13}
    />
  );
}
