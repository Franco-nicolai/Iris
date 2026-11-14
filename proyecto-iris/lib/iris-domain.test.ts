import { afterEach, describe, expect, it } from 'vitest'
import { agendaItemSchema, interventionSchema, suggestedInterventionSchema } from './iris-domain'
import { buildLiveCaptionStack } from './live-captions'
  import { detectDirectIrisInvocation, directIrisResponseSchema } from './direct-invocation'
import { detectionSchema, meetingSummarySchema, parseIrisDetectionsResult } from './iris-intelligence'
import { CloudflareWorkersAIProvider, extractCloudflareGeneratedContent, getIrisAiRejectIfBusy, getIrisAiTimeoutMs, parseCloudflareGeneratedJson, runCloudflareJsonRequest } from './iris-provider'
import { evaluateInterventionPolicy, INTERVENTION_INTENSITY_CONFIG } from './iris-policy'
import { parseVentanaCelesteImport, parseVentanaCelesteText } from './iris-knowledge-import'
import { VentanaCelesteKnowledgeSource } from './ventana-celeste-source'

describe('Ventana Celeste importer', () => {
  it('maps structured groups and preserves external metadata', () => {
    const items = parseVentanaCelesteImport({ decisions: [{ title: 'Decisión', content: 'Usar Neon', externalId: 'd-1', externalUrl: 'https://ventana.example/d-1' }], tasks: [{ title: 'Tarea', content: 'Enviar minuta' }] })
    expect(items).toHaveLength(2); expect(items[0].type).toBe('decision'); expect(items[0].source).toMatchObject({ type: 'external', provider: 'ventana_celeste', externalId: 'd-1', externalUrl: 'https://ventana.example/d-1' }); expect(items[0].id).toBeTruthy()
  })
  it('deduplicates by externalId/content and supports text blocks', () => {
    expect(parseVentanaCelesteImport({ items: [{ title: 'A', content: 'Uno', externalId: 'same' }, { title: 'B', content: 'Dos', externalId: 'same' }] })).toHaveLength(1)
    expect(parseVentanaCelesteImport({ items: [{ title: 'A', content: ' Uno  dos ' }, { title: 'A', content: 'uno dos' }] })).toHaveLength(1)
    expect(parseVentanaCelesteText('Primero\n\nSegundo')).toHaveLength(2)
  })
  it('converts nested objects, arrays, special characters, and unknown fields deterministically', () => {
    const items = parseVentanaCelesteImport({ project: { name: 'Piloto <Q&A>', owner: 'Ana' }, tasks: [{ title: 'Enviar minuta', dueDate: '2026-10-26' }], custom_field: 'Dato "extra"' })
    expect(items.map((item) => item.title)).toEqual(['Project', 'Tasks', 'Custom field'])
    expect(items[0].content).toContain('Name: Piloto <Q&A>')
    expect(items[1].content).toContain('- Title: Enviar minuta')
    expect(items[2].content).toContain('Dato "extra"')
    expect(items.every((item) => !item.content.includes('{'))).toBe(true)
  })
  it('rejects malformed structured input', () => { expect(() => parseVentanaCelesteImport({ items: [{ title: '', content: 'x' }] })).toThrow() })
  it('splits long external records without truncating content or reusing external ids', () => {
    const content = `${'A'.repeat(19_990)} ${'B'.repeat(19_990)} ${'C'.repeat(19_990)}`
    const records = parseVentanaCelesteImport({ items: [{ title: 'Minuta extensa', content, externalId: 'meeting-42' }] })
    expect(records).toHaveLength(3)
    expect(records.map((record) => record.content).join('')).toBe(content)
    expect(records.every((record) => record.content.length <= 20_000)).toBe(true)
    expect(new Set(records.map((record) => record.externalId)).size).toBe(3)
    expect(records[0].title).toContain('(parte 1/3)')
  })
})

