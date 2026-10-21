/**
 * Minimal Express stand-in for route-level integration tests: `app` records
 * every registered handler chain, and `call` runs one chain (middleware, then
 * the handler) with a factory session for the fixture's company.
 */
type Handler = (req: unknown, res: unknown, next?: () => unknown) => Promise<unknown> | unknown;

export function createFakeRouteApp(fixture: () => { companyId: number; today: string }) {
  const routes = new Map<string, Handler[]>();
  const app = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (path: unknown, ...handlers: Handler[]) => {
          if (typeof path === "string") routes.set(`${method.toUpperCase()} ${path}`, handlers);
        },
    }
  ) as never;

  async function call(route: string, req: Record<string, any>) {
    const handlers = routes.get(route);
    if (!handlers) throw new Error(`route not registered: ${route}`);
    const { companyId, today } = fixture();
    const [method, path] = route.split(" ");
    let statusCode = 200;
    let body: any;
    const res: Record<string, any> = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(value: unknown) {
        body = value;
        return res;
      },
      set: () => res,
      setHeader: () => res,
    };
    const headers: Record<string, string> = { "x-client-date": today, ...(req.headers ?? {}) };
    const request = {
      method,
      path,
      params: {},
      query: {},
      body: {},
      get: (name: string) => headers[name.toLowerCase()],
      header: (name: string) => headers[name.toLowerCase()],
      ...req,
      headers,
      session: {
        factoryCompanyId: companyId,
        currentCompanyId: companyId,
        userId: "1",
        username: "owner",
        ...req.session,
      },
    };
    // Middleware (requireRole) then the handler.
    for (const [index, handler] of handlers.entries()) {
      let next = false;
      await handler(request, res, () => {
        next = true;
      });
      if (index < handlers.length - 1 && !next) break;
    }
    return { statusCode, body };
  }

  return { app, call };
}
