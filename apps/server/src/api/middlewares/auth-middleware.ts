import { verifyRestAuth } from '@socketo/core'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'
import { querySchema } from '../schemas/apps'

export const authMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const parsed = querySchema.safeParse(c.req.query())

  if (!parsed.success) {
    return c.json({ status: false, errors: parsed.error.issues }, 400)
  }

  const { key, secret } = c.get('app')
  const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(
    c.req.method.toUpperCase(),
  )
  const body = isBodyMethod ? await c.req.text() : undefined

  const isValid = verifyRestAuth({
    method: c.req.method,
    path: c.req.path,
    query: new URL(c.req.url).searchParams,
    body,
    appKey: key,
    appSecret: secret,
  })

  if (!isValid) {
    throw new HTTPException(401, { message: 'Invalid auth signature' })
  }

  return next()
})
