import { parseVentanaCelesteImport, parseVentanaCelesteText, type ParsedExternalKnowledge } from './iris-knowledge-import'

export type ExternalKnowledgeSourceStatus = 'not_configured' | 'connected' | 'error'
export type ExternalKnowledgeRecord = ParsedExternalKnowledge
export type VentanaCelesteDiagnostic = { configured: boolean; reachable: boolean; httpStatus: number | null; contentType: string | null; rawContentLength: number; parsedItemCount: number; lastFetchedAt: string | null; lastError: string | null }

export interface ExternalKnowledgeSource { testConnection(): Promise<{ status: ExternalKnowledgeSourceStatus; message: string }>; listAvailableContent(): Promise<ExternalKnowledgeRecord[]>; importContent(items: ExternalKnowledgeRecord[]): Promise<{ imported: number; updated: number; duplicates: number; errors: string[] }> }
type VentanaCelesteConfig = { baseUrl: string; endpointPath?: string; clientId?: string; clientSecret?: string }

function sourceUrl(config?: VentanaCelesteConfig | null) { return config !== undefined ? (config ? new URL(config.endpointPath || '/', config.baseUrl).toString() : '') : process.env.VENTANA_CELESTE_KB_URL?.trim() || '' }
function safeError(error: unknown) { if (error instanceof Error && error.message.startsWith('http_')) return 'No se pudo conectar con Ventana Celeste.'; if (error instanceof Error && error.name === 'ZodError') return 'Ventana Celeste respondió, pero el contenido no cumple el formato esperado.'; return 'No se pudo consultar Ventana Celeste.' }
function parsePayload(raw: string, contentType: string | null): unknown {
  try { return JSON.parse(raw) } catch {
    const assignment = raw.match(/(?:(?:var|let|const)\s+[A-Za-z_$][\w$]*|window\.[A-Za-z_$][\w$]*)\s*=\s*([\[{])/)
    if (assignment?.index !== undefined) {
      const start = raw.indexOf(assignment[1], assignment.index)
      const open = raw[start]
      const close = open === '[' ? ']' : '}'
      let depth = 0
      let quote = ''
      let escaped = false
      for (let index = start; index < raw.length; index += 1) {
        const character = raw[index]
        if (quote) { if (escaped) escaped = false; else if (character === '\\\\') escaped = true; else if (character === quote) quote = ''; continue }
        if (character === '"' || character === "'") { quote = character; continue }
        if (character === open) depth += 1
        if (character === close) depth -= 1
        if (depth === 0) { const candidate = raw.slice(start, index + 1); try { return JSON.parse(candidate) } catch { break } }
      }
    }
    return raw
  }
}

let diagnostic: VentanaCelesteDiagnostic = { configured: Boolean(sourceUrl()), reachable: false, httpStatus: null, contentType: null, rawContentLength: 0, parsedItemCount: 0, lastFetchedAt: null, lastError: null }
export function getVentanaCelesteDiagnostic() { return { ...diagnostic, configured: Boolean(sourceUrl()) } }
export function getVentanaCelesteConnectionStatus() { return getVentanaCelesteDiagnostic() }

function beginDiagnostic() {
  diagnostic = { configured: true, reachable: false, httpStatus: null, contentType: null, rawContentLength: 0, parsedItemCount: 0, lastFetchedAt: null, lastError: null }
}

function recordResponse(status: number, contentType: string | null, rawContentLength: number) {
  diagnostic = { configured: true, reachable: status >= 200 && status < 300, httpStatus: status, contentType, rawContentLength, parsedItemCount: 0, lastFetchedAt: new Date().toISOString(), lastError: status >= 200 && status < 300 ? null : safeError(new Error(`http_${status}`)) }
}

function recordItems(count: number) {
  diagnostic = { ...diagnostic, parsedItemCount: count }
}

function recordFailure(error: unknown) {
  diagnostic = { ...diagnostic, reachable: diagnostic.httpStatus !== null && diagnostic.httpStatus >= 200 && diagnostic.httpStatus < 300, lastError: safeError(error) }
}

const VENTANA_CELESTE_CACHE_TTL_MS = 60_000
let cachedDefaultKnowledge: { expiresAt: number; records: ExternalKnowledgeRecord[] } | null = null
let defaultKnowledgeRequest: Promise<ExternalKnowledgeRecord[]> | null = null

export async function fetchVentanaCelesteKnowledge(): Promise<ExternalKnowledgeRecord[]> {
  if (cachedDefaultKnowledge && cachedDefaultKnowledge.expiresAt > Date.now()) return cachedDefaultKnowledge.records
  if (defaultKnowledgeRequest) return defaultKnowledgeRequest
  const request = (async () => {
    const url = sourceUrl()
    if (!url) { diagnostic = { configured: false, reachable: false, httpStatus: null, contentType: null, rawContentLength: 0, parsedItemCount: 0, lastFetchedAt: null, lastError: null }; throw new Error('not_configured') }
    beginDiagnostic()
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(url, { headers: { accept: 'application/json, text/javascript, text/plain' }, cache: 'no-store', signal: controller.signal })
      const contentType = response.headers.get('content-type')
      if (!response.ok) { recordResponse(response.status, contentType, 0); throw new Error(`http_${response.status}`) }
      const raw = await response.text(); recordResponse(response.status, contentType, raw.length)
      const parsed = parsePayload(raw, contentType); const items = typeof parsed === 'string' ? parseVentanaCelesteText(parsed) : parseVentanaCelesteImport(parsed)
      recordItems(items.length)
      cachedDefaultKnowledge = { expiresAt: Date.now() + VENTANA_CELESTE_CACHE_TTL_MS, records: items }
      if (process.env.NODE_ENV !== 'production') { console.log('[v0] VENTANA_CELESTE_FETCH', { configured: true, reachable: true, httpStatus: response.status, contentType, rawContentLength: raw.length, parsedItemCount: items.length, lastError: null }); for (const query of ['tarea', 'minuta', 'reunión', 'decisión', 'pendiente']) console.log('[v0] VENTANA_CELESTE_QUERY', { query, matchCount: items.filter((item) => `${item.title} ${item.content}`.toLocaleLowerCase().includes(query)).length }) }
      return items
    } catch (error) {
      recordFailure(error)
      if (process.env.NODE_ENV !== 'production') console.log('[v0] VENTANA_CELESTE_FETCH', { configured: true, reachable: diagnostic.reachable, httpStatus: diagnostic.httpStatus, contentType: diagnostic.contentType, rawContentLength: diagnostic.rawContentLength, parsedItemCount: diagnostic.parsedItemCount, lastError: diagnostic.lastError })
      throw error
    } finally { clearTimeout(timeout) }
  })()
  defaultKnowledgeRequest = request
  try { return await request } finally { if (defaultKnowledgeRequest === request) defaultKnowledgeRequest = null }
}

export class VentanaCelesteKnowledgeSource implements ExternalKnowledgeSource {
  constructor(private readonly config?: VentanaCelesteConfig | null) {}
  private url() { return sourceUrl(this.config) }
  private headers(): HeadersInit { const headers: Record<string, string> = {}; if (this.config?.clientId && this.config.clientSecret) { headers['CF-Access-Client-Id'] = this.config.clientId; headers['CF-Access-Client-Secret'] = this.config.clientSecret } return headers }
  private async fetchRecords() {
    const url = this.url()
    if (!url) { if (this.config === undefined) diagnostic = { configured: false, reachable: false, httpStatus: null, contentType: null, rawContentLength: 0, parsedItemCount: 0, lastFetchedAt: null, lastError: null }; throw new Error('not_configured') }
    const tracksDefaultSource = this.config === undefined
    if (tracksDefaultSource) beginDiagnostic()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(url, { headers: { accept: 'application/json, text/javascript, text/plain', ...this.headers() }, cache: 'no-store', signal: controller.signal })
      const contentType = response.headers.get('content-type')
      if (!response.ok) { if (tracksDefaultSource) recordResponse(response.status, contentType, 0); throw new Error(`http_${response.status}`) }
      const raw = await response.text()
      if (tracksDefaultSource) recordResponse(response.status, contentType, raw.length)
      const parsed = parsePayload(raw, contentType)
      const items = typeof parsed === 'string' ? parseVentanaCelesteText(parsed) : parseVentanaCelesteImport(parsed)
      if (tracksDefaultSource) recordItems(items.length)
      return items
    } catch (error) {
      if (tracksDefaultSource) recordFailure(error)
      throw error
    } finally { clearTimeout(timeout) }
  }
  async testConnection() { try { await this.fetchRecords(); return { status: 'connected' as const, message: 'Conectado.' } } catch (error) { const status = !this.url() ? 'not_configured' as const : 'error' as const; return { status, message: status === 'not_configured' ? 'No configurado.' : safeError(error) } } }
  async listAvailableContent() { return this.fetchRecords() }
  async importContent(items: ExternalKnowledgeRecord[]) { return { imported: items.length, updated: 0, duplicates: 0, errors: [] } }
}
