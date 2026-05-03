import crypto from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'
import { querySchema } from '../schemas/apps'

function generateQueryString(rest: Record<string, string>): string {
  const keys = Object.keys(rest).sort()
  return keys.map((key) => `${key}=${rest[key]}`).join('&')
}

function verifySignature(secret: string, body: string) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function verifyBodyMd5(body: string) {
  return crypto.createHash('md5').update(body).digest('hex')
}

export const authMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const parsed = querySchema.safeParse(c.req.query())

  if (!parsed.success) {
    return c.json({ status: false, errors: parsed.error.issues }, 400)
  }

  const { secret } = c.get('app')
  const { auth_signature, ...rest } = parsed.data

  if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
    const body = await c.req.text()
    const expectedBodyMd5 = verifyBodyMd5(body)

    if (!rest.body_md5 || rest.body_md5 !== expectedBodyMd5) {
      throw new HTTPException(401, {
        message: 'Invalid body_md5 hash. Payload tampered.',
      })
    }
  }

  const queryString = generateQueryString(rest)
  const stringToSign = `${c.req.method}\n${c.req.path}\n${queryString}`
  const expectedSignature = verifySignature(secret, stringToSign)

  if (auth_signature !== expectedSignature) {
    throw new HTTPException(401, { message: 'Invalid auth signature' })
  }

  return next()
})