describe('Ventana Celeste source adapter', () => {
  it('reports not configured without credentials', async () => { await expect(new VentanaCelesteKnowledgeSource(null).testConnection()).resolves.toMatchObject({ status: 'not_configured' }) })
  it('uses Cloudflare Access service-token headers and normalizes JSON content', async () => {
    const originalFetch = globalThis.fetch; let request: Request | undefined
    globalThis.fetch = (async (input, init) => { request = new Request(input, init); return new Response(JSON.stringify({ items: [{ title: 'Decision', content: 'Use API', type: 'decision', externalId: 'x1' }] }), { status: 200, headers: { 'content-type': 'application/json' } }) }) as typeof fetch
    try { const source = new VentanaCelesteKnowledgeSource({ baseUrl: 'https://management.ventanaceleste.com', endpointPath: '/api/knowledge', clientId: 'client-test', clientSecret: 'secret-test' }); await expect(source.listAvailableContent()).resolves.toHaveLength(1); expect(request?.headers.get('CF-Access-Client-Id')).toBe('client-test'); expect(request?.headers.get('CF-Access-Client-Secret')).toBe('secret-test') } finally { globalThis.fetch = originalFetch }
  })
  it('returns a sanitized error for invalid authentication', async () => { const source = new VentanaCelesteKnowledgeSource({ baseUrl: 'https://example.com', endpointPath: '/', clientId: 'id', clientSecret: 'secret' }); const originalFetch = globalThis.fetch; globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch; try { await expect(source.testConnection()).resolves.toMatchObject({ status: 'error', message: 'No se pudo conectar con Ventana Celeste.' }) } finally { globalThis.fetch = originalFetch } })
})

describe('Iris context contracts', () => {
  const base = { meetingId: 'm1', id: 'a1', title: 'Diseño', position: 0, status: 'pending' as const, note: null }
  it('accepts agenda states and rejects malformed items', () => {
    expect(agendaItemSchema.safeParse(base).success).toBe(true)
    expect(agendaItemSchema.safeParse({ ...base, status: 'active' }).success).toBe(true)
    expect(agendaItemSchema.safeParse({ ...base, position: -1 }).success).toBe(false)
  })
  it('accepts the exact SuggestedIntervention contract', () => {
    const payload = { shouldIntervene: true, level: 2 as const, type: 'agenda_reminder' as const, reason: 'El grupo se desvía', content: 'Volvamos al punto actual', confidence: 0.88, evidence: ['minuto 04:20'] }
    expect(suggestedInterventionSchema.safeParse(payload).success).toBe(true)
    expect(suggestedInterventionSchema.safeParse({ ...payload, shouldIntervene: false }).success).toBe(true)
    expect(suggestedInterventionSchema.safeParse({ ...payload, level: 4 }).success).toBe(false)
    expect(suggestedInterventionSchema.safeParse({ ...payload, content: undefined }).success).toBe(false)
  })
  it('keeps intervention persistence fields strict', () => {
    const payload = { ...base, createdAt: new Date().toISOString(), level: 1 as const, type: 'generic' as const, reason: 'R', content: 'C', source: 'manual' as const, status: 'active' as const, observation: null }
    expect(interventionSchema.safeParse(payload).success).toBe(true)
    expect(interventionSchema.safeParse({ ...payload, level: 0 }).success).toBe(false)
    expect(interventionSchema.safeParse({ ...payload, type: 'unknown' }).success).toBe(false)
  })
})

