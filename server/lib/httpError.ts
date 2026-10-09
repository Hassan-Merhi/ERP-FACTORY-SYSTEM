/**
 * An error that carries the HTTP status a route should answer with. Kept in a
 * dependency-free module so domain services can throw it without importing
 * the Express helpers in httpHandlers.ts (which tests often mock).
 */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}
