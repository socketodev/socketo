import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'

export const appMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const identifier = c.req.param('key') || c.req.param('app_id') || ''

  const stub = c.env.DatabaseDO.get(c.env.DatabaseDO.idFromName('default'))
  const app = await stub.getAppByIdOrKey(identifier)

  if (!app) {
    throw new HTTPException(404, { message: 'App not found' })
  }

  c.set('app', {
    stub: c.env.ServerDO.get(c.env.ServerDO.idFromName(app.key), {
      locationHint: app.location_hint ?? undefined,
    }),
    ...app,
  })

  return next()
})