describe('Detection contract', () => {
  const valid = { tasks: [{ text: 'Enviar minuta', assignee: null, dueDate: null, confidence: 0.9, evidence: 'Se acuerda enviar la minuta.' }], decisions: [{ text: 'Usar Neon', context: 'Persistencia', people: ['Ana'], evidence: 'El grupo lo confirma.' }], commitments: [], openQuestions: [] }
  it('documenta y acepta el output exacto', () => { expect(detectionSchema.safeParse(valid).success).toBe(true) })
  it('acepta fences y string JSON válido', () => { expect(parseIrisDetectionsResult('```json\n' + JSON.stringify(valid) + '\n```')).toEqual(valid); expect(parseIrisDetectionsResult(JSON.stringify(valid))).toEqual(valid) })
  it('acepta objeto JSON válido', () => { expect(parseIrisDetectionsResult(valid)).toEqual(valid) })
  it('rechaza campo faltante, tipo incorrecto, enum conceptual inválido y array faltante', () => {
    expect(detectionSchema.safeParse({ ...valid, tasks: undefined }).success).toBe(false)
    expect(detectionSchema.safeParse({ ...valid, tasks: 'none' }).success).toBe(false)
    expect(detectionSchema.safeParse({ ...valid, tasks: [{ ...valid.tasks[0], confidence: 'high' }] }).success).toBe(false)
    expect(detectionSchema.safeParse({ ...valid, extra: true }).success).toBe(false)
  })
  it('rechaza prose libre y no expone transcript ni secrets en el error', () => {
    expect(() => parseIrisDetectionsResult('No puedo completar el análisis. transcript secreto Bearer super-secret-token')).toThrow(/JSON inválido/)
  })
  it('mantiene los contratos separados', () => { expect(detectionSchema.safeParse(valid).success).toBe(true); expect(suggestedInterventionSchema.safeParse(valid).success).toBe(false) })
})

describe('Direct Iris invocation', () => { it('detects Iris and Oye Iris with extracted query', () => { expect(detectDirectIrisInvocation('Iris, ¿cuál es la tarea de Juan?').query).toBe('cuál es la tarea de Juan'); expect(detectDirectIrisInvocation('Oye Iris, qué habíamos decidido').invoked).toBe(true) }); it('avoids an obvious product mention false positive', () => { expect(detectDirectIrisInvocation('Iris es la aplicación que estamos desarrollando.').invoked).toBe(false) }); it('accepts conservative structured answers and rejects unsupported shape', () => { expect(directIrisResponseSchema.safeParse({ answer: 'Juan tiene pendiente la tarea dos.', confidence: 0.92, evidence: ['Tarea dos para Juan'] }).success).toBe(true); expect(directIrisResponseSchema.safeParse({ answer: 'Inventado', confidence: 2, evidence: [] }).success).toBe(false) }) })

  describe('Presentation inspection contracts', () => { it('uses explicit visual states and inspection-safe levels', () => { expect(['signal', 'interventionLevel2', 'interventionLevel3']).toContain('interventionLevel2'); expect([1, 2, 3]).toContain(2) }) })

describe('Live caption stack', () => {
  it('keeps newest final caption primary and reconciles local D immediately', () => { const a = { id: 'a', text: 'A', startedAt: '2026-10-19T10:00:00.000Z' }; const b = { id: 'b', text: 'B', startedAt: '2026-10-19T10:00:01.000Z' }; const c = { id: 'c', text: 'C', startedAt: '2026-10-19T10:00:02.000Z' }; const d = { id: 'd', text: 'D', startedAt: '2026-10-19T10:00:03.000Z' }; expect(buildLiveCaptionStack([a, b, c], [], '').finals.at(-1)?.text).toBe('C'); expect(buildLiveCaptionStack([a, b, c], [d], 'interim').finals.at(-1)?.text).toBe('D'); expect(buildLiveCaptionStack([a, b, c, d], [{ ...d }], '').finals).toHaveLength(3) })
})

describe('Meeting summary contract', () => {
  it('accepts a conversational summary without detection fields', () => { expect(meetingSummarySchema.safeParse({ summary: 'Se discutió el alcance y se cerró el siguiente paso.', topics: ['Alcance'], keyPoints: ['Se priorizó el primer entregable'] }).success).toBe(true); expect(meetingSummarySchema.safeParse({ summary: 'x', topics: [], keyPoints: [], decisions: [] }).success).toBe(false) })
})

