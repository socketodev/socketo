import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'
import { appMiddleware } from '../middlewares/app-middleware'

const upgradeMiddleware = createMiddleware(async (c, next) => {
  const header = c.req.header('Upgrade')
  if (!header || header !== 'websocket') {
    throw new HTTPException(400, {
      message: 'Upgrade header missing or invalid',
    })
  }
  return next()
})

const app = new Hono<HonoContext>()

app.use('/:key', upgradeMiddleware, appMiddleware)

app.get('/:key', async (c) => {
  const key = c.req.param('key')
  const stub = c.env.ServerDO.get(c.env.ServerDO.idFromName(key))

  return stub.fetch(c.req.raw, {
    headers: {
      ...Object.fromEntries(c.req.raw.headers),
      'X-APP-KEY': key,
    },
  })
})

export { app as webSocketRouter }
