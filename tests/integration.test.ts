import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { createApp, type AppInstance } from "../src/server.js";
import { Allocator } from "../src/allocator.js";
import type { Backend, BackendSession, BrowserType, PoolStatus } from "../src/backends/types.js";

/**
 * Integration test: no external dependencies required.
 *
 * Spins up a mock WS backend (echo server), creates the farm via createApp(),
 * then exercises the full flow: allocate → connect → relay → disconnect → cleanup.
 */
describe("Integration: full session lifecycle", () => {
  let mockWss: WebSocketServer;
  let mockPort: number;
  let instance: AppInstance;

  /** Messages received by the mock upstream */
  let upstreamReceived: string[];

  beforeAll(async () => {
    // 1. Start a mock WS server that echoes messages back
    upstreamReceived = [];
    mockWss = new WebSocketServer({ port: 0 });
    mockPort = (mockWss.address() as AddressInfo).port;

    mockWss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = data.toString();
        upstreamReceived.push(msg);
        ws.send(`echo:${msg}`);
      });
    });

    // 2. Create a backend that points to the mock WS server
    const backend: Backend = {
      id: "mock-echo",
      type: "mock",
      supports: new Set<BrowserType>(["chrome", "firefox", "webkit"]),
      async createSession({ browser }): Promise<BackendSession> {
        return {
          backendId: `mock-${crypto.randomUUID().slice(0, 8)}`,
          wsEndpoint: `ws://127.0.0.1:${mockPort}`,
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

    // 3. Start the farm
    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5, idleTimeout: 300, reaperInterval: 60 }),
      backends: [backend],
    });
  });

  afterAll(async () => {
    await instance.shutdown();
    await new Promise<void>((resolve) => mockWss.close(() => resolve()));
  });

  it("allocates a session, relays WS messages, cleans up on disconnect", async () => {
    // Allocate
    const createRes = await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "chrome", clientId: "integration-test" }),
    });
    expect(createRes.status).toBe(201);
    const { sessionId, token } = await createRes.json();
    expect(sessionId).toMatch(/^bf-/);

    // Connect via WS proxy
    const wsUrl = `ws://127.0.0.1:${instance.port}/session/${sessionId}?token=${token}`;
    const client = new WebSocket(wsUrl);

    // Wait for open
    await new Promise<void>((resolve, reject) => {
      client.on("open", resolve);
      client.on("error", reject);
    });

    // Send a message through the proxy → mock upstream
    const received: string[] = [];
    client.on("message", (data) => received.push(data.toString()));

    client.send("hello from client");

    // Wait for the echo to come back
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) { clearInterval(check); resolve(); }
      }, 10);
    });

    expect(upstreamReceived).toContain("hello from client");
    expect(received).toContain("echo:hello from client");

    // Disconnect
    client.close();

    // Wait for cleanup
    await new Promise((r) => setTimeout(r, 100));

    // Session should be destroyed (proxy triggers destroy on disconnect)
    const getRes = await instance.app.request(`/sessions/${sessionId}`);
    expect(getRes.status).toBe(404);
  });

  it("rejects WS connection with invalid token", async () => {
    const createRes = await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "chrome" }),
    });
    const { sessionId } = await createRes.json();

    const wsUrl = `ws://127.0.0.1:${instance.port}/session/${sessionId}?token=wrong`;
    const client = new WebSocket(wsUrl);

    const error = await new Promise<Error>((resolve) => {
      client.on("error", resolve);
    });

    expect(error).toBeDefined();
  });

  it("rejects WS connection to nonexistent session", async () => {
    const wsUrl = `ws://127.0.0.1:${instance.port}/session/nonexistent?token=fake`;
    const client = new WebSocket(wsUrl);

    const error = await new Promise<Error>((resolve) => {
      client.on("error", resolve);
    });

    expect(error).toBeDefined();
  });

  it("lists sessions and filters by clientId", async () => {
    // Create two sessions with different clients
    await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "chrome", clientId: "client-a" }),
    });
    await instance.app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "firefox", clientId: "client-b" }),
    });

    const allRes = await instance.app.request("/sessions");
    const allBody = await allRes.json();
    expect(allBody.sessions.length).toBeGreaterThanOrEqual(2);

    const filteredRes = await instance.app.request("/sessions?clientId=client-a");
    const filteredBody = await filteredRes.json();
    expect(filteredBody.sessions.every((s: any) => s.clientId === "client-a")).toBe(true);
  });
});