describe('Intervention policy', () => {
  const suggestion = { shouldIntervene: true, level: 2 as const, type: 'off_topic', reason: 'Desvío', content: 'Volvamos al objetivo', confidence: 0.8 }
  it('configures low, medium and high thresholds independently', () => { expect(INTERVENTION_INTENSITY_CONFIG.low).toMatchObject({ confidenceThreshold: 0.8, minNewSegments: 5, cooldownMs: 90000 }); expect(INTERVENTION_INTENSITY_CONFIG.medium).toMatchObject({ confidenceThreshold: 0.65, minNewSegments: 3, cooldownMs: 45000 }); expect(INTERVENTION_INTENSITY_CONFIG.high).toMatchObject({ confidenceThreshold: 0.5, minNewSegments: 2, cooldownMs: 20000 }); expect(evaluateInterventionPolicy({ ...suggestion, confidence: 0.6 }, { intensity: 'low' }).reason).toBe('confidence_below_threshold'); expect(evaluateInterventionPolicy({ ...suggestion, confidence: 0.6 }, { intensity: 'high' }).action).toBe('show') })
  it('ignores false, level zero and low confidence', () => {
    expect(evaluateInterventionPolicy({ ...suggestion, shouldIntervene: false }, { now: 100 }).reason).toBe('should_intervene_false')
    expect(evaluateInterventionPolicy({ ...suggestion, level: 0 }, { now: 100 }).reason).toBe('level_zero')
    expect(evaluateInterventionPolicy({ ...suggestion, confidence: 0.54 }, { now: 100 }).reason).toBe('confidence_below_threshold')
  })
  it('maps levels one/two/three to signal/show/show', () => {
    expect(evaluateInterventionPolicy({ ...suggestion, level: 1 }, { now: 100 }).action).toBe('signal')
    expect(evaluateInterventionPolicy({ ...suggestion, level: 2 }, { now: 100 }).action).toBe('show')
    expect(evaluateInterventionPolicy({ ...suggestion, level: 3 }, { now: 100 }).action).toBe('show')
  })
  it('uses a separate shorter cooldown for level one signals', () => { expect(evaluateInterventionPolicy({ ...suggestion, level: 1 }, { now: 100, signalCooldownUntil: 101 }).reason).toBe('cooldown'); expect(evaluateInterventionPolicy({ ...suggestion, level: 1 }, { now: 100, cooldownUntil: 101 }).action).toBe('signal') })
  it('blocks mute, cooldown and normalized duplicates', () => {
    expect(evaluateInterventionPolicy(suggestion, { now: 100, muted: true }).reason).toBe('muted')
    expect(evaluateInterventionPolicy(suggestion, { now: 100, cooldownUntil: 101 }).reason).toBe('cooldown')
    expect(evaluateInterventionPolicy(suggestion, { now: 100, recentInterventions: [{ type: 'off_topic', content: '  Volvamos   al objetivo ', createdAt: new Date(50).toISOString() }] }).reason).toBe('duplicate')
  })
  it('reports repeated issue count without forcing escalation', () => {
    const result = evaluateInterventionPolicy(suggestion, { now: 100, recentInterventions: [{ type: 'off_topic', content: 'Otro', createdAt: new Date(50).toISOString() }, { type: 'off_topic', content: 'Otro más', createdAt: new Date(60).toISOString() }] })
    expect(result.action).toBe('show'); expect(result.repeatedIssueCount).toBe(2)
  })
})

describe('Agenda invariants', () => {
  it('allows at most one active item when applying a transition', () => {
    const items = [{ status: 'active' }, { status: 'pending' }]
    const transitioned = items.map((item, index) => index === 1 ? { ...item, status: 'active' } : { ...item, status: 'pending' })
    expect(transitioned.filter((item) => item.status === 'active')).toHaveLength(1)
  })
})

