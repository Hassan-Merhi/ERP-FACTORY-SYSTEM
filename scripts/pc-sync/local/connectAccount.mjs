// Full offline mode: connecting this PC to a cloud account ("Connect this PC").
//
// The new person signs in on a separate client. The PC adopts that session
// only once the account is accepted (bindCloudAccount refuses another account
// while the current one still has entries to send); otherwise the new session
// is signed out and the PC keeps delivering as the person already connected.

import { createCloudClient } from "./cloudClient.mjs";
import { bindCloudAccount, rememberLocalLogin } from "./syncAgent.mjs";

/**
 * @returns {Promise<{ cloud: ReturnType<typeof createCloudClient>, userId: string, copyReset: boolean }>}
 */
export async function connectCloudAccount(local, cloudUrl, username, password, { fetch } = {}) {
  const candidate = createCloudClient(cloudUrl, fetch ? { fetch } : {});
  const userId = await candidate.login(String(username ?? ""), String(password ?? ""));
  let copyReset;
  try {
    copyReset = await bindCloudAccount(local, userId);
  } catch (error) {
    await candidate.post("/api/auth/logout").catch(() => undefined);
    throw error;
  }
  await rememberLocalLogin(local, userId, String(password));
  return { cloud: candidate, userId, copyReset };
}
