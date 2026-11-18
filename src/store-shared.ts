// What every store agrees on besides the row types: the errors a caller can act on.
// Kept apart from store.ts so that sqlite-store.ts can import values without an import cycle.

export type StoreErrorCode = "handle_taken" | "x_user_id_taken";

/**
 * A write the store refused for a reason the caller can act on. Every other database failure stays
 * a generic Error whose text says nothing about the database.
 */
export class StoreError extends Error {
  constructor(
    public code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export const handleTaken = () => new StoreError("handle_taken", "This x_handle is already registered to a different x_user_id.");
export const xUserIdTaken = () => new StoreError("x_user_id_taken", "This x_user_id is already registered.");
