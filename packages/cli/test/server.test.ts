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
