import { createHash } from 'node:crypto'
import { z } from 'zod'

const MAX_EXTERNAL_CONTENT_LENGTH = 20_000

export const externalKnowledgeSchema = z.object({
  title: z.string().trim().min(1).max(240),
  content: z.string().min(1).max(MAX_EXTERNAL_CONTENT_LENGTH).refine((value) => value.trim().length > 0, 'El contenido no puede estar vacío'),
  type: z.enum(['decision', 'task', 'agreement', 'context', 'minute', 'note', 'open_question', 'other']).default('note'),
  externalId: z.string().trim().max(240).optional(),
  externalUrl: z.string().url().max(2000).optional(),
  externalType: z.string().trim().max(120).optional(),
  sourceDate: z.coerce.date().optional(),
})
export type ExternalKnowledge = z.infer<typeof externalKnowledgeSchema>

export type ParsedExternalKnowledge = ExternalKnowledge & { id: string; normalizedKey: string; source: Record<string, unknown> }

const inputSchema = z.object({
  items: z.array(externalKnowledgeSchema).max(500).optional(),
  decisions: z.array(externalKnowledgeSchema.omit({ type: true }).extend({ type: z.literal('decision').optional() })).max(500).optional(),
  tasks: z.array(externalKnowledgeSchema.omit({ type: true }).extend({ type: z.literal('task').optional() })).max(500).optional(),
  agreements: z.array(externalKnowledgeSchema.omit({ type: true }).extend({ type: z.literal('agreement').optional() })).max(500).optional(),
  context: z.array(externalKnowledgeSchema.omit({ type: true }).extend({ type: z.literal('context').optional() })).max(500).optional(),
  minutes: z.array(externalKnowledgeSchema.omit({ type: true }).extend({ type: z.literal('minute').optional() })).max(500).optional(),
  notes: z.array(externalKnowledgeSchema.omit({ type: true }).extend({ type: z.literal('note').optional() })).max(500).optional(),
  open_questions: z.array(externalKnowledgeSchema.omit({ type: true }).extend({ type: z.literal('open_question').optional() })).max(500).optional(),
}).passthrough()

