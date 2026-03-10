import { describe, it, expect } from 'vitest'
import { config } from '../src/config.js'

describe('config', () => {
  it('has sensible defaults', () => {
    expect(config.port).toBe(9222)
    expect(config.browserlessUrl).toBe('http://localhost:3000')
    expect(config.browserlessToken).toBe('')
    expect(config.apiToken).toBe('')
    expect(config.defaultTimeout).toBe(300)
    expect(config.maxPerClient).toBe(5)
    expect(config.maxSessions).toBe(20)
    expect(config.idleTimeout).toBe(300)
    expect(config.reaperInterval).toBe(30)
    expect(config.healthCheckInterval).toBe(30)
    expect(config.logLevel).toBe('info')
  })

  it('validate() warns about no API_TOKEN', () => {
    const warnings = config.validate()
    expect(warnings).toContain('API_TOKEN not set — API is unauthenticated')
  })

  it('validate() returns array', () => {
    const warnings = config.validate()
    expect(Array.isArray(warnings)).toBe(true)
  })
})
