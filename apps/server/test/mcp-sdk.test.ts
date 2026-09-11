import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PersonQuery, createTestDatabase, seedPerson, schema } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { buildServer } from '../src/mcp.ts'

/**
 * The suite that drives the real SDK rather than calling `Tool.run` directly.
 *
 * Every other tool test asks what a tool answers. These ask what a client receives, which is a
 * different question with the SDK in the middle of it: the adapter's `content` blocks, and the
 * argument validation the adapter's own comment says it rests on. `mcp-stdio.test.ts` spawns a
 * process, but only to prove stdout carries nothing but JSON-RPC - it exchanges an `initialize`
 * and stops, so no test before this one had ever made a `tools/call` over a transport.
 *
 * In memory rather than over stdio: `InMemoryTransport.createLinkedPair()` is the SDK's own
 * fixture for exactly this, and it puts a client and a server in one process with the real
 * protocol machinery between them and no child to wait for.
 */
let fixture: TestDatabase
beforeEach(() => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'robin', { displayName: 'Robin', timezone: 'Europe/Amsterdam' })
  fixture.db.insert(schema.sources).values({
    id: 'watch', personId: 'robin', externalId: 'watch', displayName: 'Fitbit Sense',
    kind: 'device', createdAtMs: 0,
  }).run()
})
afterEach(() => fixture.cleanup())

async function connected(): Promise<Client> {
  const server = buildServer(new PersonQuery(fixture.db, 'robin'))
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mcp-sdk-test', version: '1' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

// Takes `result.content`, not the result: the SDK types a call result as a union of the modern
// shape and a legacy `toolResult` one, so `content` comes off it as `unknown` and a parameter
// naming the field would not accept the union at all. The narrowing below is therefore real work
// rather than a cast around a type that already said this.
function textBlocks(blocks: unknown): string[] {
  if (!Array.isArray(blocks)) throw new Error('no content array on the tool result')
  return blocks
    .filter((b): b is { type: 'text', text: string } =>
      typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text')
    .map((b) => b.text)
}

describe('a tool result over the real protocol', () => {
  // The defect this exists for: a client that reads only `content` - which is every client written
  // before `structuredContent` existed, and the reason MCP 2025-06-18 asks for this block at all -
  // used to receive `describe_person: sources 1.` and nothing else, with the person id, the
  // timezone and every source left in a field it never looks at.
  it('carries the summary sentence and the structured content serialised, in that order', async () => {
    const client = await connected()

    const result = await client.callTool({ name: 'describe_person', arguments: {} })
    const blocks = textBlocks(result.content)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toBe('describe_person: sources 1.')
    expect(JSON.parse(blocks[1]!)).toEqual(result.structuredContent)

    await client.close()
  })

  it('puts the answer a summary cannot carry in that second block', async () => {
    const client = await connected()

    const blocks = textBlocks((await client.callTool({ name: 'describe_person', arguments: {} })).content)
    const parsed = JSON.parse(blocks[1]!) as {
      personId: string
      timezone: string
      sources: { id: string, name: { untrustedText: string | null } }[]
    }

    expect(parsed.personId).toBe('robin')
    expect(parsed.timezone).toBe('Europe/Amsterdam')
    expect(parsed.sources.map((s) => s.id)).toEqual(['watch'])
    // Free text is in this block, and that is not a hole in the untrusted rule: it arrives
    // labelled, in a field whose name says what it is, exactly as it does in structuredContent.
    // The summary sentence is the one place a bare string would have nothing around it, and the
    // block above is what the rule binds.
    expect(parsed.sources[0]!.name.untrustedText).toBe('Fitbit Sense')

    await client.close()
  })
})
