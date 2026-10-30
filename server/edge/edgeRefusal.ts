/**
 * Machine-readable refusal from factory edge / offline code. The message IS
 * the stable code (for example PHASE9_STREAM_INVALID); it is never shown to
 * end users verbatim, so it is not a translatable literal.
 */
export class EdgeRefusal extends Error {
  constructor(code: string) {
    super(code);
    this.name = "EdgeRefusal";
  }
}
