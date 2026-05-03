import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { HonoContext } from '@/types'

import { appsRouter } from './routes/apps'
import { migrateRouter } from './routes/migrate'
import { webSocketRouter } from './routes/websocket'

const app = new Hono<HonoContext>()

app.use(cors())

app.route('/app', webSocketRouter)
app.route('/apps', appsRouter)

app.route('/migrate', migrateRouter)

export { app }
