import { describe, expect, it } from 'vitest'
import { recoveryIndexTool } from '../src/mcp/tools/recovery.ts'

describe('recovery_index tool', () => {
  it('declares the person bound window parameters and nothing else', () => {
    expect(recoveryIndexTool.name).toBe('recovery_index')
    // `inputSchema` is the bare ZodRawShape a tool is declared with (see `Tool` in contract.ts),
    // not a `z.object(...)` instance - so its keys are read directly, the same way
    // mcp-tools.test.ts checks `'sourceId' in t.inputSchema` elsewhere in this suite. The brief's
    // own snippet read `.inputSchema.properties`, which is undefined on this shape.
    expect(Object.keys(recoveryIndexTool.inputSchema).sort()).toEqual(['from', 'to'])
  })
})