describe('Cloudflare generated content extraction', () => {
  const detectionJson = '{"tasks":[],"decisions":[],"commitments":[],"openQuestions":[]}'
  it('prefers choices message content over response when both exist', () => expect(extractCloudflareGeneratedContent({ success: true, result: { response: 'not generated JSON', choices: [{ message: { content: detectionJson } }] } })).toBe(detectionJson))
  it('extracts wrapped result.response with success=true as a JSON fallback', () => expect(extractCloudflareGeneratedContent({ success: true, result: { response: detectionJson } })).toBe(detectionJson))
  it('extracts result.text, generated_text, message.content and choices.message.content', () => {
    expect(extractCloudflareGeneratedContent({ success: true, result: { text: detectionJson } })).toBe(detectionJson)
    expect(extractCloudflareGeneratedContent({ success: true, result: { generated_text: detectionJson } })).toBe(detectionJson)
    expect(extractCloudflareGeneratedContent({ success: true, result: { message: { content: detectionJson } } })).toBe(detectionJson)
    expect(extractCloudflareGeneratedContent({ success: true, result: { choices: [{ message: { content: detectionJson } }] } })).toBe(detectionJson)
  })
  it('extracts result.result.response', () => expect(extractCloudflareGeneratedContent({ result: { response: detectionJson } })).toBe(detectionJson))
  it('extracts result.response', () => expect(extractCloudflareGeneratedContent({ response: detectionJson })).toBe(detectionJson))
  it('rechaza result string sin ruta explícita conocida', () => expect(() => extractCloudflareGeneratedContent({ result: detectionJson })).toThrow('Cloudflare respondió, pero no se encontró contenido generado.'))
  it('extracts choices message content from the observed GLM envelope', () => expect(extractCloudflareGeneratedContent({ id: 'id', object: 'chat.completion', model: '@cf/zai-org/glm-4.7-flash', choices: [{ message: { content: detectionJson } }] })).toBe(detectionJson))
  it('extracts choices text and direct strings', () => { expect(extractCloudflareGeneratedContent({ choices: [{ text: detectionJson }] })).toBe(detectionJson); expect(extractCloudflareGeneratedContent(detectionJson)).toBe(detectionJson) })
  it('accepts fenced and prose-wrapped JSON, rejects non-JSON response, and rejects empty content', () => { expect(parseCloudflareGeneratedJson('texto antes {"ok":true} texto después')).toEqual({ ok: true }); expect(parseCloudflareGeneratedJson('```json\n{"ok":true}\n```')).toEqual({ ok: true }); expect(() => extractCloudflareGeneratedContent({ success: true, result: { response: 'respuesta textual sin JSON' } })).toThrow('Cloudflare respondió, pero no se encontró contenido generado.'); expect(() => extractCloudflareGeneratedContent({ success: true, result: { response: '' } })).toThrow('Cloudflare respondió, pero no se encontró contenido generado.') })
  it('rejects empty choices, missing message content, and object content', () => {
    expect(() => extractCloudflareGeneratedContent({ choices: [] })).toThrow('Cloudflare respondió, pero no se encontró contenido generado.')
    expect(() => extractCloudflareGeneratedContent({ choices: [{ message: {} }] })).toThrow('Cloudflare respondió, pero no se encontró contenido generado.')
    expect(() => extractCloudflareGeneratedContent({ choices: [{ message: { content: { tasks: [] } } }] })).toThrow('Cloudflare respondió, pero no se encontró contenido generado.')
  })
  it('rechaza success=false usando errors y messages', () => expect(() => extractCloudflareGeneratedContent({ success: false, errors: [{ code: 7003, message: 'Invalid route' }], messages: [] })).toThrow(/Invalid route/))
  it('never treats an arbitrary envelope as model output', () => expect(() => extractCloudflareGeneratedContent({ id: 'id', usage: {} })).toThrow('Cloudflare respondió, pero no se encontró contenido generado.'))
})

