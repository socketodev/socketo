import { describe, expect, mock, test } from 'bun:test'
import {
  dispatchWebhookEvent,
  verifyWebhookSignature,
  type WebhookEndpointConfig,
  type WebhookEvent,
} from '../src'

const appKey = 'test-key'
const appSecret = 'test-secret'

describe('dispatchWebhookEvent', () => {
  test('dispatches POST to matching endpoints with valid headers and signature', async () => {
    const delivered: Array<{
      url: string
      headers: Record<string, string>
      body: string
    }> = []

    const mockFetch: typeof fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        delivered.push({
          url: String(input),
          headers: Object.fromEntries(headers.entries()),
          body: String(init?.body ?? ''),
        })
        return new Response(null, { status: 200 })
      },
    )

    const endpoints: WebhookEndpointConfig[] = [
      {
        id: 'ep-1',
        url: 'https://example.com/webhook1',
        events: ['channel_occupied', 'channel_vacated'],
        isEnabled: true,
      },
      {
        id: 'ep-2',
        url: 'https://example.com/webhook2',
        events: ['client_event'],
        isEnabled: true,
      },
    ]

    const event: WebhookEvent = {
      name: 'channel_occupied',
      channel: 'test-room',
    }

    await dispatchWebhookEvent({
      endpoints,
      appKey,
      appSecret,
      event,
      fetchFn: mockFetch,
    })

    expect(delivered.length).toBe(1)
    expect(delivered[0].url).toBe('https://example.com/webhook1')
    expect(delivered[0].headers['content-type']).toBe('application/json')
    expect(delivered[0].headers['x-pusher-key']).toBe(appKey)

    const signature = delivered[0].headers['x-pusher-signature']
    expect(
      verifyWebhookSignature(
        delivered[0].body,
        appKey,
        signature,
        appKey,
        appSecret,
      ),
    ).toBe(true)

    // SAFETY: JSON.parse returns the serialized WebhookPayload shape.
    const parsedBody = JSON.parse(delivered[0].body) as {
      events: WebhookEvent[]
      time_ms: number
    }
    expect(parsedBody.events).toEqual([event])
    expect(Number.isFinite(parsedBody.time_ms)).toBe(true)
  })

  test('skips disabled endpoints and endpoints with mismatched events', async () => {
    const mockFetch: typeof fetch = mock(
      async () => new Response(null, { status: 200 }),
    )

    const endpoints: WebhookEndpointConfig[] = [
      {
        id: 'disabled',
        url: 'https://example.com/disabled',
        events: ['channel_occupied'],
        isEnabled: false,
      },
      {
        id: 'mismatched',
        url: 'https://example.com/mismatched',
        events: ['member_added'],
        isEnabled: true,
      },
    ]

    await dispatchWebhookEvent({
      endpoints,
      appKey,
      appSecret,
      event: { name: 'channel_occupied', channel: 'general' },
      fetchFn: mockFetch,
    })

    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('handles fetch network errors gracefully and triggers onError callback', async () => {
    const mockFetch: typeof fetch = mock(async () => {
      throw new Error('Connection refused')
    })

    const endpoints: WebhookEndpointConfig[] = [
      {
        id: 'failing',
        url: 'https://fail.example.com',
        events: ['client_event'],
        isEnabled: true,
      },
    ]

    const errors: Array<{ error: Error; url: string }> = []

    await expect(
      dispatchWebhookEvent({
        endpoints,
        appKey,
        appSecret,
        event: {
          name: 'client_event',
          channel: 'private-chat',
          event: 'client-test',
          data: '{}',
          socket_id: '123.456',
        },
        fetchFn: mockFetch,
        onError: (err, ep) => {
          errors.push({ error: err, url: ep.url })
        },
      }),
    ).resolves.toBeUndefined()

    expect(errors.length).toBe(1)
    expect(errors[0].url).toBe('https://fail.example.com')
    expect(String(errors[0].error)).toContain('Connection refused')
  })

  test('reports HTTP non-200 responses via onError callback', async () => {
    const mockFetch: typeof fetch = mock(
      async () =>
        new Response('Internal error', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
    )

    const endpoints: WebhookEndpointConfig[] = [
      {
        id: 'ep-500',
        url: 'https://server.example.com/webhook',
        events: ['channel_occupied'],
        isEnabled: true,
      },
    ]

    const errors: Array<{ error: Error; url: string }> = []

    await dispatchWebhookEvent({
      endpoints,
      appKey,
      appSecret,
      event: { name: 'channel_occupied', channel: 'general' },
      fetchFn: mockFetch,
      onError: (err, ep) => {
        errors.push({ error: err, url: ep.url })
      },
    })

    expect(errors.length).toBe(1)
    expect(String(errors[0].error)).toContain('HTTP 500')
  })
})
