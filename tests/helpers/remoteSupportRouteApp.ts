/**
 * Minimal Express apps for remote-support route suites: a JSON body parser, a
 * fixed session per app, and the route registrar under test. Auth and named
 * permission middleware are expected to be mocked by the suite (as in
 * remote-support-phase10-command-route.test.ts), so these apps exercise only
 * the route's own refusals. `readEventStream` opens an SSE route on a real
 * socket, reads until the first named event arrives, then disconnects.
 */
import express, { type Express } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RouteSession {
  userId: string;
  username?: string;
  currentRole?: string;
  currentCompanyId?: number;
  passwordConfirmedAt?: number;
}

export function sessionApp(session: RouteSession, register: (app: Express) => void): Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    Object.assign(req, { session: { ...session } });
    next();
  });
  register(app);
  return app;
}

export async function readEventStream(
  app: Express,
  path: string,
  until = "event:",
  headers: Record<string, string> = {}
): Promise<{ status: number; contentType: string; body: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        const finish = () => {
          resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), body });
          req.destroy();
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.includes(until)) finish();
        });
        res.on("end", finish);
      });
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
