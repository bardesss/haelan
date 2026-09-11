import type { Tool } from './contract.ts'
import { personTools } from './tools/person.ts'

/**
 * Every tool, in the order TOOLS.md documents them. Assembly only: a new tool is a function in a
 * family file and one entry here, so this file stays readable as the surface grows.
 */
export const CATALOGUE: Tool[] = [...personTools]
