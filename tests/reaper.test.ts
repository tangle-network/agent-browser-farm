import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Allocator, AllocatorError } from '../src/allocator.js'
import type { Backend, BackendSession, BrowserType, PoolStatus } from '../src/backends/types.js'

let destroyedIds: string[] = []

function mockBackend(opts?: { id?: string; healthy?: boolean; healthCheckFn?: () => Promise<boolean> }): Backend {
  const id = opts?.id || 'mock-reaper'
  return {
    id,
    type: 'mock',
    protocol: 'ws' as const,
    supports: new Set<BrowserType>(['chrome', 'firefox', 'webkit']),
    async createSession({ browser }) {
      const backendId = `mock-${crypto.randomUUID().slice(0, 8)}`
      return {
        backendId,
        wsEndpoint: `ws://mock:3000/${browser}`,
        backendType: 'mock',
      }
    },
    async destroySession(backendId) {
      destroyedIds.push(backendId)
    },
    async status(): Promise<PoolStatus> {
      return { capacity: 10, active: 0, backend: 'mock', healthy: opts?.healthy ?? true }
    },
    async healthCheck() {
      if (opts?.healthCheckFn) return opts.healthCheckFn()
      return opts?.healthy ?? true
    },
    async shutdown() {},
  }
}

describe('Allocator: reaper', () => {
  let allocator: Allocator

  beforeEach(() => {
    destroyedIds = []
  })

  afterEach(async () => {
    await allocator.shutdown()
  })

  it('reaps expired sessions', async () => {
    allocator = new Allocator({ maxSessions: 10, maxPerClient: 5, reaperInterval: 60 })
    allocator.addBackend(mockBackend())

    // Create a session with 1s timeout
    const result = await allocator.createSession({ browser: 'chrome', timeout: 1 })
    expect(allocator.getSession(result.sessionId)).toBeDefined()

    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 1100))

    // Manually trigger reap (private method, access via casting)
    await (allocator as any).reap()

    expect(allocator.getSession(result.sessionId)).toBeUndefined()
  })

  it('reaps idle sessions', async () => {
    allocator = new Allocator({
      maxSessions: 10,
      maxPerClient: 5,
      idleTimeout: 1,
      reaperInterval: 60,
      defaultTimeout: 300,
    })
    allocator.addBackend(mockBackend())

    const result = await allocator.createSession({ browser: 'chrome' })

    // Wait for idle timeout
    await new Promise((r) => setTimeout(r, 1100))

    await (allocator as any).reap()

    expect(allocator.getSession(result.sessionId)).toBeUndefined()
  })

  it('does not reap active sessions', async () => {
    allocator = new Allocator({
      maxSessions: 10,
      maxPerClient: 5,
      idleTimeout: 300,
      reaperInterval: 60,
      defaultTimeout: 300,
    })
    allocator.addBackend(mockBackend())

    const result = await allocator.createSession({ browser: 'chrome' })
    allocator.touchSession(result.sessionId)

    await (allocator as any).reap()

    expect(allocator.getSession(result.sessionId)).toBeDefined()
  })

  it('reaper runs on interval when started', async () => {
    allocator = new Allocator({
      maxSessions: 10,
      maxPerClient: 5,
      reaperInterval: 1,
      defaultTimeout: 1,
    })
    allocator.addBackend(mockBackend())

    const result = await allocator.createSession({ browser: 'chrome', timeout: 1 })
    allocator.start()

    // Wait for expiry + at least one reaper cycle
    await new Promise((r) => setTimeout(r, 2200))

    expect(allocator.getSession(result.sessionId)).toBeUndefined()
  })

  it('handles destroy failure during reap gracefully', async () => {
    const failBackend: Backend = {
      id: 'fail-destroy',
      type: 'mock',
      protocol: 'ws' as const,
      supports: new Set<BrowserType>(['chrome']),
      async createSession() {
        return {
          backendId: 'fail-id',
          wsEndpoint: 'ws://mock:3000/chrome',
          backendType: 'mock',
        }
      },
      async destroySession() { throw new Error('destroy failed') },
      async status(): Promise<PoolStatus> {
        return { capacity: 10, active: 0, backend: 'mock', healthy: true }
      },
      async healthCheck() { return true },
      async shutdown() {},
    }

    allocator = new Allocator({ maxSessions: 10, maxPerClient: 5, defaultTimeout: 1 })
    allocator.addBackend(failBackend)

    await allocator.createSession({ browser: 'chrome' })

    await new Promise((r) => setTimeout(r, 1100))

    // Should not throw even though backend.destroySession fails
    await (allocator as any).reap()
  })
})

describe('Allocator: health checks', () => {
  let allocator: Allocator

  afterEach(async () => {
    await allocator.shutdown()
  })

  it('marks backend unhealthy when healthCheck returns false', async () => {
    let healthy = true
    allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })
    allocator.addBackend(mockBackend({
      id: 'flaky',
      healthCheckFn: async () => healthy,
    }))

    // Initially healthy
    let backends = allocator.listBackends()
    expect(backends[0].healthy).toBe(true)

    // Flip to unhealthy
    healthy = false
    await (allocator as any).checkHealth()

    backends = allocator.listBackends()
    expect(backends[0].healthy).toBe(false)

    // Recover
    healthy = true
    await (allocator as any).checkHealth()

    backends = allocator.listBackends()
    expect(backends[0].healthy).toBe(true)
  })

  it('marks backend unhealthy when healthCheck throws', async () => {
    allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })
    allocator.addBackend(mockBackend({
      id: 'crash-health',
      healthCheckFn: async () => { throw new Error('connection refused') },
    }))

    await (allocator as any).checkHealth()

    const backends = allocator.listBackends()
    expect(backends[0].healthy).toBe(false)
  })

  it('health check runs on interval when started', async () => {
    let healthy = true
    allocator = new Allocator({
      maxSessions: 10,
      maxPerClient: 5,
      healthCheckInterval: 1,
      reaperInterval: 60,
    })
    allocator.addBackend(mockBackend({
      id: 'interval-health',
      healthCheckFn: async () => healthy,
    }))

    allocator.start()
    healthy = false

    await new Promise((r) => setTimeout(r, 1500))

    const backends = allocator.listBackends()
    expect(backends[0].healthy).toBe(false)
  })
})

