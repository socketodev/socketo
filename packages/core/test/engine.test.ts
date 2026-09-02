import { describe, expect, test } from 'bun:test'
import {
  isStringValue,
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

  test('sendToUser delivers events directly to user connections without creating channels', async () => {
    const namespace = new RealtimeNamespace(policy)
    const conn1 = new TestConnection('socket-tab-1')
    const conn2 = new TestConnection('socket-tab-2')
    const connOther = new TestConnection('socket-other')

    namespace.connect(conn1)
    namespace.connect(conn2)
    namespace.connect(connOther)

    await signIn(namespace, conn1, 'user-target', { name: 'Target' })
    await signIn(namespace, conn2, 'user-target', { name: 'Target' })
    await signIn(namespace, connOther, 'user-other', { name: 'Other' })

    const connPresenceOnly = new TestConnection('socket-presence-only')
    namespace.connect(connPresenceOnly)
    await subscribePresence(namespace, connPresenceOnly, 'user-target', {
      name: 'PresenceOnly',
    })

    const result = await namespace.sendToUser(
      'user-target',
      'order-notification',
      {
        orderId: 'ord_123',
        status: 'shipped',
      },
    )

    // Sent only to the 2 authenticated signed-in sockets (conn1, conn2), NOT connPresenceOnly
    expect(result.sent).toBe(2)
    expect(conn1.takeLast('order-notification')).toEqual({
      event: 'order-notification',
      channel: '#server-to-user-user-target',
      data: '{"orderId":"ord_123","status":"shipped"}',
    })
    expect(conn2.takeLast('order-notification')).toEqual({
      event: 'order-notification',
      channel: '#server-to-user-user-target',
      data: '{"orderId":"ord_123","status":"shipped"}',
    })
    expect(connOther.takeLast('order-notification')).toBeUndefined()
    expect(connPresenceOnly.takeLast('order-notification')).toBeUndefined()

    // Test trigger on #server-to-user-<user_id> directly
    const triggerRes = await namespace.trigger({
      channel: '#server-to-user-user-target',
      name: 'direct-trigger-test',
      data: { hello: 'world' },
    })
    expect(triggerRes.recipientCount).toBe(2)
    expect(conn1.takeLast('direct-trigger-test')).toEqual({
      event: 'direct-trigger-test',
      channel: '#server-to-user-user-target',
      data: '{"hello":"world"}',
    })
    expect(
      connPresenceOnly.takeLast('direct-trigger-test'),
    ).toBeUndefined()

    // Test subscribing to #server-to-user channel
    await namespace.receive(
      conn1.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: '#server-to-user-user-target' },
      }),
    )
    expect(
      conn1.takeLast('pusher_internal:subscription_succeeded'),
    ).toBeDefined()

    // Test subscribing to wrong user's server-to-user channel fails
    await namespace.receive(
      connOther.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: '#server-to-user-user-target' },
      }),
    )
    const err = connOther.takeLast('pusher:error')
    expect(err).toBeDefined()
    // SAFETY: pusher:error data payload is a JSON string.
    const errData = JSON.parse(err?.data as string)
    expect(errData).toEqual({
      code: 4009,
      message: 'User not signed in or user ID mismatch',
    })

    // Test that presence-only socket cannot subscribe to #server-to-user channel without signin
    await namespace.receive(
      connPresenceOnly.id,
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: '#server-to-user-user-target' },
      }),
    )
    const errPresence = connPresenceOnly.takeLast('pusher:error')
    expect(errPresence).toBeDefined()
    // SAFETY: errPresence.data is a JSON-encoded string from pusher:error frame.
    const errPresenceData = JSON.parse(errPresence?.data as string)
    expect(errPresenceData).toEqual({
      code: 4009,
      message: 'User not signed in or user ID mismatch',
    })
  })

  test('handles __proto__ as presence user_id and channel name safely without polluting Object prototype', async () => {
    const namespace = new RealtimeNamespace(policy)
    const connection = new TestConnection('socket-proto')
    namespace.connect(connection)

    await subscribePresence(namespace, connection, '__proto__', {
      role: 'special',
    })

    const succeeded = connection.takeLast(
      'pusher_internal:subscription_succeeded',
    )
    expect(succeeded).toBeDefined()
    expect(isStringValue(succeeded?.data)).toBe(true)

    // SAFETY: succeeded.data is a JSON-encoded string from subscription_succeeded.
    const parsed = JSON.parse(succeeded!.data as string)
    expect(parsed.presence.ids).toEqual(['__proto__'])
    expect(parsed.presence.count).toBe(1)
    expect(parsed.presence.hash['__proto__']).toEqual({ role: 'special' })

    // Also test __proto__ public channel in queryChannels and trigger info
    const connProtoChan = new TestConnection('socket-proto-chan')
    namespace.connect(connProtoChan)
    await namespace.receive(
      'socket-proto-chan',
      JSON.stringify({
        event: 'pusher:subscribe',
        data: { channel: '__proto__' },
      }),
    )

    const query = namespace.queryChannels({ info: 'subscription_count' })
    expect(query.channels['__proto__']).toEqual({ subscription_count: 1 })

    const triggerRes = await namespace.trigger({
      channel: '__proto__',
      name: 'test-event',
      data: { ok: true },
      info: 'subscription_count',
    })
    expect(triggerRes.channels?.['__proto__']).toEqual({
      subscription_count: 1,
    })

    // Verify Object prototype was not corrupted
    expect('role' in Object.prototype).toBe(false)
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
