import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'

const app = new Hono<HonoContext>()

app.post(
  '/',
  async (c, next) => {
    const token = c.env.ADMIN_API_TOKEN

    if (!token) {
      throw new HTTPException(500, {
        message: 'ADMIN_API_TOKEN is not configured',
      })
    }

    return bearerAuth<HonoContext>({ token })(c, next)
  },
  async (c) => {
    try {
      const stub = c.env.DatabaseDO.get(c.env.DatabaseDO.idFromName('default'))
      await stub.migrate()
    } catch (error) {
      throw new HTTPException(500, {
        message: 'Failed to migrate database',
        cause: error,
      })
    }

    return c.json({ success: true, result: {} })
  },
)

export { app as migrateRouter }
