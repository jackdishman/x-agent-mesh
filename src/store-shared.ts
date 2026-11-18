// What every store agrees on besides the row types: the errors a caller can act on, and how the
// bytes an agent has stored are counted.
// Kept apart from store.ts so that sqlite-store.ts can import values without an import cycle.

export type StoreErrorCode = "handle_taken" | "x_user_id_taken" | "quota_exceeded";

/**
 * A write the store refused for a reason the caller can act on. Every other database failure stays
 * a generic Error whose text says nothing about the database.
 */
export class StoreError extends Error {
  constructor(
    public code: StoreErrorCode,
    message: string,
    /** quota_exceeded: what the author had stored, what the refused row needed, and the limit given. */
    public usage?: { usedBytes: number; neededBytes: number; limitBytes: number },
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export const handleTaken = () => new StoreError("handle_taken", "This x_handle is already registered to a different x_user_id.");
export const xUserIdTaken = () => new StoreError("x_user_id_taken", "This x_user_id is already registered.");
export const quotaExceeded = (usedBytes: number, neededBytes: number, limitBytes: number) =>
  new StoreError("quota_exceeded", "This agent's storage quota is used up.", { usedBytes, neededBytes, limitBytes });

// ---- stored bytes ----
//
// Each agent row carries `stored_bytes`: the size of everything that agent has put in the store.
// A thread counts against its proposer, a message against its sender. Nothing is ever deleted, so
// the number only grows. The same formula is used when a row is written and when the counters are
// recomputed from the tables (SQLite does that at every start), so the two always agree:
//
//   thread:  UTF-8 bytes of the goal + UTF-8 bytes of the participants list as JSON + 256
//   message: UTF-8 bytes of the A2A message as JSON + 128
//
// The constants stand for what a row costs besides its text: ids, timestamps, status, the
// accepted-by list, index entries and the participant rows.

export const THREAD_OVERHEAD_BYTES = 256;
export const MESSAGE_OVERHEAD_BYTES = 128;

export const threadBytes = (t: { goal: string; participants: string[] }): number =>
  Buffer.byteLength(t.goal) + Buffer.byteLength(JSON.stringify(t.participants)) + THREAD_OVERHEAD_BYTES;

export const messageBytes = (message: Record<string, unknown>): number => Buffer.byteLength(JSON.stringify(message)) + MESSAGE_OVERHEAD_BYTES;

/** Passed with a write that must respect a quota. */
export interface WriteOptions {
  /**
   * Refuse the write (StoreError `quota_exceeded`) when the author's stored_bytes plus this row
   * would be more than this. Checked in the same step as the write. Omitted: no limit.
   */
  limitBytes?: number;
}
