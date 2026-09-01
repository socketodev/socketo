import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { AppPolicy } from './types'

export function safeTimingEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.byteLength !== bufB.byteLength) return false
  return timingSafeEqual(bufA, bufB)
}

export function verifyChannelAuth(
  socketId: string,
  channel: string,
  auth: string,
  policy: AppPolicy,
  channelData?: string,
): boolean {
  const signedData =
    channelData !== undefined
      ? `${socketId}:${channel}:${channelData}`
      : `${socketId}:${channel}`
  const expected = `${policy.key}:${hmacHex(policy.secret, signedData)}`
  return safeTimingEqual(auth, expected)
}

export function verifySigninAuth(
  socketId: string,
  userData: string,
  auth: string,
  policy: AppPolicy,
): boolean {
  const signedData = `${socketId}::user::${userData}`
  const expected = `${policy.key}:${hmacHex(policy.secret, signedData)}`
  return safeTimingEqual(auth, expected)
}

export function verifyRestAuth(options: {
  method: string
  path: string
  query: URLSearchParams
  body?: string
  appKey: string
  appSecret: string
  maxSkewSeconds?: number
}): boolean {
  const {
    method,
    path,
    query,
    body,
    appKey,
    appSecret,
    maxSkewSeconds = 600,
  } = options
  const authKey = query.get('auth_key')
  const authTimestamp = query.get('auth_timestamp')
  const authVersion = query.get('auth_version')
  const authSignature = query.get('auth_signature')

  if (
    authKey !== appKey ||
    !authTimestamp ||
    authVersion !== '1.0' ||
    !authSignature
  ) {
    return false
  }

  const timestamp = Number(authTimestamp)
  const now = Math.floor(Date.now() / 1000)
  if (
    !Number.isInteger(timestamp) ||
    timestamp <= 0 ||
    Math.abs(now - timestamp) > maxSkewSeconds
  ) {
    return false
  }

  if (
    body !== undefined &&
    ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())
  ) {
    const bodyMd5 = query.get('body_md5')
    const expectedMd5 = createHash('md5').update(body).digest('hex')
    if (!bodyMd5 || !safeTimingEqual(bodyMd5, expectedMd5)) return false
  }

  const queryEntries = [...query.entries()]
    .filter(([key]) => key.toLowerCase() !== 'auth_signature')
    .map(([key, val]) => [key.toLowerCase(), val])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${val}`)
    .join('&')

  const stringToSign = `${method.toUpperCase()}\n${path}\n${queryEntries}`
  return safeTimingEqual(authSignature, hmacHex(appSecret, stringToSign))
}

export interface SignedRestRequest {
  queryParams: URLSearchParams
  signature: string
}

export function signRestRequest(options: {
  method: string
  path: string
  query?: Record<string, string>
  body?: string
  appKey: string
  appSecret: string
}): SignedRestRequest {
  const { method, path, body, appKey, appSecret } = options
  const entries: [string, string][] = [
    ['auth_key', appKey],
    ['auth_timestamp', String(Math.floor(Date.now() / 1000))],
    ['auth_version', '1.0'],
  ]

  if (options.query) {
    for (const [k, v] of Object.entries(options.query)) {
      entries.push([k.toLowerCase(), v])
    }
  }

  if (
    body !== undefined &&
    ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())
  ) {
    entries.push(['body_md5', createHash('md5').update(body).digest('hex')])
  }

  entries.sort(([a], [b]) => a.localeCompare(b))
  const queryString = entries.map(([k, v]) => `${k}=${v}`).join('&')
  const stringToSign = `${method.toUpperCase()}\n${path}\n${queryString}`
  const signature = hmacHex(appSecret, stringToSign)

  const queryParams = new URLSearchParams(entries)
  queryParams.set('auth_signature', signature)

  return { queryParams, signature }
}

function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}
