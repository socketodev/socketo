import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'

const app = new Hono<HonoContext>()

app.post('/', async (c) => {
  if (process.env.NODE_ENV === 'production') {
    throw new HTTPException(403, { message: 'Forbidden' })
  }

  const stub = c.env.DatabaseDO.get(c.env.DatabaseDO.idFromName('default'))
  await stub.migrate()

  return c.json({ success: true, result: {} })
})

export { app as migrateRouter }
