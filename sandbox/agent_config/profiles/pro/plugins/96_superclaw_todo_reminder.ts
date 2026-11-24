import type { Hooks, Plugin } from "@opencode-ai/plugin";

type Message = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"][number];
type Todo = { content: string; status: string; priority: string };
type Turn = {
  id: string;
  created: number;
  todos: Todo[];
  batches: number;
  lastReminderBatch: number;
  seen: Set<string>;
  structured: boolean;
  remindedInBatch: boolean;
  updatedInBatch: boolean;
  user: Extract<Message["info"], { role: "user" }>;
  parentID: string;
  finalRequested: boolean;
  finalQueued: boolean;
  checking: boolean;
};

const BATCH_LIMIT = 3;
const REMINDER_MARKER = "superclaw_todo_reminder";
const FINAL_MARKER = "superclaw_todo_final_reminder";

function isContinuation(message: Message): boolean {
  return message.parts.some(
    (part) => part.type === "compaction" || (part.type === "text" && part.metadata?.compaction_continue === true),
  );
}

function isReminder(message: Message): boolean {
  return finalTurnID(message) !== undefined || message.parts.some(
    (part) => part.type === "text" && part.metadata?.[REMINDER_MARKER] === true,
  );
}

function finalTurnID(message: Message): string | undefined {
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const marker = part.metadata?.[FINAL_MARKER];
    if (marker !== undefined && marker !== null && isRecord(marker) && typeof marker.turnID === "string") {
      return marker.turnID;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreventiveLocalCompaction(error: Extract<Message["info"], { role: "assistant" }>["error"]): boolean {
  if (!error || error.name === "MessageAbortedError") return false;
  const blob = JSON.stringify(error);
  return blob.includes("Compact and retry") || blob.includes("ContextOverflowCompactLocally");
}

function readTodos(input: unknown): Todo[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  const todos: Todo[] = [];
  for (const item of input.todos) {
    if (
      typeof item !== "object" || item === null ||
      !("content" in item) || typeof item.content !== "string" ||
      !("status" in item) || typeof item.status !== "string" ||
      !("priority" in item) || typeof item.priority !== "string"
    ) return undefined;
    todos.push({ content: item.content, status: item.status, priority: item.priority });
  }
  return todos;
}

function isStructured(message: Message): boolean {
  if (!("format" in message.info)) return false;
  const format: unknown = message.info.format;
  return typeof format === "object" && format !== null && "type" in format && format.type === "json_schema";
}

function hasCheckpoint(metadata: unknown, turnID: string): boolean {
  if (!isRecord(metadata)) return false;
  const checkpoint = metadata[REMINDER_MARKER];
  return isRecord(checkpoint) && checkpoint.turnID === turnID;
}

function hasUnfinishedTodos(turn: Turn): boolean {
  return turn.todos.some((todo) => todo.status !== "completed" && todo.status !== "cancelled");
}

function reminderText(turn: Turn): string {
  return "\n\n[Todo progress reminder] Before more work or a final answer, review the checklist and call " +
    "todowrite with the complete, accurate list. Mark tasks completed only when their work and required " +
    "verification succeeded. An unfinished task may remain in_progress, even if its status is unchanged; " +
    "leave unstarted tasks pending. Do not invent progress or cancel tasks just to clear the list. " +
    "After updating, continue the current or remaining tasks as appropriate. " +
    `Latest recorded checklist: ${JSON.stringify(turn.todos)}`;
}

function appendReminder(output: { output: string; metadata: unknown }, turn: Turn): void {
  output.output += reminderText(turn);
  output.metadata = {
    ...(isRecord(output.metadata) ? output.metadata : {}),
    [REMINDER_MARKER]: { turnID: turn.id },
  };
}

export const SuperclawTodoReminder: Plugin = async ({ client, directory }) => {
  const turns = new Map<string, Turn>();
  const log = async (message: string, extra: Record<string, unknown>, level: "info" | "warn" = "info"): Promise<void> => {
    await client.app.log({ body: { service: "superclaw-todo-reminder", level, message, extra }, throwOnError: true });
  };
  await log("Todo reminder initialized", { batchLimit: BATCH_LIMIT });

  return {
    "chat.message": async (input, output) => {
      const message = { info: output.message, parts: output.parts };
      const origin = finalTurnID(message);
      if (origin !== undefined) {
        const turn = turns.get(input.sessionID);
        if (!turn || turn.id !== origin || !turn.finalRequested) {
          throw new Error("Todo final reconciliation was cancelled or superseded before delivery.");
        }
        turn.finalQueued = false;
        return;
      }
      if (!isReminder(message) && !isContinuation(message)) turns.delete(input.sessionID);
    },

    event: async ({ event }) => {
      if (event.type === "session.error" && event.properties.sessionID && !isPreventiveLocalCompaction(event.properties.error)) {
        turns.delete(event.properties.sessionID);
      }
      if (
        event.type === "message.updated" && event.properties.info.role === "assistant" &&
        event.properties.info.error && !isPreventiveLocalCompaction(event.properties.info.error)
      ) {
        turns.delete(event.properties.info.sessionID);
      }
      if (event.type === "session.idle") {
        const sessionID = event.properties.sessionID;
        const turn = turns.get(sessionID);
        if (!turn || turn.checking || turn.finalQueued) return;
        if (turn.structured || !hasUnfinishedTodos(turn) || turn.finalRequested) {
          turns.delete(sessionID);
          if (hasUnfinishedTodos(turn) && !turn.structured) {
            await log("Todo final reconciliation ended with unfinished tasks.", { sessionID, turnID: turn.id }, "warn");
          }
          return;
        }
        turn.checking = true;
        try {
          await log("Todo turn ended with unfinished tasks.", {
            sessionID, turnID: turn.id, batches: turn.batches,
          }, "warn");
          const [session, history] = await Promise.all([
            client.session.get({ path: { id: sessionID }, query: { directory }, throwOnError: true }),
            client.session.messages({ path: { id: sessionID }, query: { directory, limit: 2 }, throwOnError: true }),
          ]);
          if (turns.get(sessionID) !== turn) return;
          const last = history.data.toSorted(
            (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
          ).at(-1);
          if (
            session.data.parentID || !last || last.info.role !== "assistant" || last.info.error ||
            last.info.summary || last.info.finish !== "stop" || last.info.time.completed === undefined ||
            last.info.parentID !== turn.parentID ||
            !last.parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim()) ||
            last.parts.some((part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"))
          ) return;
          turn.finalRequested = true;
          turn.finalQueued = true;
          await client.session.promptAsync({
            path: { id: sessionID }, query: { directory }, throwOnError: true,
            body: {
              agent: turn.user.agent, model: turn.user.model, system: turn.user.system, tools: turn.user.tools,
              parts: [{
                type: "text", synthetic: true, metadata: { [FINAL_MARKER]: { turnID: turn.id } },
                text: "[Todo final reconciliation] The previous answer stopped with unfinished checklist entries. " +
                  "Call todowrite once with the complete, accurate list based only on work and verification already performed. " +
                  "Do not perform additional work, invent progress, or cancel tasks just to clear the list. " +
                  "Completed work may be marked completed; unfinished work may remain in_progress unchanged, " +
                  "and unstarted work must stay pending. Briefly explain any remaining work or blocker, then stop. " +
                  `Latest recorded checklist: ${JSON.stringify(turn.todos)}`,
              }],
            },
          });
          await log("Todo final reconciliation requested", { sessionID, turnID: turn.id, delivery: "synthetic-follow-up" });
        } catch (error: unknown) {
          if (turns.get(sessionID) === turn) turns.delete(sessionID);
          await log("Todo final reconciliation failed.", {
            sessionID, turnID: turn.id, error: error instanceof Error ? error.message : String(error),
          }, "warn");
        } finally {
          turn.checking = false;
          if (!turn.finalRequested && turns.get(sessionID) === turn) turns.delete(sessionID);
        }
      }
      if (event.type === "session.deleted") turns.delete(event.properties.info.id);
    },

    "tool.execute.after": async (input, output) => {
      const turn = turns.get(input.sessionID);
      if (!turn || turn.structured) return;
      if (input.tool === "todowrite") {
        turn.updatedInBatch = true;
        return;
      }
      if (
        input.tool === "todoread" || turn.updatedInBatch || turn.remindedInBatch ||
        !hasUnfinishedTodos(turn) || turn.batches - turn.lastReminderBatch < BATCH_LIMIT - 1
      ) return;
      appendReminder(output, turn);
      turn.remindedInBatch = true;
      await log("Todo progress reminder attached", {
        sessionID: input.sessionID, turnID: turn.id, batches: turn.batches + 1, delivery: "tool-result",
      });
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = output.messages;
      const ordered = messages
        .filter((message) => message.info?.id && message.info.time?.created !== undefined && !isReminder(message))
        .toSorted((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id));
      const sessionID = ordered.at(-1)?.info.sessionID;
      if (!sessionID) return;

      const latestUser = ordered.findLast(
        (message) =>
          message.info.role === "user" &&
          !("synthetic" in message.info && message.info.synthetic) &&
          !isContinuation(message),
      );
      let turn = turns.get(sessionID);
      if (latestUser !== undefined && latestUser.info.role === "user" && (!turn || latestUser.info.id !== turn.id)) {
        if (turn && latestUser.info.time.created < turn.created) return;
        turn = {
          id: latestUser.info.id,
          created: latestUser.info.time.created,
          todos: [],
          batches: 0,
          lastReminderBatch: 0,
          seen: new Set(),
          structured: isStructured(latestUser),
          remindedInBatch: false,
          updatedInBatch: false,
          user: latestUser.info,
          parentID: latestUser.info.id,
          finalRequested: false,
          finalQueued: false,
          checking: false,
        };
        turns.set(sessionID, turn);
      }
      if (!turn) return;
      for (const message of messages) {
        const origin = finalTurnID(message);
        if (origin === undefined || origin === turn.id) continue;
        for (const part of message.parts) {
          if (part.type === "text" && isRecord(part.metadata?.[FINAL_MARKER])) part.ignored = true;
        }
      }
      if (turn.structured) return;
      turn.parentID = ordered.findLast((message) => message.info.role === "user")?.info.id ?? turn.parentID;
      if (messages.some((message) => finalTurnID(message) === turn.id)) {
        turn.finalRequested = true;
        turn.finalQueued = false;
      }
      turn.remindedInBatch = false;
      turn.updatedInBatch = false;

      const start = latestUser ? ordered.indexOf(latestUser) + 1 : 0;
      let latestWork: Extract<Message["parts"][number], { type: "tool" }> | undefined;
      for (const message of ordered.slice(start)) {
        if (
          message.info.role !== "assistant" || message.info.sessionID !== sessionID ||
          message.info.summary || turn.seen.has(message.info.id)
        ) continue;
        const tools = message.parts.filter((part) => part.type === "tool");
        if (tools.length === 0 || tools.some((part) => part.state.status === "running" || part.state.status === "pending")) {
          continue;
        }
        let updated = false;
        let worked = false;
        for (const part of tools) {
          if (part.metadata?.providerExecuted) continue;
          if (part.tool === "todowrite" && part.state.status === "completed") {
            const todos = readTodos(part.state.input);
            if (!todos) {
              await log("Ignoring invalid todowrite snapshot in completed tool result.", { sessionID, turnID: turn.id }, "warn");
              turn.todos = [];
            } else {
              turn.todos = todos;
            }
            updated = true;
          } else if (
            part.tool !== "todowrite" && part.tool !== "todoread" &&
            (part.state.status === "completed" ||
              (part.state.status === "error" && !part.state.metadata?.interrupted))
          ) {
            worked = true;
            latestWork = part;
          }
        }
        turn.seen.add(message.info.id);
        if (updated) {
          turn.batches = 0;
          turn.lastReminderBatch = 0;
          latestWork = undefined;
          await log("Todo checklist recorded", { sessionID, turnID: turn.id, todoCount: turn.todos.length });
        } else if (worked && turn.todos.length > 0) {
          turn.batches++;
          if (tools.some((part) => "metadata" in part.state && hasCheckpoint(part.state.metadata, turn.id))) {
            turn.lastReminderBatch = turn.batches;
          }
        }
      }

      const latestAssistant = ordered.findLast((message) => message.info.role === "assistant" && !message.info.summary);
      for (const message of ordered) {
        for (const part of message.parts) {
          if (part.type !== "tool" || !("metadata" in part.state) || !isRecord(part.state.metadata)) continue;
          if (!isRecord(part.state.metadata[REMINDER_MARKER])) continue;
          if (
            message === latestAssistant && hasCheckpoint(part.state.metadata, turn.id) &&
            turn.batches >= BATCH_LIMIT && turn.batches === turn.lastReminderBatch && hasUnfinishedTodos(turn)
          ) continue;
          // Keep the stored checkpoint, but don't replay stale lists or grow the model context.
          if (part.state.status === "completed") {
            const index = part.state.output.lastIndexOf("\n\n[Todo progress reminder]");
            if (index >= 0) part.state.output = part.state.output.slice(0, index);
          } else if (part.state.status === "error") {
            const index = part.state.error.lastIndexOf("\n\n[Todo progress reminder]");
            if (index >= 0) part.state.error = part.state.error.slice(0, index);
          }
        }
      }

      if (
        turn.batches - turn.lastReminderBatch < BATCH_LIMIT || !hasUnfinishedTodos(turn) || !latestWork
      ) return;
      // Failed tools have no after hook; retained history also needs a restart fallback.
      if (latestWork.state.status === "completed") appendReminder(latestWork.state, turn);
      else if (latestWork.state.status === "error") {
        latestWork.state.error += reminderText(turn);
        latestWork.state.metadata = {
          ...latestWork.state.metadata,
          [REMINDER_MARKER]: { turnID: turn.id },
        };
      }
      turn.lastReminderBatch = turn.batches;
      await log("Todo progress reminder attached", {
        sessionID, turnID: turn.id, batches: turn.batches, delivery: "outgoing-tool-result",
      });
    },
  };
};

export default SuperclawTodoReminder;
