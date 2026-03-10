import { WebSocket } from "ws"
import type { Session } from "./allocator.js"
import { log } from "./log.js"

interface CdpResponse {
  id: number
  result?: { data: string }
  error?: { code: number; message: string }
}

/**
 * Capture a PNG screenshot from any active session.
 *
 * WS sessions: opens a temporary CDP connection, sends Page.captureScreenshot,
 * decodes the base64 result, closes the connection.
 *
 * WebDriver sessions: calls GET {webdriverUrl}/session/{id}/screenshot,
 * decodes the base64 value field.
 */
export async function captureScreenshot(session: Session): Promise<Buffer> {
  if (session.wsEndpoint) {
    return captureViaCdp(session.wsEndpoint, session.id)
  }

  if (session.webdriverUrl && session.webdriverSessionId) {
    return captureViaWebDriver(session.webdriverUrl, session.webdriverSessionId, session.id)
  }

  throw new ScreenshotError("Session has no wsEndpoint or webdriverUrl", 500)
}

async function captureViaCdp(wsEndpoint: string, sessionId: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket(wsEndpoint)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new ScreenshotError("CDP screenshot timed out", 504))
    }, 10_000)

    ws.on("error", (err) => {
      clearTimeout(timeout)
      log.error("screenshot: CDP connection error", { sessionId, error: String(err) })
      reject(new ScreenshotError(`CDP connection failed: ${err.message}`, 502))
    })

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }))
    })

    ws.on("message", (data) => {
      clearTimeout(timeout)
      try {
        const msg: CdpResponse = JSON.parse(String(data))
        if (msg.id !== 1) return

        if (msg.error) {
          ws.close()
          reject(new ScreenshotError(`CDP error: ${msg.error.message}`, 502))
          return
        }

        if (!msg.result?.data) {
          ws.close()
          reject(new ScreenshotError("CDP returned empty screenshot", 502))
          return
        }

        const png = Buffer.from(msg.result.data, "base64")
        ws.close()
        resolve(png)
      } catch (err) {
        ws.close()
        reject(new ScreenshotError(`Failed to parse CDP response: ${err}`, 502))
      }
    })
  })
}

async function captureViaWebDriver(
  webdriverUrl: string,
  webdriverSessionId: string,
  sessionId: string,
): Promise<Buffer> {
  const url = `${webdriverUrl}/session/${webdriverSessionId}/screenshot`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    log.error("screenshot: WebDriver request failed", { sessionId, status: res.status, body })
    throw new ScreenshotError(`WebDriver screenshot failed: ${res.status}`, 502)
  }

  const json = (await res.json()) as { value: string }
  if (!json.value) {
    throw new ScreenshotError("WebDriver returned empty screenshot", 502)
  }

  return Buffer.from(json.value, "base64")
}

export class ScreenshotError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = "ScreenshotError"
  }
}
