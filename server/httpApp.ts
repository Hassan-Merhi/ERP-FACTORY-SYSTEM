import express from "express";

/**
 * Creates the Express application with routing that matches paths exactly as
 * they are declared.
 *
 * Express routes case-insensitively by default, so /api/ACCOUNTS/all reached
 * the /api/accounts/all handler while the guards that run before it (the
 * Factory page boundaries, company scopes, operational permissions) compared
 * paths case-sensitively and let the unrecognised spelling through. Every
 * declared route uses lower-case literal segments, and route parameters keep
 * their case, so with case-sensitive routing a differently-cased URL is simply
 * not a route (404) and every guard sees the path the handler serves.
 */
export function createHttpApp(): express.Express {
  const app = express();
  app.set("case sensitive routing", true);
  return app;
}
