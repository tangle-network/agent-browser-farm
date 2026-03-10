import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { createApp, type AppInstance } from '../src/server.js'
import { Allocator } from '../src/allocator.js'
import type { Backend, BackendSession, BrowserType, PoolStatus } from '../src/backends/types.js'

function echoBackend(port: number): Backend {
  return {
    id: 'echo-proxy-test',
    type: 'mock',
    protocol: 'ws' as const,
    supports: new Set<BrowserType>(['chrome', 'firefox', 'webkit']),
    async createSession({ browser }) {
      return {
        backendId: `mock-${crypto.randomUUID().slice(0, 8)}`,
        wsEndpoint: `ws://127.0.0.1:${port}`,
        backendType: 'mock',
      }
    },
    async destroySession() {},
    async status(): Promise<PoolStatus> {
      return { capacity: 10, active: 0, backend: 'mock', healthy: true }
    },
    async healthCheck() { return true },
    async shutdown() {},
  }
}

function webdriverBackend(): Backend {
  return {
    id: 'webdriver-proxy-test',
    type: 'webdriver-mock',
    protocol: 'webdriver' as const,
    supports: new Set<BrowserType>(['safari']),
    async createSession() {
      return {
        backendId: `wd-${crypto.randomUUID().slice(0, 8)}`,
        backendType: 'webdriver-mock',
        webdriverUrl: 'http://localhost:4723',
        webdriverSessionId: 'wd-session-1',
      }
    },
    async destroySession() {},
    async status(): Promise<PoolStatus> {
      return { capacity: 4, active: 0, backend: 'webdriver-mock', healthy: true }
    },
    async healthCheck() { return true },
    async shutdown() {},
  }
}

describe('SessionProxy', () => {
  let mockWss: WebSocketServer
  let mockPort: number
  let instance: AppInstance

  beforeAll(async () => {
    mockWss = new WebSocketServer({ port: 0 })
    mockPort = (mockWss.address() as AddressInfo).port

    mockWss.on('connection', (ws) => {
      ws.on('message', (data) => {
        ws.send(`echo:${data.toString()}`)
      })
    })

    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 5, idleTimeout: 300, reaperInterval: 60 }),
      backends: [echoBackend(mockPort), webdriverBackend()],
    })
  })

  afterAll(async () => {
    await instance.shutdown()
    await new Promise<void>((resolve) => mockWss.close(() => resolve()))
  })

  it('rejects upgrade to non-session path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/not-a-session`)
    const error = await new Promise<Error>((resolve) => {
      ws.on('error', resolve)
    })
    expect(error).toBeDefined()
  })

  it('rejects upgrade with no token', async () => {
    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome' }),
    })
    const { sessionId } = await createRes.json()

    const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/session/${sessionId}`)
    const error = await new Promise<Error>((resolve) => {
      ws.on('error', resolve)
    })
    expect(error).toBeDefined()
  })

  it('rejects WS connection to WebDriver-based session with 4005', async () => {
    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'safari' }),
    })
    const { sessionId, token } = await createRes.json()

    const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/session/${sessionId}?token=${token}`)

    const code = await new Promise<number>((resolve) => {
      ws.on('close', (code) => resolve(code))
    })
    expect(code).toBe(4005)
  })

  it('buffers messages until upstream connects', async () => {
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

    // Send immediately — may buffer if upstream not ready yet
    ws.send('buffered-msg')

    const received: string[] = []
    ws.on('message', (data) => received.push(data.toString()))

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) { clearInterval(check); resolve() }
      }, 10)
    })

    expect(received).toContain('echo:buffered-msg')
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('relays binary messages', async () => {
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

    // Wait for upstream connection
    await new Promise((r) => setTimeout(r, 50))

    const received: Buffer[] = []
    ws.on('message', (data) => received.push(data as Buffer))

    const binary = Buffer.from([0x01, 0x02, 0x03])
    ws.send(binary)

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (received.length > 0) { clearInterval(check); resolve() }
      }, 10)
    })

    expect(received.length).toBe(1)
    ws.close()
    await new Promise((r) => setTimeout(r, 50))
  })

  it('cleans up session when client disconnects', async () => {
    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId: 'cleanup-test' }),
    })
    const { sessionId, token } = await createRes.json()

    const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/session/${sessionId}?token=${token}`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
    })

    ws.close()
    await new Promise((r) => setTimeout(r, 100))

    const getRes = await instance.app.request(`/sessions/${sessionId}`)
    expect(getRes.status).toBe(404)
  })

  it('handles upstream close by closing client', { timeout: 10000 }, async () => {
    // Create a separate upstream that we can control
    const controlWss = new WebSocketServer({ port: 0 })
    const controlPort = (controlWss.address() as AddressInfo).port
    let upstreamWs: WebSocket | null = null

    controlWss.on('connection', (ws) => {
      upstreamWs = ws
    })

    const controlBackend: Backend = {
      id: 'control-upstream',
      type: 'mock',
      protocol: 'ws' as const,
      supports: new Set<BrowserType>(['android-chrome']),
      async createSession() {
        return {
          backendId: `ctrl-${crypto.randomUUID().slice(0, 8)}`,
          wsEndpoint: `ws://127.0.0.1:${controlPort}`,
          backendType: 'mock',
        }
      },
      async destroySession() {},
      async status(): Promise<PoolStatus> {
        return { capacity: 5, active: 0, backend: 'mock', healthy: true }
      },
      async healthCheck() { return true },
      async shutdown() {},
    }

    instance.allocator.addBackend(controlBackend)

    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'android-chrome', clientId: 'upstream-close-test' }),
    })
    const { sessionId, token } = await createRes.json()

    const client = new WebSocket(`ws://127.0.0.1:${instance.port}/session/${sessionId}?token=${token}`)
    await new Promise<void>((resolve, reject) => {
      client.on('open', resolve)
      client.on('error', reject)
    })

    // Wait for upstream to connect
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (upstreamWs) { clearInterval(check); resolve() }
      }, 10)
    })

    // Close upstream — should trigger client close
    const clientClosed = new Promise<number>((resolve) => {
      client.on('close', (code) => resolve(code))
    })

    upstreamWs!.close()
    const code = await clientClosed
    expect(code).toBeDefined()

    await new Promise((r) => setTimeout(r, 100))
    try { instance.allocator.removeBackend('control-upstream') } catch {}
    await new Promise<void>((resolve) => controlWss.close(() => resolve()))
  })
})
