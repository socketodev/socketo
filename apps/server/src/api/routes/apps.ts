import { Hono } from 'hono'
import { validator } from 'hono/validator'
import type { HonoContext } from '@/types'
import { appMiddleware } from '../middlewares/app-middleware'
import { authMiddleware } from '../middlewares/auth-middleware'
import { batchEventSchema, eventSchema } from '../schemas/apps'

const app = new Hono<HonoContext>()

app.use('/:key/*', appMiddleware, authMiddleware)

app.get('/:key/sockets', async (c) => {
  const { stub } = c.get('app')

  const sockets = await stub.getSocketCount()

  return c.json({ sockets })
})

app.get('/:key/channels', async (c) => {
  const { stub } = c.get('app')
  const filterByPrefix = c.req.query('filter_by_prefix')
  const info = c.req.query('info')

  const requestedAttrs = info ? info.split(',').map((s) => s.trim()) : []

  const includeUserCount = requestedAttrs.includes('user_count')
  const includeSubscriptionCount =
    requestedAttrs.length === 0 || requestedAttrs.includes('subscription_count')

  if (includeUserCount && !filterByPrefix?.startsWith('presence-')) {
    return c.json(
      { error: 'user_count requires filtering by presence- prefix' },
      400,
    )
  }

  const channels: Record<string, Record<string, unknown>> = {}

  if (includeUserCount) {
    const result = await stub.getChannelsWithInfo()

    for (const [channel, counts] of result) {
      if (filterByPrefix && !channel.startsWith(filterByPrefix)) continue

      const attrs: Record<string, unknown> = {}
      if (includeSubscriptionCount) {
        attrs.subscription_count = counts.subscription_count
      }
      attrs.user_count = counts.user_count

      channels[channel] = attrs
    }
  } else {
    const result = await stub.getChannels()

    for (const [channel, subscriptionCount] of result) {
      if (filterByPrefix && !channel.startsWith(filterByPrefix)) continue

      const attrs: Record<string, unknown> = {}
      if (includeSubscriptionCount) {
        attrs.subscription_count = subscriptionCount
      }

      channels[channel] = attrs
    }
  }

  return c.json({ channels }, 200)
})

app.get('/:key/channels/:channel_name', async (c) => {
  const { stub } = c.get('app')
  const channelName = c.req.param('channel_name')
  const info = c.req.query('info')

  const channel = await stub.getChannel(channelName)

  if (!channel) {
    return c.json({ occupied: false }, 200)
  }

  const requestedAttrs = info ? info.split(',').map((s) => s.trim()) : []

  if (
    requestedAttrs.includes('user_count') &&
    !channelName.startsWith('presence-')
  ) {
    return c.json(
      { error: 'user_count is only available for presence channels' },
      400,
    )
  }

  const response: Record<string, unknown> = { occupied: true }

  if (requestedAttrs.length === 0 || requestedAttrs.includes('user_count')) {
    response.user_count = channel.user_count
  }

  if (
    requestedAttrs.length === 0 ||
    requestedAttrs.includes('subscription_count')
  ) {
    response.subscription_count = channel.subscription_count
  }

  return c.json(response)
})

app.get('/:key/channels/:channel_name/users', async (c) => {
  const { stub } = c.get('app')
  const channelName = c.req.param('channel_name')

  const users = await stub.getChannelUsers(channelName)

  if (users === null) {
    return c.json(
      { error: 'users endpoint is only available for presence channels' },
      400,
    )
  }

  return c.json({ users })
})

app.post('/:key/users/:user_id/terminate_connections', async (c) => {
  const { stub } = c.get('app')
  const userId = c.req.param('user_id')

  await stub.terminateUserConnections(userId)

  return c.json({})
})

app.post(
  '/:key/events',
  validator('json', (value, c) => {
    const parsed = eventSchema.safeParse(value)
    if (!parsed.success) {
      return c.json({ status: false, errors: parsed.error.issues }, 400)
    }
    return parsed.data
  }),
  async (c) => {
    const { stub } = c.get('app')
    const payload = c.req.valid('json')

    await stub.broadcast(payload)

    if (payload.info) {
      const requested = payload.info.split(',').map((s) => s.trim())
      const includeUserCount = requested.includes('user_count')
      const includeSubscriptionCount = requested.includes('subscription_count')

      const channels =
        payload.channels ?? (payload.channel ? [payload.channel] : [])
      const result: Record<string, Record<string, number>> = {}

      for (const channel of channels) {
        const occ = await stub.getChannel(channel)
        const attrs: Record<string, number> = {}
        if (occ) {
          if (includeUserCount) attrs.user_count = occ.user_count
          if (includeSubscriptionCount)
            attrs.subscription_count = occ.subscription_count
        }
        result[channel] = attrs
      }

      return c.json({ channels: result }, 200)
    }

    return c.json({}, 200)
  },
)

app.post(
  '/:key/batch_events',
  validator('json', (value, c) => {
    const parsed = batchEventSchema.safeParse(value)
    if (!parsed.success) {
      return c.json({ status: false, errors: parsed.error.issues }, 400)
    }
    return parsed.data
  }),
  async (c) => {
    const { stub } = c.get('app')
    const payload = c.req.valid('json')

    await stub.broadcast(payload)

    const batchResponses = await Promise.all(
      payload.batch.map(async (item) => {
        if (!item.info) return {}

        const requested = item.info.split(',').map((s) => s.trim())
        const includeUserCount = requested.includes('user_count')
        const includeSubscriptionCount =
          requested.includes('subscription_count')

        const occ = await stub.getChannel(item.channel)
        const attrs: Record<string, number> = {}
        if (occ) {
          if (includeUserCount) attrs.user_count = occ.user_count
          if (includeSubscriptionCount)
            attrs.subscription_count = occ.subscription_count
        }
        return attrs
      }),
    )

    return c.json({ batch: batchResponses }, 200)
  },
)

export { app as appsRouter }
