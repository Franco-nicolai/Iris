import { z } from 'zod'

export const directIrisResponseSchema = z.object({ answer: z.string().trim().min(1).max(600), confidence: z.number().min(0).max(1), evidence: z.array(z.string().trim().min(1).max(300)).max(8), fallback: z.boolean().optional() }).strict()
export type DirectIrisResponse = z.infer<typeof directIrisResponseSchema>

const wakeWord = /^(?:oye\s+)?iris\b[\s,:-]*/i
const isolatedWakeWord = /^(?:oye\s+|hola\s+)?iris[\s,:-]*$/i

export function detectDirectIrisInvocation(text: string): { invoked: boolean; query: string; invocationId: string } {
  const normalized = text.trim().replace(/\s+/g, ' ')
  const match = normalized.match(wakeWord)
  if (!match) return { invoked: false, query: '', invocationId: '' }
  const query = normalized.slice(match[0].length).trim().replace(/^¿+/, '').replace(/[¿?]+$/g, '').trim()
  if (!query || /^(?:es|era|será)\s+(?:la|el|una|un)\b/i.test(query)) return { invoked: false, query: '', invocationId: '' }
  return { invoked: true, query, invocationId: crypto.randomUUID() }
}

export function isIsolatedIrisWakeWord(text: string) {
  return isolatedWakeWord.test(text.trim())
}

export function normalizeDirectInvocationQuery(text: string) {
  return text.trim().replace(/^¿+/, '').replace(/[¿?]+$/g, '').trim()
}
