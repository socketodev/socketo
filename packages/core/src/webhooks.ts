import { createWebhookSignature } from './auth'
import type { DispatchWebhookOptions, WebhookPayload } from './types'

export async function dispatchWebhookEvent(
  options: DispatchWebhookOptions,
): Promise<void> {
  const {
    endpoints,
    appKey,
    appSecret,
    event,
    fetchFn = globalThis.fetch,
    timeoutMs = 5000,
    onError,
  } = options

  const matchingEndpoints = endpoints.filter(
    (ep) => ep.isEnabled !== false && ep.events.includes(event.name),
  )

  if (matchingEndpoints.length === 0) return

  const payload: WebhookPayload = {
    time_ms: Date.now(),
    events: [event],
  }
  const rawBody = JSON.stringify(payload)
  const signature = createWebhookSignature(rawBody, appSecret)

  await Promise.all(
    matchingEndpoints.map(async (ep) => {
      try {
        const response = await fetchFn(ep.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Pusher-Key': appKey,
            'X-Pusher-Signature': signature,
          },
          body: rawBody,
          signal: AbortSignal.timeout(timeoutMs),
        })

        if (!response.ok) {
          const statusText = response.statusText
            ? ` ${response.statusText}`
            : ''
          const httpError = new Error(
            `Webhook delivery to ${ep.url} failed with HTTP ${response.status}${statusText}`,
          )
          onError?.(httpError, ep)
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        onError?.(error, ep)
      }
    }),
  )
}
