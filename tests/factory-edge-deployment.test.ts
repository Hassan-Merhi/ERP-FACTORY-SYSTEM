import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const load = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("factory LAN deployment contract", () => {
  it("binds only HTTPS to the specified private factory IP", () => {
    const config = load("deploy/lan/compose.yaml");
    expect(config).toContain("443:443/tcp");
    expect(config).toContain("EDGE_BIND_IP");
    expect(config).not.toMatch(/(?:^|\n)\s*-\s*["']?5432:5432/m);
    expect(config).not.toMatch(/(?:^|\n)\s*-\s*["']?5000:5000/m);
    expect(config).toContain("internal: true");
    expect(config).toContain("postgres_data:/var/lib/postgresql/data");
    expect(config).toContain("uploads_data:/app/uploads");
  });
  it("uses a dedicated local database with safe default read-only mode", () => {
    const config = load("deploy/lan/compose.yaml");
    expect(config).toContain("FACTORY_EDGE_MODE: lan");
    expect(config).toContain("FACTORY_EDGE_WRITE_MODE: ${EDGE_WRITE_MODE:-read-only}");
    expect(config).toContain('CSRF_ENFORCE: "1"');
    expect(config).toContain('ENABLE_SCHEDULERS: "false"');
    expect(config).toContain('RUN_STARTUP_MIGRATIONS: "true"');
    expect(config).not.toContain("DATABASE_URL:");
    expect(config).toContain("PGHOST: postgres");
  });
  it("never bundles local secrets or lets laptops use insecure HTTP", () => {
    const ignored = load(".dockerignore");
    const gitignore = load("deploy/lan/.gitignore");
    const proxy = load("deploy/lan/Caddyfile");
    expect(ignored).toContain("deploy/lan/certs");
    expect(ignored).toContain(".env");
    expect(gitignore).toContain("certs/");
    expect(gitignore).toContain(".env");
    expect(proxy).toContain("tls /certs/server.pem /certs/server-key.pem");
    expect(proxy).toContain("reverse_proxy app:5000");
    expect(proxy).not.toContain("tls internal");
  });
  it("has exactly the existing ERP runtime entry and no unexpected cloud proxy", () => {
    const image = load("deploy/lan/Dockerfile");
    expect(image).toContain("node:24-bookworm-slim");
    expect(image).toContain("npm run build");
    expect(image).toContain("./server/startupPreload.mjs");
    expect(image).toContain("./server/runtimeMemoryGuard.mjs");
    expect(image).toContain("USER node");
    expect(image).not.toContain("RENDER_DATABASE_URL");
  });
});
