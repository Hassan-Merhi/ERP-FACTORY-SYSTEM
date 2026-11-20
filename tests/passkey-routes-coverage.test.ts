/**
 * WebAuthn passkey routes (server/routes/passkeyRoutes.ts) over HTTP in one
 * rolled-back company per test. The WebAuthn verification library
 * (@simplewebauthn/server) is mocked at the module boundary: option generation
 * returns a fresh challenge and each verification is scripted per test, so the
 * route's own checks are what is exercised. Refusals first: no session, no or
 * consumed challenge (no replay), failed verifications and origin mismatches
 * thrown by the library - none of which write a credential. Passkey sign-in is
 * pinned at its current, fail-closed behaviour (see the KNOWN BUG note).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const webauthn = vi.hoisted(() => ({
  seq: 0,
  verifyRegistration: vi.fn(),
  verifyAuthentication: vi.fn(),
  generateRegistration: vi.fn(),
  generateAuthentication: vi.fn(),
}));
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: webauthn.generateRegistration,
  generateAuthenticationOptions: webauthn.generateAuthentication,
  verifyRegistrationResponse: webauthn.verifyRegistration,
  verifyAuthenticationResponse: webauthn.verifyAuthentication,
}));

import { rolledBackApp, withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PUBLIC_KEY = "AQIDBA"; // base64url of bytes 1,2,3,4
const savedEnv = { rp: process.env.PASSKEY_RP_ID, origin: process.env.PASSKEY_ORIGIN };

beforeEach(() => {
  delete process.env.PASSKEY_RP_ID;
  delete process.env.PASSKEY_ORIGIN;
  webauthn.generateRegistration.mockReset().mockImplementation(async (opts: Record<string, unknown>) => ({
    ...opts,
    challenge: `reg-challenge-${++webauthn.seq}`,
  }));
  webauthn.generateAuthentication.mockReset().mockImplementation(async (opts: Record<string, unknown>) => ({
    ...opts,
    challenge: `auth-challenge-${++webauthn.seq}`,
  }));
  webauthn.verifyRegistration.mockReset();
  webauthn.verifyAuthentication.mockReset();
});
afterEach(() => {
  for (const [key, value] of [
    ["PASSKEY_RP_ID", savedEnv.rp],
    ["PASSKEY_ORIGIN", savedEnv.origin],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let ip = 0;
async function anonymous() {
  const agent = request.agent(await rolledBackApp());
  const address = `10.252.${(++ip >> 8) & 255}.${ip & 255}`;
  return {
    post: (url: string) => agent.post(url).set("X-Forwarded-For", address),
    get: (url: string) => agent.get(url).set("X-Forwarded-For", address),
  };
}

async function credential(w: FactoryWorld, userId: string, credentialId: string, counter = 5) {
  return w.one(
    `INSERT INTO passkey_credentials (user_id, credential_id, public_key, counter, device_name, transports)
     VALUES ($1, $2, $3, $4, 'Laptop', '["internal"]') RETURNING id`,
    [userId, credentialId, PUBLIC_KEY, counter]
  );
}

const counterOf = async (w: FactoryWorld, credentialId: string) =>
  Number((await w.q(`SELECT counter FROM passkey_credentials WHERE credential_id = $1`, [credentialId]))[0]?.counter);
const credentialsOf = (w: FactoryWorld, userId: string) =>
  w.q(`SELECT credential_id FROM passkey_credentials WHERE user_id = $1 ORDER BY id`, [userId]);

describe("registration", () => {
  it("refuses anonymous callers and a verify without a challenge", () =>
    withFactoryWorld(async (w) => {
      const anon = await anonymous();
      expect((await anon.post("/api/auth/passkey/register/options")).status).toBe(401);
      expect((await anon.post("/api/auth/passkey/register/verify")).status).toBe(401);
      const res = await w.agent.post("/api/auth/passkey/register/verify").send({ id: "x" });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("No challenge in session");
      expect(webauthn.verifyRegistration).not.toHaveBeenCalled();
    }));

  it("refuses a failed verification and a library rejection (wrong origin) without storing anything", () =>
    withFactoryWorld(async (w) => {
      await w.agent.post("/api/auth/passkey/register/options").send({});
      webauthn.verifyRegistration.mockResolvedValueOnce({ verified: false });
      expect((await w.agent.post("/api/auth/passkey/register/verify").send({ id: "c1" })).status).toBe(400);
      webauthn.verifyRegistration.mockResolvedValueOnce({ verified: true, registrationInfo: undefined });
      const noInfo = await w.agent.post("/api/auth/passkey/register/verify").send({ id: "c1" });
      expect(noInfo.body.message).toBe("Verification failed");
      webauthn.verifyRegistration.mockRejectedValueOnce(new Error("Unexpected registration response origin"));
      const origin = await w.agent.post("/api/auth/passkey/register/verify").send({ id: "c1" });
      expect(origin.status).toBe(500);
      expect(origin.body.message).toMatch(/origin/);
      expect(await credentialsOf(w, w.userId)).toEqual([]);
    }));

  it("excludes existing credentials, stores a verified one and consumes the challenge", () =>
    withFactoryWorld(async (w) => {
      await credential(w, w.userId, `${w.tag}-old`);
      process.env.PASSKEY_RP_ID = "erp.example.test";
      process.env.PASSKEY_ORIGIN = "https://erp.example.test";
      const options = await w.agent.post("/api/auth/passkey/register/options").send({});
      expect(options.status).toBe(200);
      expect(options.body).toMatchObject({
        rpID: "erp.example.test",
        userName: w.username,
        excludeCredentials: [{ id: `${w.tag}-old`, type: "public-key" }],
      });
      webauthn.verifyRegistration.mockResolvedValueOnce({
        verified: true,
        registrationInfo: { credential: { id: `${w.tag}-new`, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0 } },
      });
      const body = { id: `${w.tag}-new`, deviceName: "Phone", response: { transports: ["hybrid"] } };
      const ok = await w.agent.post("/api/auth/passkey/register/verify").send(body);
      expect(ok.body).toEqual({ verified: true });
      expect(webauthn.verifyRegistration).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedChallenge: options.body.challenge,
          expectedOrigin: ["https://erp.example.test"],
          expectedRPID: "erp.example.test",
        })
      );
      const [stored] = await w.q(
        `SELECT public_key, device_name, transports, counter FROM passkey_credentials WHERE credential_id = $1`,
        [`${w.tag}-new`]
      );
      expect(stored).toEqual({ public_key: PUBLIC_KEY, device_name: "Phone", transports: '["hybrid"]', counter: "0" });

      // Replay of the same attestation: the challenge was consumed.
      const replay = await w.agent.post("/api/auth/passkey/register/verify").send(body);
      expect(replay.status).toBe(400);
      expect(replay.body.message).toBe("No challenge in session");
      expect(webauthn.verifyRegistration).toHaveBeenCalledTimes(1);
    }));
});

describe("authentication", () => {
  it("issues options scoped to a known username and none for an unknown one", () =>
    withFactoryWorld(async (w) => {
      await credential(w, w.userId, `${w.tag}-key`);
      const anon = await anonymous();
      const known = await anon.post("/api/auth/passkey/authenticate/options").send({ username: w.username });
      expect(known.status).toBe(200);
      expect(known.body.allowCredentials).toEqual([{ id: `${w.tag}-key`, type: "public-key" }]);
      const unknown = await anon.post("/api/auth/passkey/authenticate/options").send({ username: "nobody-here" });
      expect(unknown.body.allowCredentials).toEqual([]);
      const blank = await anon.post("/api/auth/passkey/authenticate/options");
      expect(blank.body.allowCredentials).toEqual([]);
      expect(blank.body.rpID).toBeTypeOf("string");
    }));

  it("refuses a verify without a challenge", () =>
    withFactoryWorld(async (w) => {
      await credential(w, w.userId, `${w.tag}-key`, 7);
      const anon = await anonymous();
      const res = await anon.post("/api/auth/passkey/authenticate/verify").send({ id: `${w.tag}-key` });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("No challenge in session");
      expect(webauthn.verifyAuthentication).not.toHaveBeenCalled();
    }));

  /*
   * KNOWN BUG (server/routes/passkeyRoutes.ts:147): the credential lookup
   * selects `u.role`, but the users table has no role column (roles live in
   * user_company_roles). Every passkey sign-in that reaches the lookup fails
   * with a 500 before the WebAuthn response is verified, so the "Passkey not
   * found", failed-verification, origin / RP / counter-regression refusals and
   * the successful sign-in below the lookup cannot run. This pins the current
   * behaviour: it fails closed - nothing is verified, no counter moves and no
   * one is signed in. Fix: drop `u.role` from that SELECT.
   */
  it("currently fails every passkey sign-in at the credential lookup, closed", () =>
    withFactoryWorld(async (w) => {
      await credential(w, w.userId, `${w.tag}-key`, 7);
      const anon = await anonymous();
      await anon.post("/api/auth/passkey/authenticate/options").send({ username: w.username });
      webauthn.verifyAuthentication.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 8 } });
      for (const id of [`${w.tag}-key`, "not-registered"]) {
        // The failed statement aborts the surrounding test transaction; a
        // savepoint per request lets the test keep reading afterwards.
        await w.q(`SAVEPOINT passkey_probe`);
        const res = await anon.post("/api/auth/passkey/authenticate/verify").send({ id });
        await w.q(`ROLLBACK TO SAVEPOINT passkey_probe`);
        expect(res.status, id).toBe(500);
        expect(res.body.message).toMatch(/^Failed query:[\s\S]*u\.role/);
      }
      expect(webauthn.verifyAuthentication).not.toHaveBeenCalled();
      expect(await counterOf(w, `${w.tag}-key`)).toBe(7);
      expect((await anon.get("/api/auth/me")).status).toBe(401);
    }));
});

describe("listing and deleting passkeys", () => {
  it("lists only the caller's passkeys and deletes only the caller's own", () =>
    withFactoryWorld(async (w) => {
      const own = await credential(w, w.userId, `${w.tag}-mine`);
      const [other] = await w.q<{ id: string }>(
        `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`,
        [`${w.tag.toLowerCase()}_other`]
      );
      const foreign = await credential(w, other.id, `${w.tag}-theirs`);
      const list = await w.agent.get("/api/auth/passkey/list");
      expect(list.body.map((r: { id: number }) => r.id)).toEqual([own]);
      expect(list.body[0]).toMatchObject({ device_name: "Laptop" });

      expect((await w.agent.delete(`/api/auth/passkey/${foreign}`)).body).toEqual({ ok: true });
      expect(await credentialsOf(w, other.id)).toHaveLength(1);
      expect((await w.agent.delete(`/api/auth/passkey/${own}`)).status).toBe(200);
      expect(await credentialsOf(w, w.userId)).toEqual([]);
      expect((await (await anonymous()).get("/api/auth/passkey/list")).status).toBe(401);
    }));
});
