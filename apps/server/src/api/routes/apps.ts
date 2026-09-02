import {
  invalidInfoAttribute,
  isRecord,
  isStringValue,
  type JsonValue,
} from '@socketo/core'
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
  return c.json({ sockets }, 200)
})

app.get('/:key/channels', async (c) => {
  const { stub } = c.get('app')
  const filterByPrefix = c.req.query('filter_by_prefix')
  const info = c.req.query('info')

  const invalidAttr = invalidInfoAttribute(info)
  if (invalidAttr) {
    return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
  }

  const requestedAttrs = info ? info.split(',').map((s) => s.trim()) : []
  if (
    requestedAttrs.includes('user_count') &&
    !filterByPrefix?.startsWith('presence-')
  ) {
    return c.json(
      { error: 'user_count requires filtering by presence- prefix' },
      400,
    )
  }

  const result = await stub.queryChannels({ filterByPrefix, info })
  return c.json(result, 200)
})

app.get('/:key/channels/:channel_name', async (c) => {
  const { stub } = c.get('app')
  const channelName = c.req.param('channel_name')
  const info = c.req.query('info')

  const invalidAttr = invalidInfoAttribute(info)
  if (invalidAttr) {
    return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
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
  if (
    requestedAttrs.includes('subscription_count') &&
    channelName.startsWith('presence-')
  ) {
    return c.json(
      {
        error: 'subscription_count is only available for non-presence channels',
      },
      400,
    )
  }

  const result = await stub.queryChannel(channelName, { info })
  if (!result) {
    return c.json({ occupied: false }, 200)
  }

  return c.json(result, 200)
})

app.get('/:key/channels/:channel_name/users', async (c) => {
  const { stub } = c.get('app')
  const channelName = c.req.param('channel_name')

  const users = await stub.queryChannelUsers(channelName)
  if (users === null) {
    return c.json(
      { error: 'users endpoint is only available for presence channels' },
      400,
    )
  }

  return c.json({ users }, 200)
})

app.post('/:key/users/:user_id/terminate_connections', async (c) => {
  const { stub } = c.get('app')
  const userId = c.req.param('user_id')

  await stub.terminateUserConnections(userId)
  return c.json({}, 200)
})

app.post('/:key/users/:user_id/events', async (c) => {
  const { stub } = c.get('app')
  const userId = c.req.param('user_id')
  // SAFETY: c.req.json() parses JSON into JsonValue or null on failure.
  const rawBody = (await c.req.json().catch(() => null)) as
    | JsonValue
    | undefined
  if (!isRecord(rawBody) || !isStringValue(rawBody.name)) {
    return c.json({ error: 'Event name is required' }, 400)
  }

  const eventName = rawBody.name
  // SAFETY: rawBody conforms to JsonRecord and data defaults to empty object.
  const eventData = (rawBody.data ?? {}) as never
  await stub.sendToUser(userId, eventName, eventData)
  return c.json({}, 200)
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
    const invalidAttr = invalidInfoAttribute(payload.info)
    if (invalidAttr) {
      return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
    }

    const result = await stub.trigger(payload)
    if (result.channels) {
      return c.json({ channels: result.channels }, 200)
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
    for (const item of payload.batch) {
      const invalidAttr = invalidInfoAttribute(item.info)
      if (invalidAttr) {
        return c.json({ error: `Invalid info attribute: ${invalidAttr}` }, 400)
      }
    }

    const result = await stub.triggerBatch(payload)
    return c.json(result, 200)
  },
)

export { app as appsRouter }
