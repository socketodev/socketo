import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifyWebhookSignature, type WebhookEvent } from '@socketo/core'
import { SocketoServer } from '../src/worker.js'

describe('SocketoServer webhooks', () => {
  let originalFetch: typeof globalThis.fetch
  const capturedRequests: Array<{
    url: string
    headers: Headers
    body: string
  }> = []

  beforeEach(() => {
    originalFetch = globalThis.fetch
    capturedRequests.length = 0

    const mockFetch: typeof fetch = async (input, init) => {
      capturedRequests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ''),
      })
      return new Response(null, { status: 200 })
    }
    globalThis.fetch = mockFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('configures default webhook endpoint from webhookUrl', () => {
    const server = new SocketoServer({
      port: 0,
      webhookUrl: 'http://localhost:3000/webhook',
    })

    expect(server.webhookUrl).toBe('http://localhost:3000/webhook')
    expect(server.webhooks.length).toBe(1)
    expect(server.webhooks[0].url).toBe('http://localhost:3000/webhook')
    expect(server.webhooks[0].events).toContain('channel_occupied')
    expect(server.webhooks[0].events).toContain('channel_vacated')
  })

  it('configures custom webhook events when supplied', () => {
    const server = new SocketoServer({
      port: 0,
      webhookUrl: 'http://localhost:3000/webhook',
      webhookEvents: ['channel_occupied'],
    })

    expect(server.webhooks[0].events).toEqual(['channel_occupied'])
  })

  it('dispatches channel_occupied and channel_vacated webhooks on subscriber transitions', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'my-key',
      appSecret: 'my-secret',
      webhookUrl: 'http://localhost:3000/webhook',
    })

    const namespace = server.getNamespace()

    const connection = {
      id: '100.200',
      send: () => {},
      close: () => {},
    }

    namespace.connect(connection)
    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: 'chat-room' },
      }),
    )

    // Allow async webhook dispatch promise to execute
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(capturedRequests.length).toBe(1)
    expect(capturedRequests[0].url).toBe('http://localhost:3000/webhook')
    expect(capturedRequests[0].headers.get('x-pusher-key')).toBe('my-key')

    const signature =
      capturedRequests[0].headers.get('x-pusher-signature') ?? ''
    expect(
      verifyWebhookSignature(
        capturedRequests[0].body,
        'my-key',
        signature,
        'my-key',
        'my-secret',
      ),
    ).toBe(true)

    // SAFETY: JSON.parse parses the serialized WebhookPayload
    const payload = JSON.parse(capturedRequests[0].body) as {
      events: WebhookEvent[]
    }
    expect(payload.events[0]).toEqual({
      name: 'channel_occupied',
      channel: 'chat-room',
    })

    // Now unsubscribe to trigger channel_vacated
    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:unsubscribe',
        data: { channel: 'chat-room' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(capturedRequests.length).toBe(2)
    // SAFETY: JSON.parse parses the serialized WebhookPayload
    const vacatedPayload = JSON.parse(capturedRequests[1].body) as {
      events: WebhookEvent[]
    }
    expect(vacatedPayload.events[0]).toEqual({
      name: 'channel_vacated',
      channel: 'chat-room',
    })
  })

  it('dispatches member_added and member_removed webhooks on presence transitions', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'my-key',
      appSecret: 'my-secret',
      webhookUrl: 'http://localhost:3000/webhook',
    })

    const namespace = server.getNamespace()
    const connection = {
      id: '100.201',
      send: () => {},
      close: () => {},
    }

    namespace.connect(connection)

    const channelData = JSON.stringify({
      user_id: 'alice',
      user_info: { role: 'admin' },
    })
    const authData = `100.201:presence-chat:${channelData}`
    const auth = `my-key:${createHmac('sha256', 'my-secret').update(authData).digest('hex')}`

    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: 'presence-chat',
          auth,
          channel_data: channelData,
        },
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(capturedRequests.length).toBe(2)
    const memberAddedReq = capturedRequests.find((r) => {
      // SAFETY: parsed from JSON test response
      const payload = JSON.parse(r.body) as { events: WebhookEvent[] }
      return payload.events[0]?.name === 'member_added'
    })
    expect(memberAddedReq).toBeDefined()
    // SAFETY: parsed from JSON test response
    const memberPayload = JSON.parse(memberAddedReq?.body ?? '{}') as {
      events: WebhookEvent[]
    }
    expect(memberPayload.events[0]).toEqual({
      name: 'member_added',
      channel: 'presence-chat',
      user_id: 'alice',
    })

    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:unsubscribe',
        data: { channel: 'presence-chat' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const memberRemovedReq = capturedRequests.find((r) => {
      // SAFETY: parsed from JSON test response
      const payload = JSON.parse(r.body) as { events: WebhookEvent[] }
      return payload.events[0]?.name === 'member_removed'
    })
    expect(memberRemovedReq).toBeDefined()
    // SAFETY: parsed from JSON test response
    const removedPayload = JSON.parse(memberRemovedReq?.body ?? '{}') as {
      events: WebhookEvent[]
    }
    expect(removedPayload.events[0]).toEqual({
      name: 'member_removed',
      channel: 'presence-chat',
      user_id: 'alice',
    })
  })

  it('dispatches client_event webhooks when authorized client emits client-* event', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'my-key',
      appSecret: 'my-secret',
      webhookUrl: 'http://localhost:3000/webhook',
    })

    const namespace = server.getNamespace()
    const connection = {
      id: '100.202',
      send: () => {},
      close: () => {},
    }

    namespace.connect(connection)

    const authData = '100.202:private-chat'
    const auth = `my-key:${createHmac('sha256', 'my-secret').update(authData).digest('hex')}`

    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: 'private-chat',
          auth,
        },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    capturedRequests.length = 0

    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'client-message',
        channel: 'private-chat',
        data: { text: 'hello from client' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(capturedRequests.length).toBe(1)
    // SAFETY: parsed from JSON test response
    const clientPayload = JSON.parse(capturedRequests[0].body) as {
      events: WebhookEvent[]
    }
    expect(clientPayload.events[0]).toEqual({
      name: 'client_event',
      channel: 'private-chat',
      event: 'client-message',
      data: JSON.stringify({ text: 'hello from client' }),
      socket_id: '100.202',
      user_id: undefined,
    })
  })
})
