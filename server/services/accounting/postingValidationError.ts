/**
 * The refusal type of the central posting boundary (moved out of
 * centralPostingEngine.ts in phase 22 A so its helpers, such as
 * voucherNumbering.ts, can throw it without an import cycle). The engine
 * re-exports it; existing imports keep working.
 */
export class PostingValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostingValidationError";
    this.code = code;
  }
}
