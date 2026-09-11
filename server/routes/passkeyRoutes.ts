import type { Express, Request, Response } from "express";
import { randomBytes } from "crypto";
import { getErrorMessage } from "../lib/httpHandlers";
import { resultRows } from "../lib/queryResult";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { db } from "../db";
import { sql, eq } from "drizzle-orm";
import { requireAuth } from "../auth";
import { users } from "../../shared/schema";
import { storage } from "../storage";

function getRpID(req: Request): string {
  if (process.env.PASSKEY_RP_ID) return process.env.PASSKEY_RP_ID;
  return req.hostname || "localhost";
}

function getRpOrigins(req: Request): string[] {
  if (process.env.PASSKEY_ORIGIN) return [process.env.PASSKEY_ORIGIN];
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = req.get("host") || "localhost";
  const origin = `${proto}://${host}`;
  const origins = [origin];
  if (host.startsWith("localhost") || host.startsWith("127.")) {
    origins.push("http://localhost:5000", "http://localhost:5173");
  }
  return origins;
}

export function registerPasskeyRoutes(app: Express) {
  // ── Registration options (logged-in user adding a passkey) ───────────────
  app.post("/api/auth/passkey/register/options", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      const username = req.session.username || String(userId);

      const existingCreds = await db.execute(
        sql`SELECT credential_id FROM passkey_credentials WHERE user_id = ${userId}`
      );

      const excludeCredentials: { id: string; type: "public-key" }[] = existingCreds.rows.map((row) => ({
        id: row.credential_id as string,
        type: "public-key" as const,
      }));

      const options = await generateRegistrationOptions({
        rpName: "HMD International Group",
        rpID: getRpID(req),
        userID: Buffer.from(String(userId)),
        userName: username,
        attestationType: "none",
        excludeCredentials,
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      });

      req.session.passkeyChallenge = options.challenge;
      res.json(options);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Registration verify ──────────────────────────────────────────────────
  app.post("/api/auth/passkey/register/verify", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      const challenge = req.session.passkeyChallenge;
      if (!challenge) return res.status(400).json({ message: "No challenge in session" });

      const verification = await verifyRegistrationResponse({
        response: req.body,
        expectedChallenge: challenge,
        expectedOrigin: getRpOrigins(req),
        expectedRPID: getRpID(req),
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ message: "Verification failed" });
      }

      const { credential } = verification.registrationInfo;
      const credentialId = credential.id;
      const publicKey = isoBase64URL.fromBuffer(credential.publicKey);
      const deviceName = req.body.deviceName || null;
      const transports = JSON.stringify(req.body.response?.transports || []);

      await db.execute(sql`
        INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, device_name, transports, created_at)
        VALUES (${userId}, ${credentialId}, ${publicKey}, ${credential.counter}, ${deviceName}, ${transports}, NOW())
        ON CONFLICT (credential_id) DO NOTHING
      `);

      delete req.session.passkeyChallenge;
      res.json({ verified: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Authentication options (public — no session needed) ──────────────────
  app.post("/api/auth/passkey/authenticate/options", async (req: Request, res: Response) => {
    try {
      const { username } = req.body || {};

      let allowCredentials: { id: string; type: "public-key" }[] = [];
      if (username) {
        const userRow = await db.execute(sql`SELECT id FROM users WHERE username = ${username} LIMIT 1`);
        if (userRow.rows.length > 0) {
          const uid = userRow.rows[0].id;
          const creds = await db.execute(sql`SELECT credential_id FROM passkey_credentials WHERE user_id = ${uid}`);
          allowCredentials = creds.rows.map((r) => ({
            id: r.credential_id as string,
            type: "public-key" as const,
          }));
        }
      }

      const options = await generateAuthenticationOptions({
        rpID: getRpID(req),
        allowCredentials,
        userVerification: "preferred",
      });

      req.session.passkeyChallenge = options.challenge;
      res.json(options);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Authentication verify ────────────────────────────────────────────────
  app.post("/api/auth/passkey/authenticate/verify", async (req: Request, res: Response) => {
    try {
      const challenge = req.session.passkeyChallenge;
      if (!challenge) return res.status(400).json({ message: "No challenge in session" });

      const credId = req.body.id;
      const credRow = await db.execute(sql`
        SELECT pc.*, u.id as uid, u.username, u.role
        FROM passkey_credentials pc
        JOIN users u ON u.id = pc.user_id
        WHERE pc.credential_id = ${credId}
        LIMIT 1
      `);

      if (credRow.rows.length === 0) {
        return res.status(400).json({ message: "Passkey not found" });
      }

      const cred = resultRows<{
        credential_id: string;
        public_key: string;
        counter: number;
        transports: string | null;
        uid: string;
        username: string;
      }>(credRow)[0];

      const verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: challenge,
        expectedOrigin: getRpOrigins(req),
        expectedRPID: getRpID(req),
        credential: {
          id: cred.credential_id as string,
          publicKey: isoBase64URL.toBuffer(cred.public_key),
          counter: cred.counter,
          transports: JSON.parse(cred.transports || "[]"),
        },
      });

      if (!verification.verified) {
        return res.status(400).json({ message: "Passkey verification failed" });
      }

      await db.execute(sql`
        UPDATE passkey_credentials SET counter = ${verification.authenticationInfo.newCounter}
        WHERE credential_id = ${credId}
      `);

      const userId: string = String(cred.uid);
      const [userRecord] = await db.select().from(users).where(eq(users.id, userId));
      if (!userRecord) return res.status(401).json({ message: "User not found" });

      // Resolve authorization context before session regeneration. The challenge
      // has already been verified, and no authenticated state is written until a
      // fresh session ID has been issued.
      const userCompanies = await storage.getUserCompaniesWithRoles(userId);

      await new Promise<void>((resolve, reject) => {
        req.session.regenerate((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      req.session.userId = userId;
      req.session.username = cred.username;
      req.session.csrfToken = randomBytes(32).toString("hex");
      req.session.ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || null;
      req.session.userAgent = req.headers["user-agent"] || null;
      req.session.loginAt = new Date().toISOString();

      if (userCompanies.length > 0) {
        const fc = userCompanies[0] as unknown as { companyId: typeof req.session.currentCompanyId } & {
          role: typeof req.session.currentRole;
        } & { assignedLocationId: typeof req.session.currentLocationId } & {
          posStation: typeof req.session.currentPOSStation;
        } & { cashAccountId: typeof req.session.cashAccountId } & {
          canSellNegativeStock: typeof req.session.canSellNegativeStock;
        } & { daybookEditDays: typeof req.session.daybookEditDays } & {
          canAccessCustomers: typeof req.session.canAccessCustomers;
        } & { canDeleteRecords: typeof req.session.canDeleteRecords } & {
          companyName: typeof req.session.currentCompanyName;
        };
        req.session.currentCompanyId = fc.companyId;
        req.session.currentRole = fc.role;
        req.session.currentLocationId = fc.assignedLocationId;
        req.session.currentPOSStation = fc.posStation;
        req.session.cashAccountId = fc.cashAccountId;
        req.session.canSellNegativeStock = fc.canSellNegativeStock;
        req.session.daybookEditDays = fc.daybookEditDays;
        req.session.canAccessCustomers = fc.canAccessCustomers;
        req.session.canDeleteRecords = fc.canDeleteRecords;
        req.session.currentCompanyName = fc.companyName || null;
      }

      const { password: _pw, ...userWithoutPassword } = userRecord;
      await new Promise<void>((resolve, reject) => {
        req.session.save((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      res.json({ ...userWithoutPassword, currentRole: req.session.currentRole ?? null });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── List passkeys for current user ───────────────────────────────────────
  app.get("/api/auth/passkey/list", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      const rows = await db.execute(sql`
        SELECT id, device_name, created_at FROM passkey_credentials
        WHERE user_id = ${userId} ORDER BY created_at DESC
      `);
      res.json(rows.rows);
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── Delete a passkey ─────────────────────────────────────────────────────
  app.delete("/api/auth/passkey/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId!;
      await db.execute(sql`
        DELETE FROM passkey_credentials
        WHERE id = ${parseInt(req.params.id)} AND user_id = ${userId}
      `);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
