import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { createApp, type AppInstance } from '../src/server.js'
import { Allocator, AllocatorError } from '../src/allocator.js'
import type { Backend, BackendSession, BrowserType, PoolStatus } from '../src/backends/types.js'

function mockBackend(overrides?: Partial<Backend>): Backend {
  return {
    id: 'mock-full',
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

function webdriverMock(): Backend {
  return {
    id: 'wd-mock',
    type: 'webdriver-mock',
    protocol: 'webdriver' as const,
    supports: new Set<BrowserType>(['safari']),
    async createSession() {
      return {
        backendId: `wd-${crypto.randomUUID().slice(0, 8)}`,
        backendType: 'webdriver-mock',
        webdriverUrl: 'http://localhost:4723',
        webdriverSessionId: 'wd-session-abc',
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

describe('Server: full route coverage', () => {
  let instance: AppInstance

  beforeAll(() => {
    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 3 }),
      backends: [mockBackend(), webdriverMock()],
    })
  })

  afterAll(async () => { await instance.shutdown() })

  // --- POST /sessions ---

  it('POST /sessions returns wsEndpoint with host header', async () => {
    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'farm.example.com' },
      body: JSON.stringify({ browser: 'chrome' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.wsEndpoint).toContain('ws://farm.example.com/session/')
    expect(body.wsEndpoint).toContain('?token=')
  })

  it('POST /sessions returns webdriverUrl for safari', async () => {
    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'safari' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.webdriverUrl).toBe('http://localhost:4723')
    expect(body.webdriverSessionId).toBe('wd-session-abc')
    expect(body.wsEndpoint).toBeUndefined()
  })

  it('POST /sessions passes optional fields through', async () => {
    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId: 'test-client', timeout: 60, headless: true }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sessionId).toMatch(/^bf-/)
  })

  it('POST /sessions rejects missing browser', async () => {
    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('POST /sessions rejects invalid browser', async () => {
    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'netscape' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid browser')
  })

  it('POST /sessions returns 429 when per-client limit reached', async () => {
    const clientId = 'limit-test-client'
    await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId }),
    })
    await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId }),
    })
    await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId }),
    })

    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId }),
    })
    expect(res.status).toBe(429)
  })

  it('POST /sessions with wsRequired skips WebDriver backends', async () => {
    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'safari', wsRequired: true }),
    })
    // No WS backend supports safari, so 503
    expect(res.status).toBe(503)
  })

  it('POST /sessions uses wss when x-forwarded-proto is https', async () => {
    const res = await instance.app.request('/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
        'Host': 'farm.example.com',
      },
      body: JSON.stringify({ browser: 'chrome' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.wsEndpoint).toMatch(/^wss:\/\//)
  })

  // --- GET /sessions ---

  it('GET /sessions returns all sessions', async () => {
    const res = await instance.app.request('/sessions')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions).toBeInstanceOf(Array)
    expect(body.sessions.length).toBeGreaterThan(0)
  })

  it('GET /sessions?clientId filters correctly', async () => {
    const res = await instance.app.request('/sessions?clientId=limit-test-client')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions.every((s: any) => s.clientId === 'limit-test-client')).toBe(true)
  })

  // --- GET /sessions/:id ---

  it('GET /sessions/:id returns formatted session details', async () => {
    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId: 'detail-test' }),
    })
    const { sessionId } = await createRes.json()

    const res = await instance.app.request(`/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBe(sessionId)
    expect(body.browser).toBe('chrome')
    expect(body.clientId).toBe('detail-test')
    expect(body.backendType).toBe('mock')
    expect(body.createdAt).toMatch(/^\d{4}-/)
    expect(body.expiresAt).toMatch(/^\d{4}-/)
    expect(typeof body.idleSeconds).toBe('number')
  })

  it('GET /sessions/:id includes webdriver fields for WebDriver sessions', async () => {
    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'safari', clientId: 'wd-detail-test' }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json()

    const res = await instance.app.request(`/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.webdriverUrl).toBe('http://localhost:4723')
    expect(body.webdriverSessionId).toBe('wd-session-abc')
  })

  // --- GET /sessions/:id/screenshot ---

  it('GET /sessions/:id/screenshot returns 404 for unknown session', async () => {
    const res = await instance.app.request('/sessions/nonexistent/screenshot')
    expect(res.status).toBe(404)
  })

  it('GET /sessions/:id/screenshot returns 502 when CDP connection fails', async () => {
    const createRes = await instance.app.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'chrome', clientId: 'screenshot-test' }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json()

    const res = await instance.app.request(`/sessions/${sessionId}/screenshot`)
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain('CDP connection failed')
  })

  // --- DELETE /sessions/:id ---

  it('DELETE /sessions/:id returns 404 for unknown', async () => {
    const res = await instance.app.request('/sessions/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  // --- GET /backends ---

  it('GET /backends lists all backends', async () => {
    const res = await instance.app.request('/backends')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backends.length).toBeGreaterThanOrEqual(2)
    const ids = body.backends.map((b: any) => b.id)
    expect(ids).toContain('mock-full')
    expect(ids).toContain('wd-mock')
  })

  // --- DELETE /backends/:id ---

  it('DELETE /backends/:id returns 404 for unknown', async () => {
    const res = await instance.app.request('/backends/nonexistent', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('DELETE /backends/:id returns 409 if backend has active sessions', async () => {
    // mock-full has active sessions from earlier tests
    const res = await instance.app.request('/backends/mock-full', { method: 'DELETE' })
    expect(res.status).toBe(409)
  })
})

describe('Server: POST /backends (runtime registration)', () => {
  let instance: AppInstance

  beforeAll(() => {
    instance = createApp({
      port: 0,
      allocator: new Allocator({ maxSessions: 10, maxPerClient: 3 }),
      backends: [mockBackend()],
    })
  })

  afterAll(async () => { await instance.shutdown() })

  it('POST /backends rejects missing type', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:3000' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('type')
  })

  it('POST /backends rejects unsupported type', async () => {
    const res = await instance.app.request('/backends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'netscape-navigator' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Unsupported')
  })
})
