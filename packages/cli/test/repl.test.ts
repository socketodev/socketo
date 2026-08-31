import { describe, expect, it } from 'bun:test'
import { COMMANDS } from '../src/repl.js'

describe('REPL Commands', () => {
  it('defines all required interactive slash commands', () => {
    const commandNames = COMMANDS.map((c) => c.name)
    expect(commandNames).toContain('/trigger')
    expect(commandNames).toContain('/channels')
    expect(commandNames).toContain('/presence')
    expect(commandNames).toContain('/sockets')
    expect(commandNames).toContain('/terminate')
    expect(commandNames).toContain('/verbose')
    expect(commandNames).toContain('/clear')
    expect(commandNames).toContain('/help')
    expect(commandNames).toContain('/quit')
  })

  it('provides aliases for common commands', () => {
    const triggerCmd = COMMANDS.find((c) => c.name === '/trigger')
    expect(triggerCmd?.aliases).toContain('/t')
    expect(triggerCmd?.aliases).toContain('/event')

    const channelsCmd = COMMANDS.find((c) => c.name === '/channels')
    expect(channelsCmd?.aliases).toContain('/c')
    expect(channelsCmd?.aliases).toContain('/list')
  })
})