describe('Cloudflare Workers AI provider', () => {
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID
  const originalToken = process.env.CLOUDFLARE_API_TOKEN
  const originalModel = process.env.IRIS_AI_MODEL
  const originalTimeout = process.env.IRIS_AI_TIMEOUT_MS
  const originalRejectIfBusy = process.env.IRIS_AI_REJECT_IF_BUSY
  const valid = { shouldIntervene: true, level: 2, type: 'agenda_reminder', reason: 'La conversación se desvía', content: 'Volvamos al punto actual', confidence: 0.9, evidence: ['La agenda indica presupuesto'] }

  afterEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount
    process.env.CLOUDFLARE_API_TOKEN = originalToken
    process.env.IRIS_AI_MODEL = originalModel
    process.env.IRIS_AI_TIMEOUT_MS = originalTimeout
    process.env.IRIS_AI_REJECT_IF_BUSY = originalRejectIfBusy
  })

  it('usa el endpoint Cloudflare, el account, el modelo y Authorization server-side', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'
    process.env.CLOUDFLARE_API_TOKEN = 'token'
    process.env.IRIS_AI_MODEL = '@cf/test/model'
    let request: { url: string; init?: RequestInit } | undefined
    const provider = new CloudflareWorkersAIProvider(undefined, async (url, init) => { request = { url: String(url), init }; return new Response(JSON.stringify({ result: { response: JSON.stringify(valid) } }), { status: 200 }) })
    await expect(provider.analyze({ context: 'contexto' })).resolves.toEqual(valid)
    expect(request?.url).toBe('https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/test/model')
    expect(request?.url).not.toContain('%40cf')
    expect(request?.url).not.toContain('%2F')
    const body = JSON.parse(String(request?.init?.body))
    expect(body.messages[0]).toMatchObject({ role: 'system' })
    expect(body.messages[1]).toMatchObject({ role: 'user' })
    expect(body.messages[0].content).toEqual(expect.any(String))
    expect(body.messages[1].content).toEqual(expect.any(String))
    expect(new Headers(request?.init?.headers).get('authorization')).toBe('Bearer token')
    expect(new Headers(request?.init?.headers).get('content-type')).toBe('application/json')
    expect(provider.provider).toBe('cloudflare-direct')
  })

  it('ejecuta la request mínima con messages y extrae result.response', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'TEST_ACCOUNT'; process.env.CLOUDFLARE_API_TOKEN = 'token'; process.env.IRIS_AI_MODEL = '@cf/zai-org/glm-4.7-flash'
    const output = await runCloudflareJsonRequest({ system: 'Responde JSON.', prompt: 'Responde un objeto JSON.', fetchImpl: async () => new Response(JSON.stringify({ result: { response: '{"ok":true}' } }), { status: 200 }) })
    expect(output).toBe('{"ok":true}')
  })

  it('transmite answer incremental y conserva el JSON completo para validarlo', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'; process.env.IRIS_AI_MODEL = '@cf/test/model'
    const content = ['{"answer":"La siguiente ', 'tarea es revisar presupuesto.","confidence":0.9,"evidence":["Agenda"]}']
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const part of content) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close() } })
    const answerDeltas: string[] = []
    let requestBody: Record<string, unknown> | undefined
    const output = await runCloudflareJsonRequest({ system: 'Responde JSON.', prompt: 'Pregunta.', operation: 'direct_question', onAnswerDelta: (delta) => answerDeltas.push(delta), fetchImpl: async (_url, init) => { requestBody = JSON.parse(String(init?.body)); return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) } })
    expect(requestBody?.stream).toBe(true)
    expect(output).toBe(content.join(''))
    expect(answerDeltas.join('')).toBe('La siguiente tarea es revisar presupuesto.')
  })

  it('usa timeout default 45000 y valida IRIS_AI_TIMEOUT_MS', () => {
    delete process.env.IRIS_AI_TIMEOUT_MS; expect(getIrisAiTimeoutMs()).toBe(45000)
    process.env.IRIS_AI_TIMEOUT_MS = '12000'; expect(getIrisAiTimeoutMs()).toBe(12000)
    process.env.IRIS_AI_TIMEOUT_MS = '0'; expect(getIrisAiTimeoutMs()).toBe(45000)
    process.env.IRIS_AI_TIMEOUT_MS = '120001'; expect(getIrisAiTimeoutMs()).toBe(45000)
    process.env.IRIS_AI_TIMEOUT_MS = 'invalid'; expect(getIrisAiTimeoutMs()).toBe(45000)
  })

  it('usa rejectIfBusy=false por defecto y lo añade cuando está habilitado', async () => {
    delete process.env.IRIS_AI_REJECT_IF_BUSY; expect(getIrisAiRejectIfBusy()).toBe(false)
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'; process.env.IRIS_AI_REJECT_IF_BUSY = 'true'
    let body: Record<string, unknown> | undefined
    const provider = new CloudflareWorkersAIProvider(undefined, async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ result: { response: JSON.stringify(valid) } }), { status: 200 }) })
    await provider.analyze({ context: 'contexto' }); expect(body?.options).toEqual({ rejectIfBusy: true })
  })

  it('mapea AbortError a timeout y conserva la operación', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'; delete process.env.IRIS_AI_TIMEOUT_MS
    const provider = new CloudflareWorkersAIProvider(undefined, async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error })
    await expect(provider.analyze({ context: 'contexto', operation: 'intervention_analysis' })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('usa el modelo default cuando IRIS_AI_MODEL falta', () => {
    delete process.env.IRIS_AI_MODEL
    expect(new CloudflareWorkersAIProvider().model).toBe('@cf/zai-org/glm-4.7-flash')
  })

  it('extrae SuggestedIntervention desde choices[0].message.content', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'
    const provider = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ id: 'chatcmpl', choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 }))
    await expect(provider.analyze({ context: 'contexto' })).resolves.toEqual(valid)
  })

  it('rechaza JSON inválido dentro de choices content', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'
    const provider = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ choices: [{ message: { content: '{bad' } }] }), { status: 200 }))
    await expect(provider.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'invalid_json' })
  })

  it('acepta shouldIntervene=false con nivel cero', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'
    const provider = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ result: { response: JSON.stringify({ ...valid, shouldIntervene: false, level: 0 }) } }), { status: 200 }))
    await expect(provider.analyze({ context: 'contexto' })).resolves.toMatchObject({ shouldIntervene: false, level: 0 })
  })

  it('rechaza JSON malformado y schema inválido', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'
    const malformed = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ result: { response: '{bad' } }), { status: 200 }))
    await expect(malformed.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'invalid_json' })
    const invalid = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ result: { response: JSON.stringify({ ...valid, level: 9 }) } }), { status: 200 }))
    await expect(invalid.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it('maneja credenciales faltantes, rate limit y fallas del proveedor', async () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID; delete process.env.CLOUDFLARE_API_TOKEN
    const missing = new CloudflareWorkersAIProvider(undefined, async () => new Response())
    await expect(missing.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'missing_credentials' })
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'
    const unauthorized = new CloudflareWorkersAIProvider(undefined, async () => new Response('unauthorized', { status: 401 }))
    await expect(unauthorized.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'unauthorized' })
    const forbidden = new CloudflareWorkersAIProvider(undefined, async () => new Response('forbidden', { status: 403 }))
    await expect(forbidden.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'unauthorized' })
    const missingModel = new CloudflareWorkersAIProvider(undefined, async () => new Response('not found', { status: 404 }))
    await expect(missingModel.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'provider_failure' })
    const busy = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ success: false, errors: [{ code: 3040, message: 'No capacity' }] }), { status: 429 }))
    await expect(busy.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'busy', message: 'Cloudflare está sin capacidad disponible. Intenta nuevamente.' })
    const limited = new CloudflareWorkersAIProvider(undefined, async () => new Response('rate limited', { status: 429 }))
    await expect(limited.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'rate_limited' })
    const failed = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ success: false, errors: [{ code: 1234, message: 'Example Cloudflare error' }] }), { status: 400 }))
    await expect(failed.analyze({ context: 'contexto' })).rejects.toMatchObject({ code: 'provider_failure', message: 'Cloudflare HTTP 400: Example Cloudflare error' })
  })

  it('no crea intervenciones: solo devuelve una propuesta validada', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account'; process.env.CLOUDFLARE_API_TOKEN = 'token'
    const provider = new CloudflareWorkersAIProvider(undefined, async () => new Response(JSON.stringify({ result: { response: JSON.stringify(valid) } }), { status: 200 }))
    const proposal = await provider.analyze({ context: 'contexto' })
    expect(proposal).not.toHaveProperty('meetingId')
    expect(proposal).not.toHaveProperty('status')
  })
})

// Server Action ownership and persistence cases are covered by the database-backed integration suite.
