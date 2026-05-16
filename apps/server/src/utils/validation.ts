const CHANNEL_NAME_REGEX = /^[a-zA-Z0-9_\-=@,.;]+$/
const MAX_CHANNEL_NAME_LENGTH = 164
const MAX_EVENT_NAME_LENGTH = 200

export function isValidChannelName(channel: string): boolean {
  if (channel.length > MAX_CHANNEL_NAME_LENGTH) return false
  if (channel.startsWith('pusher:')) return false
  return CHANNEL_NAME_REGEX.test(channel)
}

export function isValidEventName(event: string): boolean {
  if (event.length > MAX_EVENT_NAME_LENGTH) return false
  return event.length > 0
}
