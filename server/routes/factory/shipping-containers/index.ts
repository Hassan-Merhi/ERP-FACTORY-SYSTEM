/**
 * factoryShippingContainerRoutes route composition.
 *
 * Registration order matches the original single-file module exactly.
 * Express resolves first-match, so reordering these calls can change which
 * handler serves a request - config/route-manifest.json pins the result.
 */
import type { Express } from "express";
import { registerShippingContainerRowRoutes } from "./rows";
import { registerShippingContainerDocumentRoutes } from "./documents";
import { registerShippingAvailabilityRoutes } from "./availability";
import { registerScheduledContainerRoutes } from "./scheduled";
import { registerShippingWhatsappPreviewRoutes } from "./whatsapp-preview";
import { registerShippingZipPackageRoutes } from "./zip-package";

export function registerFactoryShippingContainerRoutes(app: Express) {
  registerShippingContainerRowRoutes(app);
  registerShippingContainerDocumentRoutes(app);
  registerShippingAvailabilityRoutes(app);
  registerScheduledContainerRoutes(app);
  registerShippingWhatsappPreviewRoutes(app);
  registerShippingZipPackageRoutes(app);
}
