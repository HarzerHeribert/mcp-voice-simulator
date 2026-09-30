/**
 * Elicitation as a spoken confirmation (opt-in, `SIM_ELICITATION=voice`).
 *
 * A voice host can read a question aloud and hear yes or no; it cannot render a form. So this
 * handles exactly one shape — a confirmation: a form with no fields, or with a single boolean
 * field — and fails closed on everything else:
 *
 * - a confirmation is spoken and shown with Yes / No; the person's answer is the result;
 * - a form with other fields, or URL mode, is declined without asking (logged);
 * - no answer within the timeout is `cancel`.
 *
 * Nothing here ever accepts on the person's behalf. Works on both protocol eras: the client
 * routes push-style `elicitation/create` requests and 2026-07-28 `input_required` rounds to the
 * same handler.
 */
import { randomUUID } from "node:crypto";

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationRecord {
  message: string;
  action: ElicitationAction;
  /** Why the simulator answered without asking the person, if it did. */
  reason?: "not-a-confirmation" | "url-mode" | "timeout";
}

export interface PendingElicitation {
  id: string;
  message: string;
}

export interface ElicitationParams {
  mode?: string;
  message: string;
  requestedSchema?: { properties?: Record<string, { type?: string }> };
}

export type ElicitationResult = {
  action: ElicitationAction;
  content?: Record<string, boolean>;
};

/** The boolean field a confirmation carries, `""` for a form without fields, `undefined` for anything else. */
export function confirmationField(params: ElicitationParams): string | undefined {
  if (params.mode === "url") return undefined;
  const props = Object.entries(params.requestedSchema?.properties ?? {});
  if (props.length === 0) return "";
  if (props.length === 1 && props[0]![1].type === "boolean") return props[0]![0];
  return undefined;
}

export const DEFAULT_ELICITATION_TIMEOUT_MS = 60_000;

/** Holds at most one question for the person, and records what happened to every question. */
export class ElicitationBroker {
  private pending: (PendingElicitation & { resolve: (a: ElicitationAction) => void }) | null = null;
  private records: ElicitationRecord[] = [];

  constructor(private readonly timeoutMs = DEFAULT_ELICITATION_TIMEOUT_MS) {}

  /** What the page should show, if anything. */
  current(): PendingElicitation | null {
    return this.pending ? { id: this.pending.id, message: this.pending.message } : null;
  }

  /** The person's answer. False if there is no such question (already answered or timed out). */
  answer(id: string, action: ElicitationAction): boolean {
    if (!this.pending || this.pending.id !== id) return false;
    this.pending.resolve(action);
    return true;
  }

  /** Every question since the last call, oldest first. */
  drain(): ElicitationRecord[] {
    const out = this.records;
    this.records = [];
    return out;
  }

  /** The `elicitation/create` handler. */
  async handle(params: ElicitationParams): Promise<ElicitationResult> {
    const field = confirmationField(params);
    if (field === undefined) {
      const reason = params.mode === "url" ? "url-mode" : "not-a-confirmation";
      this.records.push({ message: params.message, action: "decline", reason });
      return { action: "decline" };
    }
    // One question at a time, as on a speaker: a second one while the first is open is declined.
    if (this.pending) {
      this.records.push({ message: params.message, action: "decline", reason: "not-a-confirmation" });
      return { action: "decline" };
    }
    const id = randomUUID();
    let timedOut = false;
    const action = await new Promise<ElicitationAction>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve("cancel");
      }, this.timeoutMs);
      this.pending = {
        id,
        message: params.message,
        resolve: (a) => {
          clearTimeout(timer);
          resolve(a);
        },
      };
    });
    this.pending = null;
    this.records.push({ message: params.message, action, ...(timedOut ? { reason: "timeout" as const } : {}) });
    if (action !== "accept") return { action };
    return field ? { action, content: { [field]: true } } : { action, content: {} };
  }
}
