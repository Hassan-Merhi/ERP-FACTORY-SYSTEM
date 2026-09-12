/**
 * Runtime request/session shape augmentations, moved out of server/index.ts
 * so the entry point only composes middleware and startup. Declarations are
 * identical to the originals — TypeScript module augmentation applies
 * program-wide once this file is part of the compilation.
 */
import "express-session";
import type { User } from "@shared/schema";

declare global {
  namespace Express {
    interface Request {
      user?: User & {
        role?: string;
        assignedLocationId?: number | null;
        posStation?: number | null;
        cashAccountId?: number | null;
        canSellNegativeStock?: boolean;
        daybookEditDays?: number;
        canAccessCustomers?: boolean;
      };
    }
  }
}

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

declare module "express-session" {
  interface SessionData {
    userId?: string;
    username?: string;
    currentCompanyId?: number;
    factoryCompanyId?: number;
    currentRole?: string;
    currentLocationId?: number | null;
    currentPOSStation?: number | null;
    cashAccountId?: number | null;
    canSellNegativeStock?: boolean;
    posViewOnly?: boolean;
    daybookEditDays?: number;
    canAccessCustomers?: boolean;
    canDeleteRecords?: boolean;
    /** Unix timestamp (ms) when user last confirmed their password via POST /api/auth/confirm-password */
    passwordConfirmedAt?: number;
  }
}
