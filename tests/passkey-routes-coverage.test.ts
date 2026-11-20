/**
 * WebAuthn passkey routes (server/routes/passkeyRoutes.ts) over HTTP in one
 * rolled-back company per test. The WebAuthn verification library
 * (@simplewebauthn/server) is mocked at the module boundary: option generation
 * returns a fresh challenge and each verification is scripted per test, so the
 * route's own checks are what is exercised. Refusals first: no session, no or
 * consumed challenge (no replay), failed verifications and origin mismatches
 * thrown by the library - none of which write a credential - then passkey
 * sign-in end to end.
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
});

/*
 * Sign-in end to end. The fake verifyAuthenticationResponse below applies the
 * library's own checks (challenge, origin, RP ID, signature counter) to the
 * values the route passes it, so each refusal proves the route handed the
 * library the right expectations. Every refusal leaves the counter alone and
 * signs no one in.
 */
const RP = { id: "erp.example.test", origin: "https://erp.example.test" };

type Assertion = { challenge: string; origin: string; rpID: string; counter: number };
type VerifyOptions = {
  response: { response: Assertion };
  expectedChallenge: string;
  expectedOrigin: string[];
  expectedRPID: string;
  credential: { id: string; counter: number };
};
function libraryVerify(opts: VerifyOptions) {
  const a = opts.response.response;
  if (a.challenge !== opts.expectedChallenge) throw new Error("Unexpected authentication response challenge");
  if (!opts.expectedOrigin.includes(a.origin)) throw new Error("Unexpected authentication response origin");
  if (a.rpID !== opts.expectedRPID) throw new Error("Unexpected RP ID hash");
  const stored = Number(opts.credential.counter);
  if ((a.counter > 0 || stored > 0) && a.counter <= stored) {
    throw new Error(`Response counter value ${a.counter} was lower than expected ${stored}`);
  }
  return { verified: true, authenticationInfo: { newCounter: a.counter, credentialID: opts.credential.id } };
}

/** An anonymous browser that asked for sign-in options (optionally for a username). */
async function signInAttempt(username?: string, withOptions = true) {
  const anon = await anonymous();
  let challenge = "never-issued";
  if (withOptions) {
    const options = await anon.post("/api/auth/passkey/authenticate/options").send(username ? { username } : {});
    expect(options.status).toBe(200);
    challenge = options.body.challenge;
  }
  const assertion = (id: string, overrides: Partial<Assertion> = {}) => ({
    id,
    rawId: id,
    type: "public-key",
    response: { challenge, origin: RP.origin, rpID: RP.id, counter: 8, ...overrides },
  });
  return { anon, challenge, assertion };
}

