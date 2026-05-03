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

  const result = await stub.getChannels()

  const channels = Object.fromEntries(
    Array.from(result).map(([channel, userCount]) => [
      channel,
      { subscription_count: userCount },
    ]),
  )

  return c.json({ channels }, 200)
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

    return c.json({}, 200)
  },
)

export { app as appsRouter }
