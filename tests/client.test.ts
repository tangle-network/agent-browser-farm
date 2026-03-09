import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp, type AppInstance } from "../src/server.js";
import { Allocator } from "../src/allocator.js";
import { BrowserFarmClient, BrowserFarmError } from "../src/client.js";
import type { Backend, BrowserType, PoolStatus } from "../src/backends/types.js";

function mockBackend(): Backend {
  return {
    id: "mock-client-test",
    type: "mock",
    protocol: "ws" as const,
    supports: new Set<BrowserType>(["chrome", "firefox", "webkit"]),
    async createSession({ browser }) {
      return {
        backendId: `mock-${crypto.randomUUID().slice(0, 8)}`,
        wsEndpoint: `ws://mock:3000/${browser}`,
        backendType: "mock",
      };
    },
    async destroySession() {},
    async status(): Promise<PoolStatus> {
      return { capacity: 10, active: 0, backend: "mock", healthy: true };
    },
    async healthCheck() { return true; },
    async shutdown() {},
  };
}

describe("BrowserFarmClient", () => {
  let instance: AppInstance;
  let client: BrowserFarmClient;

  beforeAll(() => {
    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 3 }),
      backends: [mockBackend()],
    });
    client = new BrowserFarmClient(`http://localhost:${instance.port}`);
  });

  afterAll(async () => { await instance.shutdown(); });

  it("health returns pool status", async () => {
    const health = await client.health();
    expect(health.pools["mock-client-test"]).toBeDefined();
    expect(health.pools["mock-client-test"].healthy).toBe(true);
  });

  it("creates and destroys a session", async () => {
    const session = await client.createSession({ browser: "chrome", clientId: "sdk-test" });
    expect(session.sessionId).toMatch(/^bf-/);
    expect(session.browser).toBe("chrome");
    expect(session.token).toBeTruthy();
    expect(session.wsEndpoint).toContain("ws");

    await client.destroySession(session.sessionId);

    // Should 404 now
    await expect(client.getSession(session.sessionId)).rejects.toThrow(BrowserFarmError);
  });

  it("lists sessions filtered by clientId", async () => {
    const s1 = await client.createSession({ browser: "chrome", clientId: "a" });
    const s2 = await client.createSession({ browser: "firefox", clientId: "b" });

    const allSessions = await client.listSessions();
    expect(allSessions.length).toBeGreaterThanOrEqual(2);

    const aOnly = await client.listSessions("a");
    expect(aOnly.every((s) => s.clientId === "a")).toBe(true);

    await client.destroySession(s1.sessionId);
    await client.destroySession(s2.sessionId);
  });

  it("lists backends", async () => {
    const backends = await client.listBackends();
    expect(backends.length).toBe(1);
    expect(backends[0].id).toBe("mock-client-test");
    expect(backends[0].supports).toContain("chrome");
  });

  it("throws BrowserFarmError on invalid browser", async () => {
    try {
      await client.createSession({ browser: "opera" as any });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserFarmError);
      expect((err as BrowserFarmError).status).toBe(400);
    }
  });
});
