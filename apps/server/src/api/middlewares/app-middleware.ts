import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'

export const appMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const key = c.req.param('key') || ''

  const stub = c.env.DatabaseDO.get(c.env.DatabaseDO.idFromName('default'))
  const app = await stub.getAppByKey(key)

  if (!app) {
    throw new HTTPException(404, { message: 'App not found' })
  }

  c.set('app', {
    stub: c.env.ServerDO.get(c.env.ServerDO.idFromName(key), {
      locationHint: app.location_hint,
    }),
    secret: app.secret,
  })

  return next()
})
