import { createErrorMessage, serializeMessage } from '@socketo/core'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { HonoContext } from '@/types'

const app = new Hono<HonoContext>()

function rejectWs(code: number, message: string): Response {
  const [client, server] = Object.values(new WebSocketPair())
  server.accept()
  server.send(serializeMessage(createErrorMessage(code, message)))
  server.close(code, message)
  return new Response(null, { status: 101, webSocket: client })
}

app.get('/:key', async (c) => {
  const header = c.req.header('Upgrade')
  if (!header || header.toLowerCase() !== 'websocket') {
    throw new HTTPException(400, {
      message: 'Upgrade header missing or invalid',
    })
  }

  const protocol = c.req.query('protocol')
  if (!protocol) {
    return rejectWs(4008, 'No protocol version supplied')
  }
  if (protocol !== '7') {
    return rejectWs(4007, 'Unsupported protocol version')
  }

  const key = c.req.param('key') || ''
  const dbStub = c.env.DatabaseDO.get(c.env.DatabaseDO.idFromName('default'))
  const appData = await dbStub.getAppByIdOrKey(key)

  if (!appData) {
    return rejectWs(4001, 'Application does not exist')
  }

  const serverStub = c.env.ServerDO.get(
    c.env.ServerDO.idFromName(appData.key),
    {
      locationHint: appData.location_hint ?? undefined,
    },
  )

  return serverStub.fetch(c.req.raw, {
    headers: {
      ...Object.fromEntries(c.req.raw.headers),
      'X-APP-KEY': appData.key,
    },
  })
})

export { app as webSocketRouter }
