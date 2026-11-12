import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

export const CUSTOM_MESSAGE_TYPE = "pi-rules-injection";

/** The rules and skills that the model can see now, read from the injection messages in its context. */
export interface InjectedState {
  /** Rule id to the version of the rule that the model has. */
  rules: Map<string, { hash: string; label: string }>;
  skills: Set<string>;
  injectionIds: Set<string>;
}

export function emptyInjectedState(): InjectedState {
  return { rules: new Map(), skills: new Set(), injectionIds: new Set() };
}

/**
 * Collect the injections that reach the model.
 * `contextEntries` must be the compaction-aware projection of the current branch,
 * so injections on other branches, before a compaction, or removed by a context edit do not count.
 * `pendingMessages` are messages that pi queued for the next model call but has not written yet.
 */
export function collectInjectedState(
  contextEntries: readonly ProjectedSessionEntry[],
  pendingMessages: readonly unknown[] = [],
): InjectedState {
  const state = emptyInjectedState();
  for (const entry of contextEntries) {
    if (entry.messages.length === 0) continue;
    const source = entry.sourceEntry;
    if (source.type !== "custom_message" || source.customType !== CUSTOM_MESSAGE_TYPE) continue;
    addInjection(state, source.details);
  }
  for (const message of pendingMessages) {
    if (!isInjectionMessage(message)) continue;
    addInjection(state, message.details);
  }
  return state;
}

export function addInjection(state: InjectedState, details: unknown): void {
  if (!isInjectionDetails(details)) return;
  state.injectionIds.add(details.injectionId);
  details.rules.forEach((rule, index) => {
    // 0.7 and 0.8 stored the label only in `sources`, in the same order as `rules`.
    state.rules.set(rule.id, { hash: rule.hash, label: rule.label ?? details.sources[index] ?? rule.id });
  });
  for (const rule of details.removed ?? []) state.rules.delete(rule.id);
  for (const skill of details.skills) state.skills.add(skill);
}

function isInjectionMessage(message: unknown): message is { details: unknown } {
  return (
    typeof message === "object" &&
    message !== null &&
    "customType" in message &&
    message.customType === CUSTOM_MESSAGE_TYPE &&
    "details" in message
  );
}

// Injections written by older versions have no rule list. They are ignored, so those rules load once more.
interface StoredInjectionDetails {
  injectionId: string;
  rules: Array<{ id: string; hash: string; label?: string }>;
  removed?: Array<{ id: string }>;
  sources: string[];
  skills: string[];
}

function isInjectionDetails(details: unknown): details is StoredInjectionDetails {
  if (typeof details !== "object" || details === null) return false;
  const candidate = details as Partial<StoredInjectionDetails>;
  return (
    typeof candidate.injectionId === "string" &&
    Array.isArray(candidate.rules) &&
    candidate.rules.every((rule) => typeof rule?.id === "string" && typeof rule.hash === "string") &&
    (candidate.removed === undefined ||
      (Array.isArray(candidate.removed) && candidate.removed.every((rule) => typeof rule?.id === "string"))) &&
    Array.isArray(candidate.sources) &&
    Array.isArray(candidate.skills)
  );
}
