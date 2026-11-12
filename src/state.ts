import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { RuleInjectionDetails } from "./types.ts";

export const CUSTOM_MESSAGE_TYPE = "pi-rules-injection";

/** The rules and skills that the model can see now, read from the injection messages in its context. */
export interface InjectedState {
  /** Rule id to the hash of the body that the model has. */
  rules: Map<string, string>;
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
  for (const rule of details.rules) state.rules.set(rule.id, rule.hash);
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
function isInjectionDetails(details: unknown): details is RuleInjectionDetails {
  if (typeof details !== "object" || details === null) return false;
  const candidate = details as Partial<RuleInjectionDetails>;
  return (
    typeof candidate.injectionId === "string" &&
    Array.isArray(candidate.rules) &&
    candidate.rules.every((rule) => typeof rule?.id === "string" && typeof rule.hash === "string") &&
    Array.isArray(candidate.skills)
  );
}
