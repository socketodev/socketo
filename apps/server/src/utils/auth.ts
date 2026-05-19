import crypto from 'node:crypto'

export function verifyChannelAuth(
  socketId: string,
  channel: string,
  authString: string,
  secret: string,
  appKey: string,
): boolean {
  const parts = authString.split(':')
  if (parts.length < 2 || parts[0] !== appKey) return false

  const providedSignature = parts.slice(1).join(':')
  const stringToSign = `${socketId}:${channel}`
  const expectedSignature = computeHmac(stringToSign, secret)

  return providedSignature === expectedSignature
}

export function verifySigninAuth(
  socketId: string,
  userData: string,
  authString: string,
  secret: string,
  appKey: string,
): boolean {
  const expectedPrefix = `${appKey}::user::`
  if (!authString.startsWith(expectedPrefix)) return false

  const providedSignature = authString.slice(expectedPrefix.length)
  const stringToSign = `${socketId}::user::${userData}`
  const expectedSignature = computeHmac(stringToSign, secret)

  return providedSignature === expectedSignature
}

function computeHmac(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex')
}

export function isPrivateChannel(channel: string): boolean {
  return channel.startsWith('private-')
}

export function isPresenceChannel(channel: string): boolean {
  return channel.startsWith('presence-')
}

export function isProtectedChannel(channel: string): boolean {
  return isPrivateChannel(channel) || isPresenceChannel(channel)
}
