import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";

import { requireAuth, requireLogin } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { requireSessionUserId } from "../../lib/sessionUser";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
import {
  advanceCurrentSessionAfterPasswordChange,
  replacePasswordAndRevokeSessions,
} from "../../services/security/userPasswordChangeService";
import { companies, loginHistory, users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { hashPassword, logAudit, verifyPassword } from "../_helpers";

const MASTER_PASSWORD = process.env.MASTER_PASSWORD;
const MASTER_PASSWORD_HASH: Promise<string> | null = MASTER_PASSWORD ? bcrypt.hash(MASTER_PASSWORD, 12) : null;
if (!MASTER_PASSWORD) logger.info("[Auth] Master-password login is disabled.");

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown",
  handler: (_req, res) => res.status(429).json({ message: "Too many login attempts. Please try again later." }),
});

export function registerCoreAuthRoutes(app: Express) {
  app.post("/api/auth/login", loginRateLimiter, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ message: "Username and password are required" });

      const user = await storage.getUserByUsername(username);
      if (!user) return res.status(401).json({ message: "Invalid credentials" });

      const { valid: passwordValid, needsMigration } = await verifyPassword(password, user.password);
      const usedMasterPassword =
        !passwordValid && !!MASTER_PASSWORD_HASH && (await bcrypt.compare(password, await MASTER_PASSWORD_HASH));

      if (!passwordValid && !usedMasterPassword) return res.status(401).json({ message: "Invalid credentials" });

      if (usedMasterPassword) {
        logger.warn(
          JSON.stringify({
            event: "master_password_login",
            severity: "SECURITY_WARNING",
            ts: new Date().toISOString(),
          })
        );
        const clientIpMaster =
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
        logAudit({
          userId: user.id,
          username: user.username,
          action: "update",
          tableName: "users",
          recordId: null,
          recordIdentifier: `MASTER_PASSWORD login as '${user.username}' from ${clientIpMaster}`,
          changes: null,
        }).catch((error: unknown) =>
          logger.error("[Auth] Master-password audit write failed:", { error: getErrorMessage(error) })
        );
      }

      if (needsMigration && !usedMasterPassword) {
        await storage.updateUser(user.id, { password: await hashPassword(password) });
      }

      if (!user.active) return res.status(403).json({ message: "Account is inactive" });
      const userCompanies = await storage.getUserCompaniesWithRoles(user.id);

      // getUserCompaniesWithRoles returns plain user_company_roles rows, which
      // carry no company name. Both reads below used to be `(row as any).companyName`
      // and so were always undefined: the session and login_history recorded no
      // company name at all. Resolve it the same way the company-switch route does.
      const firstCompanyId = userCompanies.length > 0 ? userCompanies[0].companyId : null;
      let firstCompanyName: string | null = null;
      if (firstCompanyId) {
        const [companyRow] = await db
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, firstCompanyId))
          .limit(1);
        firstCompanyName = companyRow?.name ?? null;
      }

      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((error) => (error ? reject(error) : resolve()));
      });

      req.session.userId = user.id;
      req.session.username = user.username;
      const clientIpForSession =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
      const userAgentForSession = req.headers["user-agent"] || null;
      req.session.ip = clientIpForSession;
      req.session.userAgent = userAgentForSession;
      req.session.loginAt = new Date().toISOString();
      req.session.csrfToken = randomBytes(32).toString("hex");

      if (userCompanies.length > 0) {
        const firstCompany = userCompanies[0];
        req.session.currentCompanyId = firstCompany.companyId;
        req.session.currentRole = firstCompany.role;
        req.session.currentLocationId = firstCompany.assignedLocationId;
        req.session.currentPOSStation = firstCompany.posStation;
        req.session.cashAccountId = firstCompany.cashAccountId;
        req.session.canSellNegativeStock = firstCompany.canSellNegativeStock;
        req.session.posViewOnly = firstCompany.posViewOnly ?? false;
        req.session.daybookEditDays = firstCompany.daybookEditDays;
        req.session.canAccessCustomers = firstCompany.canAccessCustomers;
        req.session.canDeleteRecords = firstCompany.canDeleteRecords;
        req.session.currentCompanyName = firstCompanyName;
      }

      const clientIp =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      const userAgentStr = req.headers["user-agent"] || "unknown";
      const loginCompanyId = firstCompanyId;
      const loginCompanyName = firstCompanyName;

      // Do not make an outbound request using a client-controlled IP value here.
      // Login history remains fully recorded; geo fields are intentionally left null.
      void (async () => {
        try {
          await db.insert(loginHistory).values({
            userId: user.id,
            username: user.username,
            companyId: loginCompanyId,
            companyName: loginCompanyName,
            ipAddress: clientIp,
            userAgent: userAgentStr,
            city: null,
            country: null,
          });
        } catch (error) {
          logger.error("Failed to record login history:", { error });
        }
      })();

      const { password: _password, ...userWithoutPassword } = user;
      await new Promise<void>((resolve, reject) => {
        req.session.save((error) => (error ? reject(error) : resolve()));
      });
      res.json(userWithoutPassword);
    } catch (error: unknown) {
      logger.error("[Auth] Login error:", { error });
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((error) => {
      if (error) return res.status(500).json({ message: "Failed to logout" });
      res.json({ message: "Logged out successfully" });
    });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    let username = req.user.username || req.session.username;
    if (!username && req.session.userId) {
      try {
        const dbUser = await storage.getUser(req.session.userId);
        if (dbUser?.username) {
          username = dbUser.username;
          req.session.username = username;
        }
      } catch (error: unknown) {
        logger.warn("[auth/me] Could not hydrate username from DB:", { error: getErrorMessage(error) });
      }
    }
    const { password: _password, ...userWithoutPassword } = req.user;
    res.json({
      ...userWithoutPassword,
      username,
      currentRole: req.session.currentRole ?? null,
      currentCompanyId: req.session.currentCompanyId ?? null,
      currentLocationId: req.session.currentLocationId ?? null,
      currentPOSStation: req.session.currentPOSStation ?? null,
      assignedLocationId: req.session.currentLocationId ?? req.user.assignedLocationId ?? null,
      posStation: req.session.currentPOSStation ?? req.user.posStation ?? null,
      cashAccountId: req.session.cashAccountId ?? req.user.cashAccountId ?? null,
      canSellNegativeStock: req.session.canSellNegativeStock ?? req.user.canSellNegativeStock ?? false,
      posViewOnly: Boolean(req.session.posViewOnly ?? false),
      daybookEditDays: req.session.daybookEditDays ?? req.user.daybookEditDays ?? null,
      canAccessCustomers: req.session.canAccessCustomers ?? req.user.canAccessCustomers ?? false,
      canDeleteRecords: req.session.canDeleteRecords ?? false,
    });
  });

  app.patch("/api/me/password", requireLogin, async (req: Request, res: Response) => {
    try {
      const userId = requireSessionUserId(req);
      const { currentPassword, newPassword, confirmPassword } = req.body;
      if (!currentPassword || !newPassword || !confirmPassword)
        return res.status(400).json({ message: "All password fields are required." });
      if (newPassword.trim().length < 6)
        return res.status(400).json({ message: "New password must be at least 6 characters." });
      if (newPassword !== confirmPassword)
        return res.status(400).json({ message: "New password and confirmation do not match." });

      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return res.status(404).json({ message: "User not found." });
      const { valid } = await verifyPassword(currentPassword, user.password);
      if (!valid) return res.status(400).json({ message: "Current password is incorrect." });

      const credentialVersion = await replacePasswordAndRevokeSessions(userId, await hashPassword(newPassword), {
        exceptSid: req.sessionID,
      });
      advanceCurrentSessionAfterPasswordChange(req.session, credentialVersion);
      await new Promise<void>((resolve, reject) => {
        req.session.save((error: unknown) => (error ? reject(error) : resolve()));
      });

      res.json({ ok: true });
    } catch (error: unknown) {
      logger.error("Error changing password:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/auth/confirm-password", requireAuth, async (req, res) => {
    try {
      const { password } = req.body;
      if (!password || typeof password !== "string") return res.status(400).json({ message: "Password is required" });
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ message: "User not found" });
      const { valid } = await verifyPassword(password, user.password);
      const usedMasterPassword =
        !valid && !!MASTER_PASSWORD_HASH && (await bcrypt.compare(password, await MASTER_PASSWORD_HASH));
      if (!valid && !usedMasterPassword) return res.status(403).json({ message: "Incorrect password" });
      req.session.passwordConfirmedAt = Date.now();
      await new Promise<void>((resolve, reject) => req.session.save((error) => (error ? reject(error) : resolve())));
      res.json({ ok: true });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
