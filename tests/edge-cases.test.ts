import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createApp, type AppInstance } from '../src/server.js'
import { Allocator } from '../src/allocator.js'
import { BrowserFarmClient, BrowserFarmError } from '../src/client.js'
import type { Backend, BrowserType, PoolStatus } from '../src/backends/types.js'

function mockBackend(overrides?: Partial<Backend>): Backend {
  return {
    id: overrides?.id || 'edge-mock',
    type: 'mock',
    protocol: 'ws' as const,
    supports: new Set<BrowserType>(['chrome', 'firefox', 'webkit']),
    async createSession({ browser }) {
      return {
        backendId: `mock-${crypto.randomUUID().slice(0, 8)}`,
        wsEndpoint: `ws://mock:3000/${browser}`,
        backendType: 'mock',
      }
    },
    async destroySession() {},
    async status(): Promise<PoolStatus> {
      return { capacity: 10, active: 0, backend: 'mock', healthy: true }
    },
    async healthCheck() { return true },
    async shutdown() {},
    ...overrides,
  }
}

// --- Allocator: unhealthy fallback ---

describe('Allocator: unhealthy backend fallback', () => {
  it('falls back to unhealthy backend when no healthy ones available', async () => {
    const allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })
    const backend = mockBackend({
      id: 'unhealthy-1',
      healthCheck: async () => false,
    })
    allocator.addBackend(backend)

    // Mark as unhealthy
    await (allocator as any).checkHealth()

    const backends = allocator.listBackends()
    expect(backends[0].healthy).toBe(false)

    // Should still allocate (fallback path)
    const result = await allocator.createSession({ browser: 'chrome' })
    expect(result.sessionId).toMatch(/^bf-/)

    await allocator.shutdown()
  })
})

// --- Allocator: shutdown with destroy error ---

describe('Allocator: shutdown error handling', () => {
  it('continues shutdown even if backend destroy throws', async () => {
    const allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })
    allocator.addBackend({
      id: 'shutdown-fail',
      type: 'mock',
      protocol: 'ws' as const,
      supports: new Set<BrowserType>(['chrome']),
      async createSession() {
        return { backendId: 'sf-1', wsEndpoint: 'ws://mock:3000', backendType: 'mock' }
      },
      async destroySession() { throw new Error('destroy exploded') },
      async status(): Promise<PoolStatus> { return { capacity: 10, active: 0, backend: 'mock', healthy: true } },
      async healthCheck() { return true },
      async shutdown() {},
    })

    await allocator.createSession({ browser: 'chrome' })

    // Should not throw
    await allocator.shutdown()
  })
})

// --- Client: DELETE error path ---

describe('BrowserFarmClient: error paths', () => {
  let instance: AppInstance
  let client: BrowserFarmClient

  beforeAll(() => {
    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5 }),
      backends: [mockBackend()],
    })
    client = new BrowserFarmClient(`http://localhost:${instance.port}`)
  })

  afterAll(async () => { await instance.shutdown() })

  it('destroySession throws BrowserFarmError on 404', async () => {
    await expect(client.destroySession('nonexistent')).rejects.toThrow(BrowserFarmError)
  })

  it('getSession throws BrowserFarmError on 404', async () => {
    try {
      await client.getSession('nonexistent')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserFarmError)
      expect((err as BrowserFarmError).status).toBe(404)
    }
  })
})

// --- Proxy: shutdown with active connections ---

