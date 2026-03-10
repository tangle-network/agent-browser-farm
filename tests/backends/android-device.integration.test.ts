import { AndroidDeviceBackend } from '../../src/backends/android-device.js'
import { backendContractSuite } from './contract.js'

backendContractSuite({
  name: 'AndroidDeviceBackend (physical)',
  browser: 'android-chrome',
  create: async () => new AndroidDeviceBackend({ id: 'ad-contract' }),
  available: async () => {
    try {
      const { execSync } = await import('node:child_process')
      const output = execSync('adb devices', { encoding: 'utf8' })
      const lines = output.trim().split('\n').slice(1).filter(l => l.includes('device'))
      return lines.length > 0
    } catch {
      return false
    }
  },
})
