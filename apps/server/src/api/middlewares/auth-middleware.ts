import crypto from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'
import { querySchema } from '../schemas/apps'

function generateQueryString(rest: Record<string, string | undefined>): string {
  const keys = Object.keys(rest).sort()
  return keys
    .filter((key) => rest[key] !== undefined)
    .map((key) => `${key.toLowerCase()}=${String(rest[key])}`)
    .join('&')
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

  const { key, secret } = c.get('app')
  const { auth_signature, ...rest } = parsed.data

  if (rest.auth_key !== key) {
    throw new HTTPException(401, {
      message: 'Invalid auth_key for this app',
    })
  }

  if (rest.auth_version !== '1.0') {
    throw new HTTPException(401, {
      message: 'Invalid auth_version. Must be 1.0.',
    })
  }

  const now = Math.floor(Date.now() / 1000)
  const timestamp = parseInt(rest.auth_timestamp, 10)
  if (!Number.isInteger(timestamp) || timestamp <= 0) {
    throw new HTTPException(401, {
      message: 'Invalid auth_timestamp. Must be a Unix timestamp.',
    })
  }
  if (Math.abs(now - timestamp) > 600) {
    throw new HTTPException(401, {
      message: 'auth_timestamp must be within 600 seconds of current time.',
    })
  }

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