async function addUser(w: FactoryWorld, suffix: string, role: string, active = true) {
  const [user] = await w.q<{ id: string; username: string }>(
    `INSERT INTO users (username, password, active) VALUES ($1, 'x', $2) RETURNING id, username`,
    [`${w.tag.toLowerCase()}_${suffix}`, active]
  );
  await w.q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3)`, [
    user.id,
    w.companyId,
    role,
  ]);
  return user;
}

describe("passkey sign-in", () => {
  beforeEach(() => {
    process.env.PASSKEY_RP_ID = RP.id;
    process.env.PASSKEY_ORIGIN = RP.origin;
    webauthn.verifyAuthentication.mockImplementation(async (opts: VerifyOptions) => libraryVerify(opts));
  });

  it("signs the credential's owner in, advances the counter and refuses a replay", () =>
    withFactoryWorld(async (w) => {
      const key = `${w.tag}-key`;
      await credential(w, w.userId, key, 7);
      const { anon, challenge, assertion } = await signInAttempt(w.username);
      const res = await anon.post("/api/auth/passkey/authenticate/verify").send(assertion(key));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: w.userId, username: w.username, currentRole: "Admin" });
      expect(res.body).not.toHaveProperty("password");
      expect(webauthn.verifyAuthentication).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedChallenge: challenge,
          expectedOrigin: [RP.origin],
          expectedRPID: RP.id,
          credential: expect.objectContaining({ id: key, publicKey: new Uint8Array([1, 2, 3, 4]) }),
        })
      );
      expect(await counterOf(w, key)).toBe(8);
      const me = await anon.get("/api/auth/me");
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ username: w.username, currentRole: "Admin", currentCompanyId: w.companyId });

      // The fresh session holds no challenge, so the same assertion cannot be replayed.
      const replay = await anon.post("/api/auth/passkey/authenticate/verify").send(assertion(key, { counter: 9 }));
      expect(replay.status).toBe(400);
      expect(replay.body.message).toBe("No challenge in session");
      expect(await counterOf(w, key)).toBe(8);
    }));

  it("refuses unknown passkeys, a wrong origin, RP or challenge, a counter regression and a failed check", () =>
    withFactoryWorld(async (w) => {
      const key = `${w.tag}-key`;
      await credential(w, w.userId, key, 7);
      const cases: { name: string; id?: string; overrides?: Partial<Assertion>; status: number; message: RegExp }[] = [
        { name: "not registered", id: "not-registered", status: 400, message: /^Passkey not found$/ },
        { name: "origin", overrides: { origin: "https://evil.example" }, status: 500, message: /origin/ },
        { name: "rp", overrides: { rpID: "evil.example" }, status: 500, message: /RP ID/ },
        { name: "stale challenge", overrides: { challenge: "auth-challenge-0" }, status: 500, message: /challenge/ },
        { name: "same counter", overrides: { counter: 7 }, status: 500, message: /counter value 7/ },
        { name: "lower counter", overrides: { counter: 3 }, status: 500, message: /counter value 3/ },
      ];
      for (const c of cases) {
        const { anon, assertion } = await signInAttempt(w.username);
        const res = await anon.post("/api/auth/passkey/authenticate/verify").send(assertion(c.id ?? key, c.overrides));
        expect(res.status, c.name).toBe(c.status);
        expect(res.body.message, c.name).toMatch(c.message);
        expect((await anon.get("/api/auth/me")).status, c.name).toBe(401);
      }
      expect(webauthn.verifyAuthentication).toHaveBeenCalledTimes(cases.length - 1);

      webauthn.verifyAuthentication.mockResolvedValueOnce({ verified: false });
      const failed = await signInAttempt(w.username);
      const res = await failed.anon.post("/api/auth/passkey/authenticate/verify").send(failed.assertion(key));
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Passkey verification failed");
      expect((await failed.anon.get("/api/auth/me")).status).toBe(401);

      const noOptions = await signInAttempt(undefined, false);
      const missing = await noOptions.anon.post("/api/auth/passkey/authenticate/verify").send(noOptions.assertion(key));
      expect(missing.status).toBe(400);
      expect(missing.body.message).toBe("No challenge in session");
      expect(await counterOf(w, key)).toBe(7);
    }));

  it("refuses an inactive account like the password login does", () =>
    withFactoryWorld(async (w) => {
      const user = await addUser(w, "gone", "Manager", false);
      await credential(w, user.id, `${w.tag}-gone`, 2);
      const { anon, assertion } = await signInAttempt(user.username);
      const res = await anon.post("/api/auth/passkey/authenticate/verify").send(assertion(`${w.tag}-gone`));
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Account is inactive");
      expect(await counterOf(w, `${w.tag}-gone`)).toBe(2);
      expect((await anon.get("/api/auth/me")).status).toBe(401);
    }));

  /*
   * Not checked by the route: the challenge is not bound to the username the
   * options were requested for. A browser that asked for user A's options and
   * answers with user B's passkey is signed in as B (the passkey's owner, whose
   * authenticator produced the assertion) - never as A. Pinned as-is.
   */
  it("signs in the passkey's owner even when the options named another user", () =>
    withFactoryWorld(async (w) => {
      await credential(w, w.userId, `${w.tag}-a`, 1);
      const other = await addUser(w, "b", "Manager");
      await credential(w, other.id, `${w.tag}-b`, 1);
      const { anon, assertion } = await signInAttempt(w.username);
      const res = await anon.post("/api/auth/passkey/authenticate/verify").send(assertion(`${w.tag}-b`));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: other.id, username: other.username, currentRole: "Manager" });
      expect((await anon.get("/api/auth/me")).body.username).toBe(other.username);
      expect(await counterOf(w, `${w.tag}-a`)).toBe(1);
      expect(await counterOf(w, `${w.tag}-b`)).toBe(8);
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