describe('Proxy: shutdown with active WS connections', () => {
  let mockWss: WebSocketServer
  let mockPort: number
  let instance: AppInstance

  beforeAll(async () => {
    mockWss = new WebSocketServer({ port: 0 })
    mockPort = (mockWss.address() as AddressInfo).port
    mockWss.on('connection', (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data.toString()}`))
    })

    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5, reaperInterval: 60 }),
      backends: [{
        id: 'proxy-shutdown-mock',
        type: 'mock',
        protocol: 'ws' as const,
        supports: new Set<BrowserType>(['chrome']),
        async createSession() {
          return {
            backendId: `ps-${crypto.randomUUID().slice(0, 8)}`,
            wsEndpoint: `ws://127.0.0.1:${mockPort}`,
            backendType: 'mock',
          }
        },
        async destroySession() {},
        async status(): Promise<PoolStatus> { return { capacity: 10, active: 0, backend: 'mock', healthy: true } },
        async healthCheck() { return true },
        async shutdown() {},
      }],
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => mockWss.close(() => resolve()))
  })

  it('closes active WS connections on shutdown', async () => {
    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome' }),
    })
    const { sessionId, token } = await createRes.json()

    const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/session/${sessionId}?token=${token}`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })

    // Wait for upstream
    await new Promise((r) => setTimeout(r, 50))

    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code))
    })

    // Shutdown while connection is active — exercises proxy shutdown path
    await instance.shutdown()

    const code = await closed
    expect(code).toBe(1001) // server shutting down
  })
})

// --- Proxy: buffer overflow ---

describe('Proxy: buffer overflow', () => {
  it('closes client with 4008 when buffer exceeds 128 messages', { timeout: 10000 }, async () => {
    // Create a TCP server that accepts connections but never completes WS handshake
    const net = await import('node:net')
    const tcpServer = net.createServer((socket) => {
      // Accept TCP but don't respond — WS upgrade never completes
      // upstream stays in CONNECTING state, pending buffer stays active
    })
    await new Promise<void>((resolve) => tcpServer.listen(0, resolve))
    const tcpPort = (tcpServer.address() as AddressInfo).port

    const inst = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5, reaperInterval: 60 }),
      backends: [{
        id: 'stall-upstream',
        type: 'mock',
        protocol: 'ws' as const,
        supports: new Set<BrowserType>(['chrome']),
        async createSession() {
          return {
            backendId: 'stall-1',
            wsEndpoint: `ws://127.0.0.1:${tcpPort}`,
            backendType: 'mock',
          }
        },
        async destroySession() {},
        async status(): Promise<PoolStatus> { return { capacity: 10, active: 0, backend: 'mock', healthy: true } },
        async healthCheck() { return true },
        async shutdown() {},
      }],
    })

    const createRes = await inst.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome' }),
    })
    const { sessionId, token } = await createRes.json()

    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/session/${sessionId}?token=${token}`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })

    const closeCode = new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code))
    })

    // Flood 129 messages — exceeds MAX_PENDING (128)
    for (let i = 0; i < 129; i++) {
      ws.send(`msg-${i}`)
    }

    const code = await closeCode
    expect(code).toBe(4008)

    await inst.shutdown()
    tcpServer.close()
  })
})

// --- Server: POST /backends creates backends ---

describe('Server: POST /backends registration', () => {
  let instance: AppInstance

  beforeAll(() => {
    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5 }),
      backends: [mockBackend()],
    })
  })

  afterAll(async () => { await instance.shutdown() })

  it('POST /backends registers browserless backend', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'browserless', url: 'http://localhost:3001', id: 'bl-test' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe('browserless')
    expect(body.supports).toContain('chrome')
  })

  it('POST /backends registers safari-desktop backend', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'safari-desktop', id: 'sd-test', capacity: 2 }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe('safari-desktop')
    expect(body.supports).toContain('safari')
  })

  it('POST /backends registers android backend', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'android', id: 'and-test', avdName: 'test-avd', capacity: 2 }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe('android')
    expect(body.supports).toContain('android-chrome')
  })

  it('POST /backends registers android-device backend', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'android-device', id: 'ad-test', devices: ['SERIAL1'] }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe('android-device')
  })

  it('POST /backends registers ios-safari backend', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ios-safari', id: 'ios-test', url: 'http://localhost:4723', templateUdid: 'tpl-1', capacity: 4 }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe('ios-safari')
  })

  it('POST /backends registers ios-device backend', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ios-device',
        id: 'iosd-test',
        url: 'http://localhost:4723',
        devices: [{ udid: 'DEV1', name: 'iPhone' }],
        xcodeOrgId: 'TEAM1',
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe('ios-device')
  })

  it('POST /backends registers playwright backend', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'playwright', id: 'pw-test' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe('playwright')
  })

  it('DELETE /backends/:id removes backend with no sessions', async () => {
    const res = await instance.app.request('/backends/bl-test', { method: 'DELETE' })
    expect(res.status).toBe(204)
  })
})

// --- Server: createSession internal error ---

describe('Server: POST /backends internal error', () => {
  it('returns 500 on malformed JSON', async () => {
    const inst = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5 }),
      backends: [mockBackend({ id: 'be-err-test' })],
    })

    const res = await inst.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json}',
    })
    expect(res.status).toBe(500)

    await inst.shutdown()
  })
})

describe('Server: internal errors', () => {
  it('POST /sessions returns 500 on unexpected error', async () => {
    const throwBackend: Backend = {
      id: 'throw-backend',
      type: 'mock',
      protocol: 'ws' as const,
      supports: new Set<BrowserType>(['ios-safari']),
      async createSession() { throw new Error('unexpected explosion') },
      async destroySession() {},
      async status(): Promise<PoolStatus> { return { capacity: 10, active: 0, backend: 'mock', healthy: true } },
      async healthCheck() { return true },
      async shutdown() {},
    }

    const instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5 }),
      backends: [throwBackend],
    })

    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'ios-safari' }),
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Internal server error')

    await instance.shutdown()
  })
})
