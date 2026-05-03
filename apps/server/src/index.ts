import { app } from './api'

export { DatabaseDO } from './durable-objects/database'
export { ServerDO } from './durable-objects/server'

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>
