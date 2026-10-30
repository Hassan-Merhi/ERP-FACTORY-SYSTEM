import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseEdgeEnvironment,
  verifyEdgeInstallation,
  verifyEdgeTlsCertificate,
} from "../scripts/edge/verify-edge-configuration.mjs";

describe("LAN edge operator preflight", () => {
  it("parses only known dotenv keys without shell evaluation", () => {
    expect(
      parseEdgeEnvironment("# comment\nEDGE_HOSTNAME=erp.factory.internal\nEDGE_WRITE_MODE=read-only\n")
    ).toMatchObject({ EDGE_HOSTNAME: "erp.factory.internal", EDGE_WRITE_MODE: "read-only" });
    expect(() => parseEdgeEnvironment("EDGE_X=$(curl attacker)")).toThrow("EDGE_ENV_UNRECOGNIZED_LINE");
    expect(() => parseEdgeEnvironment("EDGE_HOSTNAME=x\nEDGE_HOSTNAME=y")).toThrow("EDGE_ENV_DUPLICATE_KEY");
    expect(() => parseEdgeEnvironment("EDGE_HOSTNAME=$ENV")).toThrow("EDGE_ENV_UNSAFE_VALUE");
    const sample = readFileSync("deploy/lan/factory-edge.env.sample", "utf8");
    const parsed = parseEdgeEnvironment(sample);
    expect(parsed).toHaveProperty("EDGE_RELEASE_SHA");
    expect(parsed).toHaveProperty("EDGE_WRITER_EPOCH");
    expect(parsed).toHaveProperty("EDGE_BASELINE_SHA256");
    expect(() => parseEdgeEnvironment("EDGE_WRITER_EPOCH=1\\nEDGE_BASELINE_SHA256=" + "a".repeat(64))).not.toThrow();
  });
  it("rejects a nonprivate LAN bind IP before reading credentials", () => {
    expect(() => verifyEdgeInstallation({ EDGE_BIND_IP: "0.0.0.0" }, "", "")).toThrow("EDGE_BIND_IP_NOT_PRIVATE");
    expect(() => verifyEdgeInstallation({ EDGE_BIND_IP: "8.8.8.8" }, "", "")).toThrow("EDGE_BIND_IP_NOT_PRIVATE");
    expect(() => verifyEdgeInstallation({ EDGE_BIND_IP: "127.0.0.1" }, "", "")).toThrow("EDGE_BIND_IP_NOT_PRIVATE");
  });
  it("validates real X.509 SAN and matching TLS private key", () => {
    const dir = mkdtempSync(join(tmpdir(), "erp-edge-x509-"));
    try {
      const key = join(dir, "key.pem");
      const cert = join(dir, "cert.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-nodes",
          "-days",
          "14",
          "-subj",
          "/CN=erp.factory.internal",
          "-addext",
          "subjectAltName=DNS:erp.factory.internal",
          "-keyout",
          key,
          "-out",
          cert,
        ],
        { stdio: "ignore" }
      );
      const originalCert = readFileSync(cert);
      const privateKey = readFileSync(key);
      expect(verifyEdgeTlsCertificate(originalCert, privateKey, "erp.factory.internal").hostname).toBe(
        "erp.factory.internal"
      );
      expect(() => verifyEdgeTlsCertificate(originalCert, privateKey, "other.factory.internal")).toThrow(
        "EDGE_TLS_HOSTNAME_NOT_IN_SAN"
      );
      const secondKey = join(dir, "other-key.pem");
      const secondCert = join(dir, "other-cert.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-nodes",
          "-days",
          "14",
          "-subj",
          "/CN=other.factory.internal",
          "-addext",
          "subjectAltName=DNS:other.factory.internal",
          "-keyout",
          secondKey,
          "-out",
          secondCert,
        ],
        { stdio: "ignore" }
      );
      expect(() => verifyEdgeTlsCertificate(originalCert, readFileSync(secondKey), "erp.factory.internal")).toThrow(
        "EDGE_TLS_KEY_MISMATCH"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
