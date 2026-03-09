import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp, type AppInstance } from "../src/server.js";
import { Allocator } from "../src/allocator.js";
import type { Backend, BackendSession, BrowserType, PoolStatus } from "../src/backends/types.js";

function mockBackend(): Backend {
  return {
    id: "mock-test",
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

describe("HTTP API", () => {
  let instance: AppInstance;

  beforeAll(() => {
    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 3 }),
      backends: [mockBackend()],
    });
  });

  afterAll(async () => { await instance.shutdown(); });

  it("GET /health returns pool info", async () => {
    const res = await instance.app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pools["mock-test"]).toBeDefined();
    expect(body.pools["mock-test"].healthy).toBe(true);
  });

  it("POST /sessions creates a session", async () => {
    const res = await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "chrome", clientId: "test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toMatch(/^bf-/);
    expect(body.browser).toBe("chrome");
    expect(body.token).toBeTruthy();
    expect(body.wsEndpoint).toContain("/session/");
  });

  it("POST /sessions rejects invalid browser", async () => {
    const res = await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "opera" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /sessions/:id returns session details", async () => {
    const createRes = await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "chrome" }),
    });
    const { sessionId } = await createRes.json();

    const res = await instance.app.request(`/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.browser).toBe("chrome");
    expect(body.backendType).toBe("mock");
  });

  it("GET /sessions/:id returns 404 for unknown", async () => {
    const res = await instance.app.request("/sessions/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /sessions/:id destroys a session", async () => {
    const createRes = await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "firefox" }),
    });
    const { sessionId } = await createRes.json();

    const res = await instance.app.request(`/sessions/${sessionId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Verify gone
    const check = await instance.app.request(`/sessions/${sessionId}`);
    expect(check.status).toBe(404);
  });

  it("GET /backends lists registered backends", async () => {
    const res = await instance.app.request("/backends");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backends).toHaveLength(1);
    expect(body.backends[0].id).toBe("mock-test");
  });

  it("DELETE /backends/:id returns 404 for unknown", async () => {
    const res = await instance.app.request("/backends/nonexistent", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
