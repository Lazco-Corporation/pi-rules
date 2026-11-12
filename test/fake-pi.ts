import type { ExtensionAPI, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

// The tests drive the handlers with partial events and read loosely shaped results.
export type Loose = any;
type Handler = (event: Loose, ctx: Loose) => unknown;

interface FakeEntry {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: unknown;
}

/** A session tree with the parts of the pi session manager that the extension reads. */
export class FakeSession {
  readonly entries: FakeEntry[] = [];
  private leafId: string | null = null;

  append(entry: Record<string, unknown>): FakeEntry {
    const appended: FakeEntry = { ...entry, type: String(entry.type), id: `entry-${this.entries.length + 1}`, parentId: this.leafId };
    this.entries.push(appended);
    this.leafId = appended.id;
    return appended;
  }

  appendUserMessage(text: string): FakeEntry {
    return this.append({ type: "message", message: { role: "user", content: text } });
  }

  /** Move the leaf like `/tree` does. `null` goes back before the first entry. */
  branchTo(entryId: string | null): void {
    this.leafId = entryId;
  }

  /** Append a compaction that keeps no earlier entry. */
  compact(): FakeEntry {
    return this.append({ type: "compaction", summary: "summary", firstKeptEntryId: null });
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  buildSessionProjection(): { entries: ProjectedSessionEntry[] } {
    const path: FakeEntry[] = [];
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    for (let cursor = this.leafId; cursor !== null; ) {
      const entry = byId.get(cursor);
      if (!entry) break;
      path.unshift(entry);
      cursor = entry.parentId;
    }
    const lastCompaction = path.findLastIndex((entry) => entry.type === "compaction");
    const visible = lastCompaction === -1 ? path : path.slice(lastCompaction);
    const omitted = new Set(
      visible.filter((entry) => entry.type === "context_edit" && entry.replacement === null).map((entry) => entry.targetId),
    );
    return {
      entries: visible.map((entry) => ({
        sourceEntry: entry as Loose,
        messages: omitted.has(entry.id) || !["message", "custom_message", "compaction"].includes(entry.type) ? [] : [entry as Loose],
      })),
    };
  }
}

export function createFakePi(session = new FakeSession()) {
  const handlers = new Map<string, Handler[]>();
  const renderers = new Map<string, Loose>();
  /** Every injection that reached the session after a turn or through `sendMessage`, in order. */
  const sent: Loose[] = [];
  const api = {
    on(event: string, handler: Handler) {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerMessageRenderer(customType: string, renderer: Loose) {
      renderers.set(customType, renderer);
    },
    sendMessage(message: Loose, options?: Loose) {
      sent.push({ message, options, via: "sendMessage" });
      session.append({ type: "custom_message", ...message });
    },
  };

  const run = async (event: string, value: Loose, ctx: Loose): Promise<Loose> => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler(value, ctx);
    }
    return result;
  };

  return {
    api: api as unknown as ExtensionAPI,
    session,
    handlers,
    renderers,
    sent,
    /** Emit like pi does: persist what the handlers return, as pi would. */
    async emit(event: string, value: Loose, ctx: Loose = {}): Promise<Loose> {
      const fullCtx = { sessionManager: session, hasUI: false, ...ctx };
      if (event === "session_compact") session.compact();
      if (event === "turn_end") {
        const pendingMessages: Loose[] = value.pendingMessages ?? [];
        const boundary = {
          entries: [],
          continue: false,
          outcome: "completed",
          ...value,
          context: { contextEntries: session.buildSessionProjection().entries, pendingMessages },
        };
        const result = await run(event, boundary, fullCtx);
        for (const draft of result?.entries ?? []) {
          sent.push({ message: draft, options: undefined, via: "turn_end" });
          session.append(draft);
        }
        return result;
      }
      const result = await run(event, value, fullCtx);
      if (event === "before_agent_start" && result?.message) {
        session.append({ type: "custom_message", ...result.message });
      }
      return result;
    },
  };
}
