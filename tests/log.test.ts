import { describe, it, expect, vi } from 'vitest'
import { log } from '../src/log.js'

describe('log', () => {
  it('log.info outputs formatted message', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    log.info('test message', { key: 'value' })
    expect(spy).toHaveBeenCalledOnce()
    const output = spy.mock.calls[0][0]
    expect(output).toContain('[INFO]')
    expect(output).toContain('test message')
    expect(output).toContain('"key":"value"')
    spy.mockRestore()
  })

  it('log.warn outputs formatted message', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    log.warn('warning msg')
    expect(spy).toHaveBeenCalledOnce()
    const output = spy.mock.calls[0][0]
    expect(output).toContain('[WARN]')
    expect(output).toContain('warning msg')
    spy.mockRestore()
  })

  it('log.error outputs formatted message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.error('error msg', { code: 500 })
    expect(spy).toHaveBeenCalledOnce()
    const output = spy.mock.calls[0][0]
    expect(output).toContain('[ERROR]')
    expect(output).toContain('error msg')
    spy.mockRestore()
  })

  it('log.info without data omits JSON', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    log.info('plain message')
    const output = spy.mock.calls[0][0]
    expect(output).toContain('plain message')
    expect(output).not.toContain('{')
    spy.mockRestore()
  })
})
