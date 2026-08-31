import { describe, expect, test } from 'bun:test'
import {
  type JsonObject,
  type RealtimeConnection,
  RealtimeNamespace,
} from '../src'

const policy = {
  key: 'app-key',
  secret: 'app-secret',
  enableClientEvents: true,
}

class TestConnection implements RealtimeConnection {
  public readonly messages: JsonObject[] = []
  public closed = false

  constructor(public readonly id: string) {}

  send(message: string) {
    this.messages.push(JSON.parse(message))
  }

  close() {
    this.closed = true
  }

  takeLast(event: string) {
    return [...this.messages]
      .reverse()
      .find((message) => message.event === event)
  }
}

async function auth(
  socketId: string,
  value: string,
  includeValue = false,
  channel = 'presence-room',
) {
  const signedData = includeValue
    ? `${socketId}:${channel}:${value}`
    : `${socketId}:${value}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(policy.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedData),
  )
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `${policy.key}:${hex}`
}

describe('RealtimeNamespace', () => {
  test('subscribes and broadcasts private client events', async () => {
    const namespace = new RealtimeNamespace(policy)
    const first = new TestConnection('socket-1')
    const second = new TestConnection('socket-2')
    namespace.connect(first)
    namespace.connect(second)

    await namespace.receive(
      first.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: 'private-room',
          auth: await auth(first.id, 'private-room'),
        },
      }),
    )
    await namespace.receive(
      second.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: 'private-room',
          auth: await auth(second.id, 'private-room'),
        },
      }),
    )

    await namespace.receive(
      first.id,
      JSON.stringify({
        event: 'client-message',
        channel: 'private-room',
        data: { text: 'hello' },
      }),
    )

    expect(first.takeLast('client-message')).toBeUndefined()
    expect(second.takeLast('client-message')).toEqual({
      event: 'client-message',
      channel: 'private-room',
      data: '{"text":"hello"}',
    })
    expect(namespace.getChannel('private-room')).toEqual({
      occupied: true,
      user_count: 0,
      subscription_count: 2,
    })
  })

  test('tracks unique presence users and emits member lifecycle events', async () => {
    const namespace = new RealtimeNamespace(policy)
    const first = new TestConnection('socket-1')
    const second = new TestConnection('socket-2')
    namespace.connect(first)
    namespace.connect(second)
    const userData = JSON.stringify({
      id: 'user-1',
      user_info: { name: 'Ada' },
    })
    const channelData = JSON.stringify({
      user_id: 'user-1',
      user_info: { name: 'Ada' },
    })

    for (const connection of [first, second]) {
      await namespace.receive(
        connection.id,
        JSON.stringify({
          event: 'pusher:signin',
          data: {
            auth: await signinAuth(connection.id, userData),
            user_data: userData,
          },
        }),
      )
      await namespace.receive(
        connection.id,
        JSON.stringify({
          event: 'pusher:subscribe',
          data: {
            channel: 'presence-room',
            auth: await auth(connection.id, channelData, true),
            channel_data: channelData,
          },
        }),
      )
    }

    expect(namespace.getChannel('presence-room')).toEqual({
      occupied: true,
      user_count: 1,
      subscription_count: 2,
    })
    expect(namespace.getChannelUsers('presence-room')).toEqual([
      { id: 'user-1' },
    ])
    expect(second.takeLast('pusher_internal:member_added')).toBeUndefined()

    await namespace.disconnect(first.id)
    expect(second.takeLast('pusher_internal:member_removed')).toBeUndefined()

    await namespace.disconnect(second.id)
    expect(namespace.getChannel('presence-room')).toBeNull()
  })

  test('restores attachment state and terminates user connections', async () => {
    const namespace = new RealtimeNamespace(policy)
    const connection = new TestConnection('socket-1')
    namespace.restore(connection, {
      id: connection.id,
      channels: ['private-room'],
      userId: 'user-1',
      userInfo: { name: 'Ada' },
    })

    expect(namespace.getSession(connection.id)).toEqual({
      id: connection.id,
      channels: ['private-room'],
      userId: 'user-1',
      userInfo: { name: 'Ada' },
    })
    expect(namespace.getChannel('private-room')?.subscription_count).toBe(1)

    await namespace.terminateUserConnections('user-1')
    expect(connection.closed).toBe(true)
    expect(namespace.getSocketCount()).toBe(0)
  })

  test('rejects unsupported channel types and allows signed-in presence data', async () => {
    const namespace = new RealtimeNamespace(policy)
    const connection = new TestConnection('socket-1')
    namespace.connect(connection)

    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: 'private-encrypted-room' },
      }),
    )
    expect(connection.takeLast('pusher:error')).toEqual({
      event: 'pusher:error',
      channel: 'private-encrypted-room',
      data: '{"code":4300,"message":"Unsupported channel type"}',
    })

    const userData = JSON.stringify({
      id: 'user-1',
      user_info: { name: 'Ada' },
    })
    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:signin',
        data: {
          auth: await signinAuth(connection.id, userData),
          user_data: userData,
        },
      }),
    )
    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: 'presence-room',
          auth: await auth(connection.id, 'presence-room'),
        },
      }),
    )

    expect(
      connection.takeLast('pusher_internal:subscription_succeeded'),
    ).toBeDefined()
    expect(namespace.getChannelUsers('presence-room')).toEqual([
      { id: 'user-1' },
    ])
  })

  test('supports presence authorization without pusher:signin', async () => {
    const namespace = new RealtimeNamespace(policy)
    const connection = new TestConnection('socket-legacy')
    namespace.connect(connection)
    const channelData = JSON.stringify({
      user_id: 'legacy-user',
      user_info: { name: 'Grace' },
    })

    await namespace.receive(
      connection.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: 'presence-room',
          auth: await auth(connection.id, channelData, true),
          channel_data: channelData,
        },
      }),
    )

    expect(namespace.getChannelUsers('presence-room')).toEqual([
      { id: 'legacy-user' },
    ])
    expect(namespace.getSession(connection.id)?.presenceUserId).toEqual({
      'presence-room': 'legacy-user',
    })
  })

  test('enforces default presence member, user ID, and user object limits', async () => {
    const namespace = new RealtimeNamespace(policy)

    for (let index = 0; index <= 100; index += 1) {
      const userId = `u${index}`
      const connection = new TestConnection(`socket-${userId}`)
      namespace.connect(connection)
      await signIn(namespace, connection, userId, { name: 'A' })
      await subscribePresence(namespace, connection, userId, { name: 'A' })
    }

    expect(namespace.getChannel('presence-room')?.user_count).toBe(100)
    expect(namespace.getSession('socket-u100')?.channels).toEqual([])

    const idNamespace = new RealtimeNamespace(policy)
    const longIdConnection = new TestConnection('socket-long-id')
    idNamespace.connect(longIdConnection)
    const longUserId = 'a'.repeat(129)
    await signIn(idNamespace, longIdConnection, longUserId, { name: 'A' })
    await subscribePresence(idNamespace, longIdConnection, longUserId, {
      name: 'A',
    })
    expect(longIdConnection.takeLast('pusher:error')?.data).toBe(
      '{"code":4300,"message":"Presence user ID limit exceeded"}',
    )

    const objectNamespace = new RealtimeNamespace(policy)
    const objectConnection = new TestConnection('socket-object')
    objectNamespace.connect(objectConnection)
    await signIn(objectNamespace, objectConnection, 'u1', { name: 'A' })
    await subscribePresence(objectNamespace, objectConnection, 'u1', {
      name: 'a'.repeat(1024),
    })
    expect(objectConnection.takeLast('pusher:error')?.data).toBe(
      '{"code":4300,"message":"Presence user object limit exceeded"}',
    )
  })

  test('restores presence info per channel', async () => {
    const namespace = new RealtimeNamespace(policy)
    const connection = new TestConnection('socket-1')
    namespace.restore(connection, {
      id: connection.id,
      channels: ['presence-first', 'presence-second'],
      userId: 'user-1',
      userInfo: { name: 'fallback' },
      presenceUserInfo: {
        'presence-first': { name: 'First' },
        'presence-second': { name: 'Second' },
      },
    })

    expect(namespace.getSession(connection.id)?.presenceUserInfo).toEqual({
      'presence-first': { name: 'First' },
      'presence-second': { name: 'Second' },
    })

    const second = new TestConnection('socket-2')
    namespace.connect(second)
    const channelData = JSON.stringify({
      user_id: 'user-2',
      user_info: { name: 'Other' },
    })
    await namespace.receive(
      second.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: 'presence-first',
          auth: await auth(second.id, channelData, true, 'presence-first'),
          channel_data: channelData,
        },
      }),
    )

    const subscription = second.takeLast(
      'pusher_internal:subscription_succeeded',
    )
    // SAFETY: a successful subscription response always serializes data as a string.
    expect(JSON.parse(subscription?.data as string)).toEqual({
      presence: {
        ids: ['user-1', 'user-2'],
        hash: {
          'user-1': { name: 'First' },
          'user-2': { name: 'Other' },
        },
        count: 2,
      },
    })
  })

  test('trigger broadcasts across multiple channels and enriches info attributes', async () => {
    const namespace = new RealtimeNamespace(policy)
    const first = new TestConnection('socket-1')
    const second = new TestConnection('socket-2')
    namespace.connect(first)
    namespace.connect(second)

    await namespace.receive(
      first.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: 'orders' },
      }),
    )
    await namespace.receive(
      second.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: 'notifications' },
      }),
    )

    const result = await namespace.trigger({
      name: 'item-created',
      data: { id: 123 },
      channels: ['orders', 'notifications'],
      info: 'subscription_count',
    })

    expect(result.recipientCount).toBe(2)
    expect(result.channels).toEqual({
      orders: { subscription_count: 1 },
      notifications: { subscription_count: 1 },
    })
    expect(first.takeLast('item-created')?.data).toBe('{"id":123}')
    expect(second.takeLast('item-created')?.data).toBe('{"id":123}')
  })

  test('triggerBatch broadcasts multiple events and resolves batch info', async () => {
    const namespace = new RealtimeNamespace(policy)
    const conn = new TestConnection('socket-1')
    namespace.connect(conn)

    await namespace.receive(
      conn.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: 'chat' },
      }),
    )

    const result = await namespace.triggerBatch({
      batch: [
        {
          name: 'msg-1',
          channel: 'chat',
          data: { text: 'one' },
          info: 'subscription_count',
        },
        {
          name: 'msg-2',
          channel: 'chat',
          data: { text: 'two' },
        },
      ],
    })

    expect(result.batch).toEqual([{ subscription_count: 1 }, {}])
    expect(conn.takeLast('msg-2')?.data).toBe('{"text":"two"}')
  })

  test('queryChannels and queryChannel format standard Pusher responses', async () => {
    const namespace = new RealtimeNamespace(policy)
    const conn = new TestConnection('socket-1')
    namespace.connect(conn)

    await namespace.receive(
      conn.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: 'public-news' },
      }),
    )

    const allChannels = namespace.queryChannels({
      info: 'subscription_count',
    })
    expect(allChannels).toEqual({
      channels: {
        'public-news': { subscription_count: 1 },
      },
    })

    const filtered = namespace.queryChannels({
      filterByPrefix: 'presence-',
    })
    expect(filtered).toEqual({ channels: {} })

    const singleChannel = namespace.queryChannel('public-news', {
      info: 'subscription_count',
    })
    expect(singleChannel).toEqual({
      occupied: true,
      subscription_count: 1,
    })

    const nonExistent = namespace.queryChannel('unknown')
    expect(nonExistent).toBeNull()
  })
})

async function signIn(
  namespace: RealtimeNamespace,
  connection: TestConnection,
  userId: string,
  userInfo: JsonObject,
) {
  const userData = JSON.stringify({ id: userId, user_info: userInfo })
  await namespace.receive(
    connection.id,
    JSON.stringify({
      event: 'pusher:signin',
      data: {
        auth: await signinAuth(connection.id, userData),
        user_data: userData,
      },
    }),
  )
}

async function subscribePresence(
  namespace: RealtimeNamespace,
  connection: TestConnection,
  userId: string,
  userInfo: JsonObject,
) {
  const channelData = JSON.stringify({ user_id: userId, user_info: userInfo })
  await namespace.receive(
    connection.id,
    JSON.stringify({
      event: 'pusher:subscribe',
      data: {
        channel: 'presence-room',
        auth: await auth(connection.id, channelData, true),
        channel_data: channelData,
      },
    }),
  )
}

async function signinAuth(socketId: string, userData: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(policy.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${socketId}::user::${userData}`),
  )
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `${policy.key}:${hex}`
}