describe('Allocator: wsRequired routing', () => {
  let allocator: Allocator

  afterEach(async () => {
    await allocator.shutdown()
  })

  it('wsRequired=true skips webdriver backends', async () => {
    allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })

    // Only add a WebDriver backend for safari
    const wdBackend: Backend = {
      id: 'wd-only',
      type: 'webdriver',
      protocol: 'webdriver' as const,
      supports: new Set<BrowserType>(['safari']),
      async createSession() {
        return { backendId: 'wd-1', backendType: 'webdriver', webdriverUrl: 'http://localhost:4723', webdriverSessionId: 's1' }
      },
      async destroySession() {},
      async status(): Promise<PoolStatus> { return { capacity: 4, active: 0, backend: 'webdriver', healthy: true } },
      async healthCheck() { return true },
      async shutdown() {},
    }
    allocator.addBackend(wdBackend)

    await expect(
      allocator.createSession({ browser: 'safari', wsRequired: true })
    ).rejects.toThrow(AllocatorError)
  })

  it('wsRequired=false allows webdriver backends', async () => {
    allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })

    const wdBackend: Backend = {
      id: 'wd-ok',
      type: 'webdriver',
      protocol: 'webdriver' as const,
      supports: new Set<BrowserType>(['safari']),
      async createSession() {
        return { backendId: 'wd-2', backendType: 'webdriver', webdriverUrl: 'http://localhost:4723', webdriverSessionId: 's2' }
      },
      async destroySession() {},
      async status(): Promise<PoolStatus> { return { capacity: 4, active: 0, backend: 'webdriver', healthy: true } },
      async healthCheck() { return true },
      async shutdown() {},
    }
    allocator.addBackend(wdBackend)

    const result = await allocator.createSession({ browser: 'safari' })
    expect(result.webdriverUrl).toBe('http://localhost:4723')
    expect(result.webdriverSessionId).toBe('s2')
    expect(result.wsEndpoint).toBeUndefined()
  })

  it('wsRequired=true picks WS backend when both exist', async () => {
    allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })

    const wdBackend: Backend = {
      id: 'wd-safari',
      type: 'webdriver',
      protocol: 'webdriver' as const,
      supports: new Set<BrowserType>(['safari']),
      async createSession() {
        return { backendId: 'wd-3', backendType: 'webdriver', webdriverUrl: 'http://localhost:4723', webdriverSessionId: 's3' }
      },
      async destroySession() {},
      async status(): Promise<PoolStatus> { return { capacity: 4, active: 0, backend: 'webdriver', healthy: true } },
      async healthCheck() { return true },
      async shutdown() {},
    }

    const wsBackend: Backend = {
      id: 'ws-safari',
      type: 'playwright',
      protocol: 'ws' as const,
      supports: new Set<BrowserType>(['safari']),
      async createSession() {
        return { backendId: 'pw-1', backendType: 'playwright', wsEndpoint: 'ws://localhost:5000/safari' }
      },
      async destroySession() {},
      async status(): Promise<PoolStatus> { return { capacity: 10, active: 0, backend: 'playwright', healthy: true } },
      async healthCheck() { return true },
      async shutdown() {},
    }

    allocator.addBackend(wdBackend)
    allocator.addBackend(wsBackend)

    const result = await allocator.createSession({ browser: 'safari', wsRequired: true })
    expect(result.wsEndpoint).toBe('/session/' + result.sessionId)
    expect(result.webdriverUrl).toBeUndefined()
  })
})

describe('Allocator: global limit', () => {
  it('enforces global session limit with 429', async () => {
    const allocator = new Allocator({ maxSessions: 2, maxPerClient: 10 })
    allocator.addBackend(mockBackend())

    await allocator.createSession({ browser: 'chrome', clientId: 'a' })
    await allocator.createSession({ browser: 'chrome', clientId: 'b' })

    try {
      await allocator.createSession({ browser: 'chrome', clientId: 'c' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(AllocatorError)
      expect((err as AllocatorError).status).toBe(429)
      expect((err as AllocatorError).message).toContain('Global')
    }

    await allocator.shutdown()
  })
})

describe('Allocator: backend destroy failure logging', () => {
  it('logs error but still removes session when backend destroy fails', async () => {
    const allocator = new Allocator({ maxSessions: 10, maxPerClient: 5 })
    allocator.addBackend({
      id: 'fail-backend',
      type: 'mock',
      protocol: 'ws' as const,
      supports: new Set<BrowserType>(['chrome']),
      async createSession() {
        return { backendId: 'fb-1', wsEndpoint: 'ws://mock:3000', backendType: 'mock' }
      },
      async destroySession() { throw new Error('backend down') },
      async status(): Promise<PoolStatus> { return { capacity: 10, active: 0, backend: 'mock', healthy: true } },
      async healthCheck() { return true },
      async shutdown() {},
    })

    const result = await allocator.createSession({ browser: 'chrome' })
    // Should not throw
    await allocator.destroySession(result.sessionId)
    // Session should still be removed
    expect(allocator.getSession(result.sessionId)).toBeUndefined()

    await allocator.shutdown()
  })
})
