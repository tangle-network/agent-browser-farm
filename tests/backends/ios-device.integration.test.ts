import { IosDeviceBackend } from '../../src/backends/ios-device.js'
import { backendContractSuite } from './contract.js'

backendContractSuite({
  name: 'IosDeviceBackend (physical)',
  browser: 'ios-safari',
  create: async () => new IosDeviceBackend({
    id: 'iosd-contract',
    devices: [{ udid: process.env.IOS_DEVICE_UDID ?? 'unknown', name: 'Test iPhone' }],
  }),
  available: async () => {
    if (process.platform !== 'darwin') return false
    if (!process.env.IOS_DEVICE_UDID) return false
    try {
      const { execSync } = await import('node:child_process')
      execSync('which appium', { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  },
})
