import { describe, expect, it } from 'bun:test'
import { signRestRequest } from '@socketo/core'
import { SocketoServer } from '../src/worker.js'

describe('SocketoServer logging', () => {
  it('supports custom logger in constructor options', async () => {
    const logs: string[] = []
    const server = new SocketoServer({
      port: 0,
      logger: (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      },
    })

    server.log('test message 1')
    expect(logs).toEqual(['test message 1'])
  })

  it('supports updating logger via setLogger', async () => {
    const logs: string[] = []
    const server = new SocketoServer({ port: 0 })

    server.setLogger((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })

    server.log('custom log message')
    expect(logs).toEqual(['custom log message'])
  })

  it('routes REST trigger events through the logger', async () => {
    const logs: string[] = []
    const server = new SocketoServer({
      port: 0,
      logger: (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      },
    })

    const body = JSON.stringify({
      name: 'my-event',
      channel: 'public-test',
      data: { message: 'hello' },
    })

    const { queryParams } = signRestRequest({
      method: 'POST',
      path: '/apps/local/events',
      body,
      appKey: 'local',
      appSecret: 'local',
    })

    const app = server.createApp()
    const res = await app.request(
      `/apps/local/events?${queryParams.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    )

    expect(res.status).toBe(200)
    expect(
      logs.some(
        (l) =>
          l.includes('trigger') &&
          l.includes('my-event') &&
          l.includes('public-test'),
      ),
    ).toBe(true)
  })

  it('routes batch events through the logger', async () => {
    const logs: string[] = []
    const server = new SocketoServer({
      port: 0,
      logger: (...args: unknown[]) => {
        logs.push(args.map(String).join(' '))
      },
    })

    const body = JSON.stringify({
      batch: [
        { name: 'batch-event-1', channel: 'chan-1', data: { a: 1 } },
        { name: 'batch-event-2', channel: 'chan-2', data: { b: 2 } },
      ],
    })

    const { queryParams } = signRestRequest({
      method: 'POST',
      path: '/apps/local/batch_events',
      body,
      appKey: 'local',
      appSecret: 'local',
    })

    const app = server.createApp()
    const res = await app.request(
      `/apps/local/batch_events?${queryParams.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    )

    expect(res.status).toBe(200)
    expect(
      logs.some(
        (l) =>
          l.includes('batch') &&
          l.includes('batch-event-1') &&
          l.includes('chan-1'),
      ),
    ).toBe(true)
    expect(
      logs.some(
        (l) =>
          l.includes('batch') &&
          l.includes('batch-event-2') &&
          l.includes('chan-2'),
      ),
    ).toBe(true)
  })
})

describe('SocketoServer REST Endpoints', () => {
  it('supports separate appId and appKey in REST path and auth query', async () => {
    const server = new SocketoServer({
      port: 0,
      appId: 'my-app-id-123',
      appKey: 'my-app-key-456',
      appSecret: 'my-secret-789',
    })

    const body = JSON.stringify({
      name: 'hello-event',
      channel: 'test-chan',
      data: { msg: 'hi' },
    })

    const { queryParams } = signRestRequest({
      method: 'POST',
      path: '/apps/my-app-id-123/events',
      body,
      appKey: 'my-app-key-456',
      appSecret: 'my-secret-789',
    })

    const app = server.createApp()
    const res = await app.request(
      `/apps/my-app-id-123/events?${queryParams.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    )

    expect(res.status).toBe(200)
  })

  it('rejects requests with invalid signature or unknown app', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'valid-key',
      appSecret: 'valid-secret',
    })

    const app = server.createApp()

    // Wrong app
    const resWrongApp = await app.request('/apps/wrong-key/sockets')
    expect(resWrongApp.status).toBe(403)

    // Unsigned
    const resUnsigned = await app.request('/apps/valid-key/sockets')
    expect(resUnsigned.status).toBe(401)
  })

  it('handles GET /apps/:id/sockets', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const { queryParams } = signRestRequest({
      method: 'GET',
      path: '/apps/test-key/sockets',
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const app = server.createApp()
    const res = await app.request(
      `/apps/test-key/sockets?${queryParams.toString()}`,
    )

    expect(res.status).toBe(200)
    // SAFETY: Sockets endpoint response structure.
    const json = (await res.json()) as { sockets: number }
    expect(json.sockets).toBe(0)
  })

  it('handles GET /apps/:id/channels and GET /apps/:id/channels/:name', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const { queryParams: qpList } = signRestRequest({
      method: 'GET',
      path: '/apps/test-key/channels',
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const app = server.createApp()
    const resList = await app.request(
      `/apps/test-key/channels?${qpList.toString()}`,
    )
    expect(resList.status).toBe(200)
    // SAFETY: Channels query response structure.
    const jsonList = (await resList.json()) as {
      channels: Record<string, { subscription_count?: number }>
    }
    expect(jsonList.channels).toBeDefined()

    const { queryParams: qpDetail } = signRestRequest({
      method: 'GET',
      path: '/apps/test-key/channels/my-channel',
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const resDetail = await app.request(
      `/apps/test-key/channels/my-channel?${qpDetail.toString()}`,
    )
    expect(resDetail.status).toBe(200)
    // SAFETY: Channel detail response structure.
    const jsonDetail = (await resDetail.json()) as { occupied: boolean }
    expect(jsonDetail.occupied).toBe(false)
  })

  it('handles presence channel users endpoint validation', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    // Non-presence channel -> 400
    const { queryParams: qpNonPres } = signRestRequest({
      method: 'GET',
      path: '/apps/test-key/channels/public-chat/users',
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const app = server.createApp()
    const resNonPres = await app.request(
      `/apps/test-key/channels/public-chat/users?${qpNonPres.toString()}`,
    )
    expect(resNonPres.status).toBe(400)

    // Presence channel -> 200
    const { queryParams: qpPres } = signRestRequest({
      method: 'GET',
      path: '/apps/test-key/channels/presence-chat/users',
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const resPres = await app.request(
      `/apps/test-key/channels/presence-chat/users?${qpPres.toString()}`,
    )
    expect(resPres.status).toBe(200)
    // SAFETY: Presence users response structure.
    const jsonPres = (await resPres.json()) as { users: Array<{ id: string }> }
    expect(jsonPres.users).toEqual([])
  })

  it('handles POST /apps/:id/users/:user_id/terminate_connections', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const { queryParams } = signRestRequest({
      method: 'POST',
      path: '/apps/test-key/users/alice/terminate_connections',
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const app = server.createApp()
    const res = await app.request(
      `/apps/test-key/users/alice/terminate_connections?${queryParams.toString()}`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
  })

  it('handles POST /apps/:id/auth helper endpoint', async () => {
    const server = new SocketoServer({
      port: 0,
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const body = JSON.stringify({
      socket_id: '123.456',
      channel_name: 'private-messages',
    })

    const { queryParams } = signRestRequest({
      method: 'POST',
      path: '/apps/test-key/auth',
      body,
      appKey: 'test-key',
      appSecret: 'test-secret',
    })

    const app = server.createApp()
    const res = await app.request(
      `/apps/test-key/auth?${queryParams.toString()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
    )

    expect(res.status).toBe(200)
    // SAFETY: Auth helper response structure.
    const json = (await res.json()) as { auth: string }
    expect(json.auth).toStartWith('test-key:')
  })

  it('exposes status getters for monitoring', () => {
    const server = new SocketoServer({ port: 0 })
    expect(server.getStartTime()).toBeGreaterThan(0)
    expect(server.getSocketCount()).toBe(0)
    expect(server.getChannelsCount()).toBe(0)
    expect(server.getUsersCount()).toBe(0)
  })
})
