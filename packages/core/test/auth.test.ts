import { describe, expect, test } from 'bun:test'
import {
  generateSocketId,
  isValidSocketId,
  safeTimingEqual,
  signRestRequest,
  verifyChannelAuth,
  verifyRestAuth,
  verifySigninAuth,
} from '../src'

const policy = {
  key: 'app-key',
  secret: 'app-secret',
  enableClientEvents: true,
}

describe('realtime auth', () => {
  test('verifies channel and signin signatures synchronously', () => {
    expect(
      verifyChannelAuth(
        'socket-1',
        'presence-room',
        'app-key:eecee371cd608ea7b4a03058b62eabfa22e57f55304f677510cfc7010b4e4590',
        policy,
        '{"user_id":"user-1"}',
      ),
    ).toBe(true)
    expect(
      verifySigninAuth(
        'socket-1',
        '{"id":"user-1"}',
        'app-key:34b7ea4bcf8580a517de7e5ac0bb2dce8aabb3c944465bbe9d9a4dab41771e89',
        policy,
      ),
    ).toBe(true)
  })

  test('safeTimingEqual compares strings with timing attack protection', () => {
    expect(safeTimingEqual('secret-token-123', 'secret-token-123')).toBe(true)
    expect(safeTimingEqual('secret-token-123', 'secret-token-124')).toBe(false)
    expect(safeTimingEqual('short', 'longer-string')).toBe(false)
  })

  test('verifies REST requests signed with signRestRequest', () => {
    const signed = signRestRequest({
      method: 'POST',
      path: '/apps/app-key/events',
      body: JSON.stringify({ name: 'test', channel: 'my-channel', data: {} }),
      appKey: 'app-key',
      appSecret: 'app-secret',
    })

    expect(
      verifyRestAuth({
        method: 'POST',
        path: '/apps/app-key/events',
        query: signed.queryParams,
        body: JSON.stringify({ name: 'test', channel: 'my-channel', data: {} }),
        appKey: 'app-key',
        appSecret: 'app-secret',
      }),
    ).toBe(true)
  })

  test('rejects an invalid signature', () => {
    expect(
      verifyChannelAuth('socket-1', 'private-room', 'app-key:invalid', policy),
    ).toBe(false)
  })

  test('generates socket IDs matching Pusher integer.integer format', () => {
    for (let i = 0; i < 50; i += 1) {
      const socketId = generateSocketId()
      expect(isValidSocketId(socketId)).toBe(true)
      expect(socketId).toMatch(/^\d+\.\d+$/)
    }
  })
})
