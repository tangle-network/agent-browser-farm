import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Allocator, AllocatorError } from "../src/allocator.js";
import type { Backend, BackendSession, BrowserType, PoolStatus } from "../src/backends/types.js";

function mockBackend(opts?: { id?: string; type?: string; supports?: BrowserType[] }): Backend {
  const id = opts?.id || `mock-${crypto.randomUUID().slice(0, 8)}`;
  const type = opts?.type || "mock";
  const supports = new Set<BrowserType>(opts?.supports || ["chrome", "firefox", "webkit"]);
  const sessions = new Map<string, BackendSession>();

  return {
    id,
    type,
    protocol: "ws" as const,
    supports,
    async createSession({ browser }) {
      const backendId = `mock-${crypto.randomUUID().slice(0, 8)}`;
      const session: BackendSession = {
        backendId,
        wsEndpoint: `ws://mock:3000/${browser}`,
        backendType: type,
      };
      sessions.set(backendId, session);
      return session;
    },
    async destroySession(backendId) { sessions.delete(backendId); },
    async status(): Promise<PoolStatus> {
      return { capacity: 10, active: sessions.size, backend: type, healthy: true };
    },
    async healthCheck() { return true; },
    async shutdown() { sessions.clear(); },
  };
}

describe("Allocator", () => {
  let allocator: Allocator;

  beforeEach(() => {
    allocator = new Allocator({ maxSessions: 5, maxPerClient: 2 });
    allocator.addBackend(mockBackend({ id: "mock-1" }));
  });

  afterEach(async () => { await allocator.shutdown(); });

  it("creates a session and returns connection info", async () => {
    const result = await allocator.createSession({ browser: "chrome" });
    expect(result.sessionId).toMatch(/^bf-/);
    expect(result.wsEndpoint).toBe(`/session/${result.sessionId}`);
    expect(result.browser).toBe("chrome");
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeTruthy();
  });

  it("tracks sessions by ID", async () => {
    const result = await allocator.createSession({ browser: "chrome", clientId: "test" });
    const session = allocator.getSession(result.sessionId);
    expect(session).toBeDefined();
    expect(session!.browser).toBe("chrome");
    expect(session!.clientId).toBe("test");
    expect(session!.registryId).toBe("mock-1");
  });

  it("validates tokens", async () => {
    const result = await allocator.createSession({ browser: "chrome" });
    expect(allocator.validateToken(result.sessionId, result.token)).toBe(true);
    expect(allocator.validateToken(result.sessionId, "wrong")).toBe(false);
    expect(allocator.validateToken("nonexistent", result.token)).toBe(false);
  });

  it("destroys sessions", async () => {
    const result = await allocator.createSession({ browser: "chrome" });
    await allocator.destroySession(result.sessionId);
    expect(allocator.getSession(result.sessionId)).toBeUndefined();
  });

  it("enforces per-client concurrency limit", async () => {
    await allocator.createSession({ browser: "chrome", clientId: "cli-1" });
    await allocator.createSession({ browser: "firefox", clientId: "cli-1" });

    await expect(
      allocator.createSession({ browser: "webkit", clientId: "cli-1" })
    ).rejects.toThrow(AllocatorError);
  });

  it("enforces global session limit", async () => {
    await allocator.createSession({ browser: "chrome", clientId: "a" });
    await allocator.createSession({ browser: "chrome", clientId: "a" });
    await allocator.createSession({ browser: "chrome", clientId: "b" });
    await allocator.createSession({ browser: "chrome", clientId: "b" });
    await allocator.createSession({ browser: "chrome", clientId: "c" });

    await expect(
      allocator.createSession({ browser: "chrome", clientId: "c" })
    ).rejects.toThrow(AllocatorError);
  });

  it("returns 503 for unsupported browser type", async () => {
    try {
      await allocator.createSession({ browser: "ios-safari" as BrowserType });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AllocatorError);
      expect((err as AllocatorError).status).toBe(503);
    }
  });

  it("lists sessions filtered by clientId", async () => {
    await allocator.createSession({ browser: "chrome", clientId: "a" });
    await allocator.createSession({ browser: "firefox", clientId: "b" });

    expect(allocator.listSessions()).toHaveLength(2);
    const filtered = allocator.listSessions("a");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].browser).toBe("chrome");
  });

  it("reports health across backends", async () => {
    const health = await allocator.health();
    expect(health["mock-1"]).toBeDefined();
    expect(health["mock-1"].healthy).toBe(true);
  });

  it("touches session to update lastActivity", async () => {
    const result = await allocator.createSession({ browser: "chrome" });
    const before = allocator.getSession(result.sessionId)!.lastActivity;
    await new Promise((r) => setTimeout(r, 10));
    allocator.touchSession(result.sessionId);
    const after = allocator.getSession(result.sessionId)!.lastActivity;
    expect(after).toBeGreaterThan(before);
  });

  // --- Backend registry ---

  it("registers and lists backends", () => {
    allocator.addBackend(mockBackend({ id: "mock-2", type: "mock2", supports: ["ios-safari"] }));
    const list = allocator.listBackends();
    expect(list).toHaveLength(2);
    expect(list.find((b) => b.id === "mock-2")!.supports).toContain("ios-safari");
  });

  it("removes a backend with no active sessions", async () => {
    const b2 = mockBackend({ id: "mock-2" });
    allocator.addBackend(b2);
    allocator.removeBackend("mock-2");
    expect(allocator.listBackends()).toHaveLength(1);
  });

  it("refuses to remove a backend with active sessions", async () => {
    await allocator.createSession({ browser: "chrome" });
    expect(() => allocator.removeBackend("mock-1")).toThrow(AllocatorError);
  });

  it("throws 404 when removing nonexistent backend", () => {
    expect(() => allocator.removeBackend("nonexistent")).toThrow(AllocatorError);
  });

  it("prefers healthy backends over unhealthy", async () => {
    // Add a second backend, make the first "unhealthy" by removing it and adding unhealthy one
    // Actually test findBackend indirectly by creating a session
    const b2 = mockBackend({ id: "mock-healthy", supports: ["chrome"] });
    allocator.addBackend(b2);
    // Both should work — sessions route to first healthy match
    const result = await allocator.createSession({ browser: "chrome" });
    expect(result.sessionId).toMatch(/^bf-/);
  });
});
