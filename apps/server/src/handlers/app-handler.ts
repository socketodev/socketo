import type { App } from '@/database/types'
import type { DatabaseDO } from '@/durable-objects/database'

export class AppHandler {
  private db: DurableObjectStub<DatabaseDO>
  private config: App | undefined

  constructor(private env: Env) {
    this.db = this.createDatabase()
  }

  public async getConfig(key?: string): Promise<App | undefined> {
    if (this.config) {
      return this.config
    }

    if (key) {
      const app = await this.db.getAppByKey(key)
      if (app) {
        this.config = app
        return this.config
      }
    }

    return undefined
  }

  private createDatabase() {
    return this.env.DatabaseDO.get(this.env.DatabaseDO.idFromName('default'))
  }
}