function normalize(value: string) { return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ') }
function deterministicId(item: ExternalKnowledge) { return `ventana-celeste-${createHash('sha256').update(`${item.externalId ?? ''}|${item.type}|${normalize(item.title)}|${normalize(item.content)}`).digest('hex').slice(0, 32)}` }
function humanizeKey(key: string) { return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (char) => char.toUpperCase()) }
function formatValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return 'No informado'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((item) => `- ${formatValue(item, depth + 1)}`).join('\n')
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${humanizeKey(key)}: ${formatValue(item, depth + 1)}`).join('\n')
  return String(value)
}
function inferExternalType(section: string): ExternalKnowledge['type'] {
  const key = section.toLocaleLowerCase()
  if (/decision|decisi[oó]n/.test(key)) return 'decision'
  if (/commitment|agreement|acuerdo|compromiso/.test(key)) return 'agreement'
  if (/task|tarea|pending|pendiente/.test(key)) return 'task'
  if (/meeting|minute|reuni[oó]n|minuta|event/.test(key)) return 'minute'
  if (/question|pregunta|issue|problema/.test(key)) return 'open_question'
  if (/meta|context|project|proyecto|area|team|equipo|people|software|document|milestone|roadmap|plan/.test(key)) return 'context'
  return 'other'
}

function structuredRecord(section: string, value: unknown, index?: number): ExternalKnowledge {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  const titleFields = ['title', 'name', 't', 'what', 'task', 'goal', 'subject', 'question', 'n', 'id']
  const valueTitle = record && titleFields.map((key) => record[key]).find((field) => typeof field === 'string' && field.trim())
  const sectionTitle = humanizeKey(section)
  const title = typeof valueTitle === 'string' ? `${sectionTitle}: ${valueTitle}` : `${sectionTitle}${index === undefined ? '' : ` ${index + 1}`}`
  const content = record ? formatValue(record) : formatValue(value)
  const externalId = record?.externalId ?? record?.id
  return {
    title: title.slice(0, 240),
    content: content.trim() || title,
    type: inferExternalType(section),
    ...(typeof externalId === 'string' || typeof externalId === 'number' ? { externalId: String(externalId).slice(0, 240) } : {}),
  }
}

function structuredItems(raw: Record<string, unknown>): ExternalKnowledge[] {
  return Object.entries(raw).flatMap(([key, value]) => Array.isArray(value)
    ? value.map((item, index) => structuredRecord(key, item, index))
    : [structuredRecord(key, value)])
}

function splitLongContent(content: string) {
  const normalized = content.trim()
  const chunks: string[] = []
  let offset = 0

  while (normalized.length - offset > MAX_EXTERNAL_CONTENT_LENGTH) {
    const limit = offset + MAX_EXTERNAL_CONTENT_LENGTH
    const newline = normalized.lastIndexOf('\n', limit - 1)
    const space = normalized.lastIndexOf(' ', limit - 1)
    let end = newline >= offset + MAX_EXTERNAL_CONTENT_LENGTH * 0.75 ? newline + 1 : space >= offset + MAX_EXTERNAL_CONTENT_LENGTH * 0.75 ? space + 1 : limit
    const splitsSurrogatePair = end < normalized.length && end > offset && normalized.charCodeAt(end - 1) >= 0xd800 && normalized.charCodeAt(end - 1) <= 0xdbff && normalized.charCodeAt(end) >= 0xdc00 && normalized.charCodeAt(end) <= 0xdfff
    if (splitsSurrogatePair) end -= 1
    chunks.push(normalized.slice(offset, end))
    offset = end
  }

  if (offset < normalized.length) chunks.push(normalized.slice(offset))
  return chunks.length ? chunks : ['']
}

function splitExternalItem(item: unknown): unknown[] {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return [item]
  const record = item as Record<string, unknown>
  if (typeof record.content !== 'string') return [item]

  const chunks = splitLongContent(record.content)
  if (chunks.length === 1) return [{ ...record, content: chunks[0] }]

  return chunks.map((content, index) => {
    const titleSuffix = ` (parte ${index + 1}/${chunks.length})`
    const externalIdSuffix = `:part-${index + 1}`
    return {
      ...record,
      title: typeof record.title === 'string' ? `${record.title.slice(0, 240 - titleSuffix.length).trimEnd()}${titleSuffix}` : record.title,
      content,
      externalId: typeof record.externalId === 'string' ? `${record.externalId.slice(0, 240 - externalIdSuffix.length)}${externalIdSuffix}` : record.externalId,
    }
  })
}

function prepareExternalItems(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.flatMap(splitExternalItem)
  if (!raw || typeof raw !== 'object') return raw
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, Array.isArray(value) ? value.flatMap(splitExternalItem) : value]))
}

export function parseVentanaCelesteImport(raw: unknown): ParsedExternalKnowledge[] {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  let unwrapped: unknown = parsed
  // Sources commonly wrap the same payload in multiple API envelopes.
  for (let depth = 0; depth < 4 && unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped); depth += 1) {
    const record = unwrapped as Record<string, unknown>
    const envelopes = ['data', 'results', 'knowledge', 'items', 'records', 'documents']
    const metadata = new Set(['meta', 'metadata', 'success', 'status', 'count', 'total', 'version', 'updated', 'timestamp', 'errors'])
    const isEnvelope = Object.keys(record).every((key) => envelopes.includes(key) || metadata.has(key))
    const envelope = isEnvelope ? envelopes.find((key) => record[key] !== undefined) : undefined
    if (!envelope) break
    unwrapped = record[envelope]
  }
  // Preserve known collections, but turn unknown structured records into readable entries.
  if (Array.isArray(unwrapped)) {
    const isCanonicalList = unwrapped.every((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).title === 'string' && typeof (item as Record<string, unknown>).content === 'string')
    if (!isCanonicalList) unwrapped = { items: structuredItems({ records: unwrapped }) }
  }
  if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
    const value = unwrapped as Record<string, unknown>
    const recognized = new Set(['items', 'decisions', 'tasks', 'agreements', 'context', 'minutes', 'notes', 'open_questions'])
    const grouped = Object.values(value).filter(Array.isArray).flat() as unknown[]
    const hasUnknownKey = Object.keys(value).some((key) => !recognized.has(key))
    const isCanonicalGroups = Object.entries(value).every(([key, items]) => recognized.has(key) && Array.isArray(items))
      && grouped.every((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).title === 'string' && typeof (item as Record<string, unknown>).content === 'string')
    if (!isCanonicalGroups && (hasUnknownKey || grouped.length > 0)) unwrapped = { items: structuredItems(value) }
  }
  const input = inputSchema.parse(prepareExternalItems(Array.isArray(unwrapped) ? { items: unwrapped } : unwrapped))
  const groups: ExternalKnowledge[] = [
    ...(input.items ?? []).map((item) => ({ ...item, type: item.type ?? 'note' as const })),
    ...(input.decisions ?? []).map((item) => ({ ...item, type: 'decision' as const })),
    ...(input.tasks ?? []).map((item) => ({ ...item, type: 'task' as const })),
    ...(input.agreements ?? []).map((item) => ({ ...item, type: 'agreement' as const })),
    ...(input.context ?? []).map((item) => ({ ...item, type: 'context' as const })),
    ...(input.minutes ?? []).map((item) => ({ ...item, type: 'minute' as const })),
    ...(input.notes ?? []).map((item) => ({ ...item, type: 'note' as const })),
    ...(input.open_questions ?? []).map((item) => ({ ...item, type: 'open_question' as const })),
  ]
  const seen = new Set<string>()
  return groups.filter((item) => { const key = item.externalId ? `id:${item.externalId}` : `content:${item.type}:${normalize(item.title)}:${normalize(item.content)}`; if (seen.has(key)) return false; seen.add(key); return true }).map((item) => ({ ...item, id: deterministicId(item), normalizedKey: `${item.type}:${normalize(item.title)}:${normalize(item.content)}`, source: { type: 'external', provider: 'ventana_celeste', ...(item.externalId ? { externalId: item.externalId } : {}), ...(item.externalUrl ? { externalUrl: item.externalUrl } : {}), importedAt: new Date().toISOString(), ...(item.externalType ? { externalType: item.externalType } : {}) } }))
}

export function parseVentanaCelesteText(raw: string): ParsedExternalKnowledge[] {
  const normalized = raw.replace(/\\r/g, '').trim()
  const blocks = normalized.split(/\n\s*\n|(?=^#{1,6}\s+)|(?=^(?:[A-ZÁÉÍÓÚÑ][^\n]{2,100}:)\s*$)/gim).map((block) => block.trim()).filter(Boolean)
  const bounded = blocks.flatMap((block) => block.length <= 6000 ? [block] : block.match(/[\s\S]{1,6000}/g) ?? [block])
  return parseVentanaCelesteImport({ items: bounded.map((content, index) => ({ title: content.split('\n')[0].replace(/^#{1,6}\s+/, '').slice(0, 240) || `Ventana Celeste ${index + 1}`, content, type: 'note' })) })
}
