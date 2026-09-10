import type { Express } from "express";

import { registerLazyRouteModule } from "./lazyRouteRegistrar";

export async function registerApplicationAiLazyRoutes(app: Express): Promise<void> {
  await registerLazyRouteModule(app, {
    prefixes: ["/api/ai-import"],
    load: async () => (await import("./ai-import")).registerAiImportRoutes,
  });
  await registerLazyRouteModule(app, {
    prefixes: ["/api/ai-validation"],
    load: async () => (await import("./aiValidationRoutes")).registerAiValidationRoutes,
  });
  await registerLazyRouteModule(app, {
    prefixes: ["/api/ai-agent"],
    load: async () => (await import("./aiAgentRoutes")).registerAiAgentRoutes,
  });
}
