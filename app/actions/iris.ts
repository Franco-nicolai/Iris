'use server'

import { db } from '@/lib/db'
import { requireIrisUserId } from '@/lib/iris-session'
import { decisions, interventions, knowledgeItems, meetingAgendaItems, meetings, meetingSummaries, suggestions, tasks, transcriptSegments } from '@/lib/db/schema'
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { analyzeMeetingForIntervention, answerIrisMeetingQuestion, detectionKey, extractIrisDetections, generateMeetingSummary, IntelligenceProviderError, suggestMeetingAgenda } from '@/lib/iris-intelligence'
import { createMeetingIntelligenceProvider, getIrisRuntimeDiagnostics } from '@/lib/iris-provider'
import { parseVentanaCelesteImport, parseVentanaCelesteText, type ParsedExternalKnowledge } from '@/lib/iris-knowledge-import'
import { VentanaCelesteKnowledgeSource, getVentanaCelesteConnectionStatus } from '@/lib/ventana-celeste-source'

const idSchema = z.string().trim().min(1).max(512)
const meetingInput = z.object({ id: idSchema, title: z.string().trim().min(1).max(200), objective: z.string().trim().max(1000).default(''), contextNotes: z.string().trim().max(5000).nullable().default(null), startedAt: z.coerce.date(), endedAt: z.coerce.date().nullable().optional(), status: z.enum(['scheduled', 'live', 'paused', 'ended']), participantNames: z.array(z.string().trim().min(1).max(120)).max(100) })
const meetingContextInput = z.object({ id: idSchema, objective: z.string().trim().max(1000), contextNotes: z.string().trim().max(5000).nullable() })
const suggestedInterventionSchema = z.object({ shouldIntervene: z.boolean(), level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), type: z.enum(['agenda_reminder', 'off_topic', 'previous_decision', 'pending_task', 'unresolved_question', 'time_warning', 'generic']), reason: z.string().min(1).max(1000), content: z.string().min(1).max(1000), confidence: z.number().min(0).max(1), evidence: z.array(z.string().min(1)).max(10) })
const segmentInput = z.object({ id: idSchema, meetingId: idSchema, speaker: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(10000), startedAt: z.coerce.date(), endedAt: z.coerce.date(), isFinal: z.boolean().optional() })
const taskInput = z.object({ id: idSchema, meetingId: idSchema, text: z.string().trim().min(1).max(1000), assignee: z.string().trim().max(200).nullable(), dueDate: z.coerce.date().nullable(), status: z.enum(['open', 'done']) })
const taskUpdate = taskInput.omit({ id: true, meetingId: true }).partial()
const decisionInput = z.object({ id: idSchema, meetingId: idSchema, text: z.string().trim().min(1).max(2000), status: z.enum(['draft', 'confirmed', 'dismissed']), confirmedByUser: z.boolean() })
const suggestionUpdate = z.object({ id: idSchema, status: z.enum(['proposed', 'accepted', 'edited', 'dismissed']) })
const agendaInput = z.object({ id: idSchema, meetingId: idSchema, title: z.string().trim().min(1).max(200), position: z.number().int().nonnegative(), status: z.enum(['pending', 'active', 'completed']), note: z.string().trim().max(500).nullable() })
const agendaUpdate = z.object({ id: idSchema, meetingId: idSchema, changes: agendaInput.omit({ id: true, meetingId: true }).partial() })
const interventionInput = z.object({ id: idSchema, meetingId: idSchema, level: z.union([z.literal(1), z.literal(2), z.literal(3)]), type: z.enum(['agenda_reminder', 'off_topic', 'previous_decision', 'pending_task', 'unresolved_question', 'time_warning', 'generic']), reason: z.string().trim().min(1).max(1000), content: z.string().trim().min(1).max(1000), source: z.enum(['manual', 'ai']).default('manual') })

const requireUserId = requireIrisUserId

async function assertMeeting(userId: string, meetingId: string) {
  const [meeting] = await db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
  if (!meeting) throw new Error('Meeting not found')
  return meeting
}

export async function getIrisAnalyticsAction(input: unknown) {
  const userId = await requireUserId()
  const meetingId = idSchema.parse(input)
  await assertMeeting(userId, meetingId)
  const meetingScope = and(eq(meetings.userId, userId), eq(meetings.id, meetingId))
  const [meetingRows, interventionRows, suggestionRows, segmentRows, decisionRows, taskRows, summaryRows] = await Promise.all([
    db.select({ id: meetings.id, title: meetings.title, status: meetings.status, startedAt: meetings.startedAt, endedAt: meetings.endedAt }).from(meetings).where(meetingScope),
    db.select({ id: interventions.id, meetingId: interventions.meetingId, level: interventions.level, type: interventions.type, reason: interventions.reason, content: interventions.content, observation: interventions.observation, status: interventions.status, source: interventions.source, createdAt: interventions.createdAt }).from(interventions).where(and(eq(interventions.userId, userId), eq(interventions.meetingId, meetingId))).orderBy(asc(interventions.createdAt)),
    db.select({ id: suggestions.id, meetingId: suggestions.meetingId, category: suggestions.category, status: suggestions.status }).from(suggestions).where(and(eq(suggestions.userId, userId), eq(suggestions.meetingId, meetingId))),
    db.select({ meetingId: transcriptSegments.meetingId, startedAt: transcriptSegments.startedAt, endedAt: transcriptSegments.endedAt, isFinal: transcriptSegments.isFinal }).from(transcriptSegments).where(and(eq(transcriptSegments.userId, userId), eq(transcriptSegments.meetingId, meetingId))),
    db.select({ meetingId: decisions.meetingId, status: decisions.status, confirmedByUser: decisions.confirmedByUser }).from(decisions).where(and(eq(decisions.userId, userId), eq(decisions.meetingId, meetingId))),
    db.select({ meetingId: tasks.meetingId, status: tasks.status }).from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.meetingId, meetingId))),
    db.select({ meetingId: meetingSummaries.meetingId, provider: meetingSummaries.provider, model: meetingSummaries.model, generatedAt: meetingSummaries.generatedAt }).from(meetingSummaries).where(and(eq(meetingSummaries.userId, userId), eq(meetingSummaries.meetingId, meetingId))),
  ])
  return { meetings: meetingRows, interventions: interventionRows, suggestions: suggestionRows, segments: segmentRows, decisions: decisionRows, tasks: taskRows, summaries: summaryRows }
}

export async function getIrisAnalyticsOverviewAction() {
  const userId = await requireUserId()
  const meetingRows = await db.select({ id: meetings.id, title: meetings.title, status: meetings.status, startedAt: meetings.startedAt, endedAt: meetings.endedAt }).from(meetings).where(eq(meetings.userId, userId)).orderBy(desc(meetings.startedAt)).limit(100)
  const meetingIds = meetingRows.map((meeting) => meeting.id)
  if (!meetingIds.length) return { meetings: meetingRows, interventions: [], suggestions: [], segments: [], decisions: [], tasks: [], summaries: [] }
  const [interventionRows, suggestionRows, segmentRows, decisionRows, taskRows, summaryRows] = await Promise.all([
    db.select({ id: interventions.id, meetingId: interventions.meetingId, level: interventions.level, type: interventions.type, reason: interventions.reason, content: interventions.content, observation: interventions.observation, status: interventions.status, source: interventions.source, createdAt: interventions.createdAt }).from(interventions).where(and(eq(interventions.userId, userId), inArray(interventions.meetingId, meetingIds))).orderBy(desc(interventions.createdAt)),
    db.select({ meetingId: suggestions.meetingId, category: suggestions.category, status: suggestions.status }).from(suggestions).where(and(eq(suggestions.userId, userId), inArray(suggestions.meetingId, meetingIds))),
    db.select({ meetingId: transcriptSegments.meetingId, startedAt: transcriptSegments.startedAt, endedAt: transcriptSegments.endedAt, isFinal: transcriptSegments.isFinal }).from(transcriptSegments).where(and(eq(transcriptSegments.userId, userId), inArray(transcriptSegments.meetingId, meetingIds))),
    db.select({ meetingId: decisions.meetingId, status: decisions.status, confirmedByUser: decisions.confirmedByUser }).from(decisions).where(and(eq(decisions.userId, userId), inArray(decisions.meetingId, meetingIds))),
    db.select({ meetingId: tasks.meetingId, status: tasks.status }).from(tasks).where(and(eq(tasks.userId, userId), inArray(tasks.meetingId, meetingIds))),
    db.select({ meetingId: meetingSummaries.meetingId, provider: meetingSummaries.provider, model: meetingSummaries.model, generatedAt: meetingSummaries.generatedAt }).from(meetingSummaries).where(and(eq(meetingSummaries.userId, userId), inArray(meetingSummaries.meetingId, meetingIds))),
  ])
  return { meetings: meetingRows, interventions: interventionRows, suggestions: suggestionRows, segments: segmentRows, decisions: decisionRows, tasks: taskRows, summaries: summaryRows }
}

export async function suggestMeetingAgendaAction(input: unknown) {
  const userId = await requireUserId()
  const data = z.object({ title: z.string().trim().min(1).max(200), objective: z.string().trim().max(1000), contextNotes: z.string().trim().max(5000) }).parse(input)
  const [previousMeetings, pendingTasks, relevantDecisions, knowledge] = await Promise.all([
    db.select({ title: meetings.title, objective: meetings.objective, status: meetings.status }).from(meetings).where(eq(meetings.userId, userId)).orderBy(desc(meetings.createdAt)).limit(8),
    db.select({ text: tasks.text, assignee: tasks.assignee }).from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.status, 'open'))).orderBy(desc(tasks.id)).limit(8),
    db.select({ text: decisions.text }).from(decisions).where(and(eq(decisions.userId, userId), eq(decisions.status, 'confirmed'))).limit(8),
    db.select({ title: knowledgeItems.title, content: knowledgeItems.content }).from(knowledgeItems).where(and(eq(knowledgeItems.userId, userId), eq(knowledgeItems.validity, 'current'))).orderBy(desc(knowledgeItems.sourceDate)).limit(12),
  ])
  const terms = `${data.title} ${data.objective} ${data.contextNotes}`.toLocaleLowerCase().split(/[^a-záéíóúüñ0-9]+/).filter((term) => term.length > 3)
  const score = (item: { title?: string; content?: string }) => terms.filter((term) => `${item.title || ''} ${item.content || ''}`.toLocaleLowerCase().includes(term)).length
  const internalKnowledge = knowledge.map((item) => ({ ...item, score: score(item) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map(({ title, content }) => ({ title, content }))
  let ventanaCeleste: Array<{ title: string; content: string }> = []
  let ventanaCelesteParsedItems = 0
  let ventanaCelesteSelectedItems = 0
  try { const external = await new VentanaCelesteKnowledgeSource().listAvailableContent(); ventanaCelesteParsedItems = external.length; const ranked = external.map((item, index) => ({ title: item.title, content: item.content, score: score(item), index })).sort((a, b) => b.score - a.score || a.index - b.index); const matched = ranked.filter((item) => item.score > 0); const selected = (matched.length > 0 ? matched : ranked).slice(0, 6); ventanaCelesteSelectedItems = selected.length; ventanaCeleste = selected.map(({ title, content }) => ({ title, content })) } catch { ventanaCeleste = [] }
  if (process.env.NODE_ENV !== 'production') console.log('[v0] AGENDA_SUGGESTION_CONTEXT', { previousMeetingsCount: previousMeetings.length, internalKnowledgeCount: internalKnowledge.length, ventanaCelesteAvailable: ventanaCelesteParsedItems > 0, ventanaCelesteContextLength: ventanaCeleste.reduce((total, item) => total + item.content.length, 0), ventanaCelesteParsedItems, ventanaCelesteSelectedItems })
  if (process.env.NODE_ENV !== 'production') console.log('[v0] VENTANA_CELESTE_RETRIEVAL', { parsedItemCount: ventanaCelesteParsedItems, candidateCount: ventanaCelesteParsedItems, selectedItemCount: ventanaCelesteSelectedItems, sourceTypes: ventanaCelesteSelectedItems > 0 ? ['ventana_celeste'] : [] })
  return suggestMeetingAgenda({ ...data, previousMeetings, pendingTasks, relevantDecisions, internalKnowledge, ventanaCeleste })
}

export async function saveMeeting(input: unknown) {
  const userId = await requireUserId()
  const data = meetingInput.parse(input)
  await db.insert(meetings).values({ ...data, userId, endedAt: data.endedAt ?? null }).onConflictDoUpdate({ target: meetings.id, set: { title: data.title, objective: data.objective, contextNotes: data.contextNotes, endedAt: data.endedAt ?? null, status: data.status, participantNames: data.participantNames }, where: eq(meetings.userId, userId) })
  revalidatePath('/')
}

export async function saveMeetingContext(input: unknown) {
  const userId = await requireUserId()
  const data = meetingContextInput.parse(input)
  await assertMeeting(userId, data.id)
  await db.update(meetings).set({ objective: data.objective, contextNotes: data.contextNotes }).where(and(eq(meetings.id, data.id), eq(meetings.userId, userId)))
  revalidatePath('/')
}

export async function saveTranscriptSegment(input: unknown) {
  const userId = await requireUserId()
  const data = segmentInput.parse(input)
  await assertMeeting(userId, data.meetingId)
  await db.insert(transcriptSegments).values({ ...data, userId, isFinal: data.isFinal ?? true }).onConflictDoNothing()
  revalidatePath('/')
}

export async function saveTask(input: unknown) {
  const userId = await requireUserId()
  const data = taskInput.parse(input)
  await assertMeeting(userId, data.meetingId)
  await db.insert(tasks).values({ ...data, userId }).onConflictDoUpdate({ target: tasks.id, set: { text: data.text, assignee: data.assignee, dueDate: data.dueDate, status: data.status }, where: eq(tasks.userId, userId) })
  revalidatePath('/')
}

export async function updateTask(input: unknown) {
  const userId = await requireUserId()
  const data = z.object({ id: idSchema, meetingId: idSchema, changes: taskUpdate }).parse(input)
  await assertMeeting(userId, data.meetingId)
  await db.update(tasks).set(data.changes).where(and(eq(tasks.id, data.id), eq(tasks.meetingId, data.meetingId), eq(tasks.userId, userId)))
  const [knowledge] = await db.select({ id: knowledgeItems.id, content: knowledgeItems.content }).from(knowledgeItems).where(and(eq(knowledgeItems.id, `${data.id}-knowledge`), eq(knowledgeItems.userId, userId)))
  if (knowledge) { const changes = data.changes as { text?: string; assignee?: string | null; dueDate?: Date | null; status?: string }; await db.update(knowledgeItems).set({ content: `${changes.text ?? knowledge.content}${changes.assignee ? ` · Responsable: ${changes.assignee}` : ''}${changes.dueDate ? ` · Fecha: ${changes.dueDate.toISOString()}` : ''}${changes.status ? ` · Estado: ${changes.status}` : ''}` }).where(and(eq(knowledgeItems.id, knowledge.id), eq(knowledgeItems.userId, userId))) }
  revalidatePath('/')
}

export async function deleteTask(input: unknown) {
  const userId = await requireUserId()
  const data = z.object({ id: idSchema, meetingId: idSchema }).parse(input)
  await assertMeeting(userId, data.meetingId)
  await db.delete(tasks).where(and(eq(tasks.id, data.id), eq(tasks.meetingId, data.meetingId), eq(tasks.userId, userId)))
  revalidatePath('/')
}

export async function saveDecision(input: unknown) {
  const userId = await requireUserId()
  const data = decisionInput.parse(input)
  await assertMeeting(userId, data.meetingId)
  await db.insert(decisions).values({ ...data, userId }).onConflictDoUpdate({ target: decisions.id, set: { text: data.text, status: data.status, confirmedByUser: data.confirmedByUser }, where: eq(decisions.userId, userId) })
  revalidatePath('/')
}

export async function updateSuggestion(input: unknown) {
  const userId = await requireUserId()
  const data = suggestionUpdate.parse(input)
  await db.update(suggestions).set({ status: data.status }).where(and(eq(suggestions.id, data.id), eq(suggestions.userId, userId)))
  revalidatePath('/')
}

export async function deleteMeeting(input: unknown) {
  const userId = await requireUserId()
  const meetingId = idSchema.parse(input)
  await assertMeeting(userId, meetingId)
  await db.transaction(async (tx) => {
    await tx.delete(transcriptSegments).where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.userId, userId)))
    await tx.delete(interventions).where(and(eq(interventions.meetingId, meetingId), eq(interventions.userId, userId)))
    await tx.delete(meetingAgendaItems).where(and(eq(meetingAgendaItems.meetingId, meetingId), eq(meetingAgendaItems.userId, userId)))
    await tx.delete(suggestions).where(and(eq(suggestions.meetingId, meetingId), eq(suggestions.userId, userId)))
    await tx.delete(decisions).where(and(eq(decisions.meetingId, meetingId), eq(decisions.userId, userId)))
    await tx.delete(tasks).where(and(eq(tasks.meetingId, meetingId), eq(tasks.userId, userId)))
    await tx.delete(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
  })
  revalidatePath('/')
}

export async function listUserMeetings() {
  const userId = await requireUserId()
  return db.select().from(meetings).where(eq(meetings.userId, userId))
}

export async function listMeetingData(input: unknown) {
  const userId = await requireUserId()
  const meetingId = idSchema.parse(input)
  await assertMeeting(userId, meetingId)
  const [meeting, segments, meetingSuggestions, meetingDecisions, meetingTasks, agenda, meetingInterventions, persistedSummary] = await Promise.all([
    db.select({ title: meetings.title, status: meetings.status, objective: meetings.objective, contextNotes: meetings.contextNotes }).from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId))),
    db.select().from(transcriptSegments).where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.userId, userId))),
    db.select().from(suggestions).where(and(eq(suggestions.meetingId, meetingId), eq(suggestions.userId, userId))),
    db.select().from(decisions).where(and(eq(decisions.meetingId, meetingId), eq(decisions.userId, userId))),
    db.select().from(tasks).where(and(eq(tasks.meetingId, meetingId), eq(tasks.userId, userId))),
    db.select().from(meetingAgendaItems).where(and(eq(meetingAgendaItems.meetingId, meetingId), eq(meetingAgendaItems.userId, userId))),
    db.select().from(interventions).where(and(eq(interventions.meetingId, meetingId), eq(interventions.userId, userId))),
  db.select().from(meetingSummaries).where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.userId, userId))),
  ])
  return { meeting: meeting[0], segments, suggestions: meetingSuggestions, decisions: meetingDecisions, tasks: meetingTasks, agenda, interventions: meetingInterventions, summary: persistedSummary[0] ?? null }
}

export async function saveAgendaItem(input: unknown) {
  const userId = await requireUserId()
  const data = agendaInput.parse(input)
  await assertMeeting(userId, data.meetingId)
  await db.transaction(async (tx) => {
    if (data.status === 'active') await tx.update(meetingAgendaItems).set({ status: 'pending' }).where(and(eq(meetingAgendaItems.meetingId, data.meetingId), eq(meetingAgendaItems.userId, userId)))
    await tx.insert(meetingAgendaItems).values({ ...data, userId }).onConflictDoUpdate({ target: meetingAgendaItems.id, set: { title: data.title, position: data.position, status: data.status, note: data.note }, where: eq(meetingAgendaItems.userId, userId) })
  })
  revalidatePath('/')
}

export async function deleteAgendaItem(input: unknown) {
  const userId = await requireUserId(); const data = z.object({ id: idSchema, meetingId: idSchema }).parse(input); await assertMeeting(userId, data.meetingId)
  await db.delete(meetingAgendaItems).where(and(eq(meetingAgendaItems.id, data.id), eq(meetingAgendaItems.meetingId, data.meetingId), eq(meetingAgendaItems.userId, userId))); revalidatePath('/')
}

export async function updateAgendaItem(input: unknown) {
  const userId = await requireUserId(); const data = agendaUpdate.parse(input); await assertMeeting(userId, data.meetingId)
  await db.transaction(async (tx) => {
    if (data.changes.status === 'active') await tx.update(meetingAgendaItems).set({ status: 'pending' }).where(and(eq(meetingAgendaItems.meetingId, data.meetingId), eq(meetingAgendaItems.userId, userId)))
    await tx.update(meetingAgendaItems).set(data.changes).where(and(eq(meetingAgendaItems.id, data.id), eq(meetingAgendaItems.meetingId, data.meetingId), eq(meetingAgendaItems.userId, userId)))
  }); revalidatePath('/')
}

export async function createIntervention(input: unknown) {
  const userId = await requireUserId(); const data = interventionInput.parse(input); await assertMeeting(userId, data.meetingId)
  await db.insert(interventions).values({ ...data, userId, status: 'active' }).onConflictDoNothing({ target: interventions.id }); revalidatePath('/'); return data.id
}

export async function closeIntervention(input: unknown) {
  const userId = await requireUserId(); const data = z.object({ id: idSchema, meetingId: idSchema, status: z.enum(['closed', 'muted']), observation: z.string().trim().max(2000).nullable().optional() }).parse(input); await assertMeeting(userId, data.meetingId)
  await db.update(interventions).set({ status: data.status, observation: data.observation ?? null }).where(and(eq(interventions.id, data.id), eq(interventions.meetingId, data.meetingId), eq(interventions.userId, userId))); revalidatePath('/')
}

export async function listInterventions(input: unknown) {
  const userId = await requireUserId(); const meetingId = idSchema.parse(input); await assertMeeting(userId, meetingId)
  return db.select().from(interventions).where(and(eq(interventions.meetingId, meetingId), eq(interventions.userId, userId)))
}

const knowledgeType = z.enum(['context', 'minute', 'decision', 'task', 'agreement', 'commitment', 'open_question', 'note', 'other'])
const knowledgeInput = z.object({ id: idSchema, title: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(20000), type: knowledgeType, sourceLabel: z.string().trim().max(240).nullable().default(null), sourceDate: z.coerce.date().default(() => new Date()), meetingId: idSchema.nullable().default(null), validity: z.enum(['current', 'superseded', 'unknown']).default('current') })

function knowledgeRow(data: z.infer<typeof knowledgeInput>, userId: string) {
  return { id: data.id, userId, title: data.title, content: data.content, source: { type: data.type, label: data.sourceLabel || 'Carga manual', meetingId: data.meetingId }, sourceDate: data.sourceDate, validity: data.validity, permissions: { canView: true, canUseForSuggestions: true }, isDemo: false }
}

export async function getVentanaCelesteStatus() { await requireUserId(); const status = getVentanaCelesteConnectionStatus(); return status.configured ? (status.reachable ? 'connected' : 'error') : 'not_configured' }
export async function testVentanaCelesteConnection() { await requireUserId(); return new VentanaCelesteKnowledgeSource().testConnection() }
export async function listVentanaCelesteContent() { await requireUserId(); try { const items = await new VentanaCelesteKnowledgeSource().listAvailableContent(); return { items, error: null, status: 'connected' as const, count: items.length } } catch (error) { const status = getVentanaCelesteConnectionStatus(); const message = error instanceof Error && error.message === 'not_configured' ? 'Ventana Celeste no está configurada.' : status.lastError || (error instanceof Error && error.message.startsWith('http_') ? 'Ventana Celeste rechazó la consulta.' : 'No se pudo consultar Ventana Celeste.'); return { items: [], error: message, status: error instanceof Error && error.message === 'not_configured' ? 'not_configured' as const : 'error' as const, count: 0 } } }

export async function previewVentanaCelesteImport(input: unknown) {
  await requireUserId()
  const data = z.object({ raw: z.string().trim().min(1).max(1000000), format: z.enum(['json', 'text']) }).parse(input)
  return data.format === 'json' ? parseVentanaCelesteImport(data.raw) : parseVentanaCelesteText(data.raw)
}

export async function importVentanaCelesteItems(input: unknown) {
  const userId = await requireUserId()
  const data = z.object({ items: z.array(z.object({ id: idSchema, title: z.string().min(1).max(240), content: z.string().min(1).max(20000), type: knowledgeType, externalId: z.string().max(240).optional(), externalUrl: z.string().max(2000).optional(), externalType: z.string().max(120).optional(), sourceDate: z.coerce.date().optional(), source: z.record(z.string(), z.unknown()) })).max(500) }).parse(input)
  const existing = await db.select({ id: knowledgeItems.id, source: knowledgeItems.source, content: knowledgeItems.content }).from(knowledgeItems).where(eq(knowledgeItems.userId, userId))
  const existingKeys = new Set(existing.flatMap((item) => { const source = item.source as Record<string, unknown>; return [item.id, source.externalId ? `external:${source.provider}:${source.externalId}` : '', `content:${source.externalType ?? ''}:${item.content.trim().toLocaleLowerCase().replace(/\\s+/g, ' ')}`] }))
  let imported = 0; let updated = 0; let duplicates = 0; const errors: string[] = []
  for (const item of data.items) {
    try { const source = { ...item.source, type: 'external', provider: 'ventana_celeste', importedAt: new Date().toISOString() }; const key = item.externalId ? `external:ventana_celeste:${item.externalId}` : `content:${item.externalType ?? item.type}:${item.content.trim().toLocaleLowerCase().replace(/\\s+/g, ' ')}`; const found = existing.find((entry) => entry.id === item.id || (item.externalId && (entry.source as Record<string, unknown>).externalId === item.externalId) || (entry.content.trim().toLocaleLowerCase().replace(/\\s+/g, ' ') === item.content.trim().toLocaleLowerCase().replace(/\\s+/g, ' ')))
      await db.insert(knowledgeItems).values({ id: item.id, userId, title: item.title, content: item.content, source, sourceDate: item.sourceDate ?? new Date(), validity: 'current', permissions: { canView: true, canUseForSuggestions: true }, isDemo: false }).onConflictDoUpdate({ target: knowledgeItems.id, set: { title: item.title, content: item.content, source, sourceDate: item.sourceDate ?? new Date(), validity: 'current' }, where: eq(knowledgeItems.userId, userId) }); if (found) updated++; else if (existingKeys.has(key)) duplicates++; else imported++; existingKeys.add(key)
    } catch (error) { errors.push(`${item.title}: ${error instanceof Error ? error.message : 'error desconocido'}`) }
  }
  revalidatePath('/'); return { imported, updated, duplicates, errors }
}

export async function listKnowledgeItems() {
  const userId = await requireUserId()
  return db.select().from(knowledgeItems).where(eq(knowledgeItems.userId, userId)).orderBy(desc(knowledgeItems.sourceDate))
}

export async function saveKnowledgeItem(input: unknown) {
  const userId = await requireUserId()
  const data = knowledgeInput.parse(input)
  await db.insert(knowledgeItems).values(knowledgeRow(data, userId)).onConflictDoUpdate({ target: knowledgeItems.id, set: { title: data.title, content: data.content, source: knowledgeRow(data, userId).source, sourceDate: data.sourceDate, validity: data.validity }, where: eq(knowledgeItems.userId, userId) })
  revalidatePath('/')
  return data.id
}

export async function deleteKnowledgeItem(input: unknown) {
  const userId = await requireUserId()
  const id = idSchema.parse(typeof input === 'string' ? input : z.object({ id: idSchema }).parse(input).id)
  await db.delete(knowledgeItems).where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.userId, userId)))
  revalidatePath('/')
}

export async function getIrisRuntimeDiagnosticsAction() {
  await requireUserId()
  return process.env.NODE_ENV === 'production' ? null : getIrisRuntimeDiagnostics()
}

export async function analyzeMeetingForInterventionAction(input: unknown) {
  const userId = await requireUserId()
  const meetingId = idSchema.parse(input)
  if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_MEETING_ID', { activeMeetingId: meetingId, actionMeetingId: meetingId })
  try { return await analyzeMeetingForIntervention(meetingId, userId) } catch (error) { const reason = error instanceof IntelligenceProviderError ? error.message : 'No se pudo completar el análisis. Revisa la configuración del proveedor y los registros del servidor.'; console.error('[v0] intervention action degraded', { meetingId, code: error instanceof IntelligenceProviderError ? error.code : 'unexpected_error', error: error instanceof Error ? error.message : 'unknown' }); return { shouldIntervene: false, level: 0 as const, type: 'provider_unavailable', reason, content: '', confidence: 0, evidence: [] } }
  }

const proactiveScenarioInput = z.enum(['n1', 'n2'])
const proactiveScenarioFixtures = {
  n1: { objective: 'Definir responsables y próximos pasos del piloto.', agenda: ['Responsables', 'Próximos pasos'], transcript: 'Ya conversamos sobre el lanzamiento. Todavía no hemos definido quién quedará responsable de preparar el presupuesto. Podemos continuar viendo otros temas.', knowledge: 'Tarea pendiente: definir responsable de presupuesto.' },
  n2: { objective: 'Definir fecha, responsables y presupuesto para lanzar el piloto.', agenda: ['Presupuesto'], transcript: 'Ayer fui a comer pizza. Después vi el partido. Estoy pensando en comprar un auto. También estaba viendo dónde viajar durante el verano. No sé si comprar pasajes ahora o después.', knowledge: '' },
} as const

export async function runProactiveScenarioAction(input: unknown) {
  await requireUserId()
  if (process.env.NODE_ENV === 'production') throw new Error('Development-only action')
  const scenario = proactiveScenarioInput.parse(input)
  const fixture = proactiveScenarioFixtures[scenario]
  const context = ['MEETING OBJECTIVE\\n' + fixture.objective, 'AGENDA\\n' + fixture.agenda.map((item, index) => `- ${index === 0 ? 'active' : 'pending'}: ${item}`).join('\\n'), 'CURRENT AGENDA ITEM\\n' + fixture.agenda[0], 'RECENT TRANSCRIPT\\n' + fixture.transcript, 'RELEVANT KNOWLEDGE\\n' + (fixture.knowledge || '[Sin conocimiento relevante]'), 'RECENT INTERVENTIONS\\n[Sin intervenciones recientes]'].join('\\n\\n')
  const output = await createMeetingIntelligenceProvider().analyze({ context, operation: 'intervention_analysis', transcriptCharacterCount: context.length, transcriptSegmentCount: 1, knowledgeItemCount: fixture.knowledge ? 1 : 0 })
  return { ...output, scenario, fixture: { objective: fixture.objective, transcript: fixture.transcript } }
}

export async function answerIrisMeetingQuestionAction(input: unknown) {
  const userId = await requireUserId()
  const data = z.object({ meetingId: idSchema, query: z.string().trim().min(1).max(1000), invocationId: idSchema, previousExchange: z.object({ user: z.string().trim().max(1000), iris: z.string().trim().max(4000) }).optional() }).parse(input)
  await assertMeeting(userId, data.meetingId)
  if (process.env.NODE_ENV !== 'production') console.log('[v0] DIRECT_INVOCATION_MEETING_ID', { activeMeetingId: data.meetingId, actionMeetingId: data.meetingId })
  return answerIrisMeetingQuestion(data.meetingId, userId, data.query, data.previousExchange)
}

const detectionTaskInput = z.object({ meetingId: idSchema, text: z.string().trim().min(1).max(1000), assignee: z.string().trim().max(200).nullable(), dueDate: z.string().trim().max(240).nullable(), evidence: z.string().trim().min(1).max(2000), confidence: z.number().min(0).max(1) })
const detectionDecisionInput = z.object({ meetingId: idSchema, text: z.string().trim().min(1).max(2000), context: z.string().trim().min(1).max(2000), people: z.array(z.string().trim().min(1).max(120)).max(30), evidence: z.string().trim().min(1).max(2000) })
const detectionCommitmentInput = z.object({ meetingId: idSchema, text: z.string().trim().min(1).max(1000), assignee: z.string().trim().max(200).nullable(), dueDate: z.string().trim().max(240).nullable(), evidence: z.string().trim().min(1).max(2000) })
const detectionQuestionInput = z.object({ meetingId: idSchema, text: z.string().trim().min(1).max(1000), context: z.string().trim().min(1).max(2000), evidence: z.string().trim().min(1).max(2000) })
function extractionId(meetingId: string, type: string, text: string) { return `${meetingId}-extraction-${Buffer.from(`${type}:${text.trim().toLocaleLowerCase().replace(/\\s+/g, ' ')}`).toString('base64url').slice(0, 80)}` }
async function saveExtractionKnowledge(tx: any, userId: string, input: { id: string; meetingId: string; type: z.infer<typeof knowledgeType>; title: string; content: string; evidence: string }) {
  const row = { id: input.id, userId, title: input.title, content: input.content, source: { type: input.type, meetingId: input.meetingId, entityId: input.id, generatedFrom: 'meeting_extraction', evidence: input.evidence }, sourceDate: new Date(), validity: 'current', permissions: { canView: true, canUseForSuggestions: true }, isDemo: false }
  await tx.insert(knowledgeItems).values(row).onConflictDoUpdate({ target: knowledgeItems.id, set: { title: row.title, content: row.content, source: row.source, sourceDate: row.sourceDate, validity: row.validity }, where: eq(knowledgeItems.userId, userId) })
}

export async function updateMeetingSummary(input: unknown) {
  const userId = await requireIrisUserId()
  const data = z.object({ meetingId: idSchema, summary: z.string().trim().max(20000), topics: z.array(z.string().trim().min(1).max(500)).max(50), keyPoints: z.array(z.string().trim().min(1).max(1000)).max(100) }).parse(input)
  await assertMeeting(userId, data.meetingId)
  await db.update(meetingSummaries).set({ summary: data.summary, topics: data.topics, keyPoints: data.keyPoints, updatedAt: new Date() }).where(and(eq(meetingSummaries.meetingId, data.meetingId), eq(meetingSummaries.userId, userId)))
  revalidatePath('/')
}

export async function getMeetingSummary(input: unknown) {
  const userId = await requireIrisUserId(); const meetingId = idSchema.parse(input); await assertMeeting(userId, meetingId)
  const [stored] = await db.select().from(meetingSummaries).where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.userId, userId)))
  if (stored) return { summary: stored.summary, topics: stored.topics, keyPoints: stored.keyPoints }
  const startedAt = Date.now(); const segments = await db.select({ speaker: transcriptSegments.speaker, text: transcriptSegments.text, startedAt: transcriptSegments.startedAt, isFinal: transcriptSegments.isFinal }).from(transcriptSegments).where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.userId, userId))).orderBy(asc(transcriptSegments.startedAt)); const finalSegments = segments.filter((segment) => segment.isFinal && segment.text.trim()); const transcript = finalSegments.map((segment) => `[${segment.startedAt.toISOString()}] ${segment.speaker}: ${segment.text.trim()}`).join('\\n'); const diagnostics = getIrisRuntimeDiagnostics()
  try { const summary = await generateMeetingSummary(transcript); await db.insert(meetingSummaries).values({ id: `${meetingId}-summary`, userId, meetingId, summary: summary.summary, topics: summary.topics, keyPoints: summary.keyPoints, provider: diagnostics.provider, model: diagnostics.model }).onConflictDoUpdate({ target: meetingSummaries.id, set: { summary: summary.summary, topics: summary.topics, keyPoints: summary.keyPoints, provider: diagnostics.provider, model: diagnostics.model, updatedAt: new Date() }, where: eq(meetingSummaries.userId, userId) }); if (process.env.NODE_ENV !== 'production') console.log('[v0] POST_MEETING_SUMMARY', { meetingId, transcriptSegmentCount: finalSegments.length, transcriptCharacterCount: transcript.length, model: diagnostics.model, latencyMs: Date.now() - startedAt, summaryCharacterCount: summary.summary.length, topicsCount: summary.topics.length, keyPointsCount: summary.keyPoints.length, status: 'success', validationStatus: 'validated', containsDecisionKeyword: /decisi[oó]n/i.test(transcript), containsTaskKeyword: /tarea/i.test(transcript) }); return summary } catch (error) { if (process.env.NODE_ENV !== 'production') console.error('[v0] POST_MEETING_SUMMARY', { meetingId, transcriptSegmentCount: finalSegments.length, transcriptCharacterCount: transcript.length, model: diagnostics.model, latencyMs: Date.now() - startedAt, summaryCharacterCount: 0, topicsCount: 0, keyPointsCount: 0, status: 'error', validationStatus: 'failed', containsDecisionKeyword: /decisi[oó]n/i.test(transcript), containsTaskKeyword: /tarea/i.test(transcript), code: error instanceof Error ? error.message : 'unknown_error' }); throw error }
}

export async function finalizeMeetingAction(input: unknown) {
  const userId = await requireIrisUserId()
  const meetingId = idSchema.parse(input)
  await assertMeeting(userId, meetingId)
  const [segments, diagnostics] = await Promise.all([
    db.select({ speaker: transcriptSegments.speaker, text: transcriptSegments.text, startedAt: transcriptSegments.startedAt, isFinal: transcriptSegments.isFinal }).from(transcriptSegments).where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.userId, userId))).orderBy(asc(transcriptSegments.startedAt)),
    Promise.resolve(getIrisRuntimeDiagnostics()),
  ])
  const finalSegments = segments.filter((segment) => segment.isFinal && segment.text.trim())
  const transcript = finalSegments.map((segment) => `[${segment.startedAt.toISOString()}] ${segment.speaker}: ${segment.text.trim()}`).join('\\n')
  const [detections, summary] = await Promise.all([extractIrisDetections(transcript), generateMeetingSummary(transcript)])
  const summaryId = `${meetingId}-summary`
  await db.transaction(async (tx) => {
    await tx.insert(meetingSummaries).values({ id: summaryId, userId, meetingId, summary: summary.summary, topics: summary.topics, keyPoints: summary.keyPoints, commitments: detections.commitments, openQuestions: detections.openQuestions, provider: diagnostics.provider, model: diagnostics.model }).onConflictDoUpdate({ target: meetingSummaries.id, set: { summary: summary.summary, topics: summary.topics, keyPoints: summary.keyPoints, commitments: detections.commitments, openQuestions: detections.openQuestions, provider: diagnostics.provider, model: diagnostics.model, updatedAt: new Date() }, where: eq(meetingSummaries.userId, userId) })
    for (const item of detections.tasks) { const id = extractionId(meetingId, 'task', item.text); await tx.insert(tasks).values({ id, userId, meetingId, text: item.text, assignee: item.assignee, dueDate: item.dueDate ? new Date(item.dueDate) : null, status: 'open' }).onConflictDoUpdate({ target: tasks.id, set: { text: item.text, assignee: item.assignee, dueDate: item.dueDate ? new Date(item.dueDate) : null }, where: eq(tasks.userId, userId) }) }
    for (const item of detections.decisions) { const id = extractionId(meetingId, 'decision', item.text); await tx.insert(decisions).values({ id, userId, meetingId, text: item.text, status: 'draft', confirmedByUser: false }).onConflictDoNothing({ target: decisions.id, where: eq(decisions.userId, userId) }) }
  })
  revalidatePath('/')
  if (process.env.NODE_ENV !== 'production') console.log('[v0] POST_MEETING_CANONICAL_PERSIST', { meetingId, transcriptSegments: finalSegments.length, tasksCount: detections.tasks.length, decisionsCount: detections.decisions.length, commitmentsCount: detections.commitments.length, openQuestionsCount: detections.openQuestions.length, summaryPersisted: true })
  return { meetingId, transcriptSegments: finalSegments.length, extraction: detections, summary, summaryPersisted: true }
}

export async function getMeetingDetections(input: unknown) {
  const userId = await requireUserId(); const meetingId = idSchema.parse(input); await assertMeeting(userId, meetingId)
  const [storedSummary] = await db.select({ commitments: meetingSummaries.commitments, openQuestions: meetingSummaries.openQuestions }).from(meetingSummaries).where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.userId, userId)))
  if (storedSummary && ((Array.isArray(storedSummary.commitments) && storedSummary.commitments.length > 0) || (Array.isArray(storedSummary.openQuestions) && storedSummary.openQuestions.length > 0))) return { tasks: [], decisions: [], commitments: (storedSummary.commitments ?? []) as Array<{ text: string; assignee: string | null; dueDate: string | null; evidence: string }>, openQuestions: (storedSummary.openQuestions ?? []) as Array<{ text: string; context: string; evidence: string }> }
  const startedAt = Date.now()
  const segments = await db.select({ speaker: transcriptSegments.speaker, text: transcriptSegments.text, startedAt: transcriptSegments.startedAt, isFinal: transcriptSegments.isFinal }).from(transcriptSegments).where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.userId, userId))).orderBy(asc(transcriptSegments.startedAt))
  const finalSegments = segments.filter((segment) => segment.isFinal && segment.text.trim())
  const transcript = finalSegments.map((segment) => `[${segment.startedAt.toISOString()}] ${segment.speaker}: ${segment.text.trim()}`).join('\\n')
  const diagnostics = getIrisRuntimeDiagnostics()
  try {
    const detections = await extractIrisDetections(transcript)
    const [storedSummary] = await db.select({ id: meetingSummaries.id }).from(meetingSummaries).where(and(eq(meetingSummaries.meetingId, meetingId), eq(meetingSummaries.userId, userId)))
    if (storedSummary) await db.update(meetingSummaries).set({ commitments: detections.commitments, openQuestions: detections.openQuestions, updatedAt: new Date() }).where(and(eq(meetingSummaries.id, storedSummary.id), eq(meetingSummaries.userId, userId)))
   %20else await db.insert(meetingSummaries).values({ id: `${meetingId}-summary`, userId, meetingId, summary: 'Minuta pendiente de generación.', commitments: detections.commitments, openQuestions: detections.openQuestions })
    if (process.env.NODE_ENV !== 'production') console.log('[v0] POST_MEETING_EXTRACTION', { meetingId, transcriptSegmentCount: finalSegments.length, transcriptCharacterCount: transcript.length, provider: diagnostics.provider, model: diagnostics.model, latencyMs: Date.now() - startedAt, tasksCount: detections.tasks.length, decisionsCount: detections.decisions.length, commitmentsCount: detections.commitments.length, openQuestionsCount: detections.openQuestions.length, status: 'success', validationStatus: 'validated', containsDecisionKeyword: /decisi[oó]n/i.test(transcript), containsTaskKeyword: /tarea/i.test(transcript) })
    return detections
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') console.error('[v0] POST_MEETING_EXTRACTION', { meetingId, transcriptSegmentCount: finalSegments.length, transcriptCharacterCount: transcript.length, provider: diagnostics.provider, model: diagnostics.model, latencyMs: Date.now() - startedAt, tasksCount: 0, decisionsCount: 0, commitmentsCount: 0, openQuestionsCount: 0, status: 'error', validationStatus: 'failed', containsDecisionKeyword: /decisi[oó]n/i.test(transcript), containsTaskKeyword: /tarea/i.test(transcript), code: error instanceof Error ? error.message : 'unknown_error' })
    throw error
  }
}

export async function confirmExtractedTask(input: unknown) {
  const userId = await requireUserId(); const data = detectionTaskInput.parse(input); await assertMeeting(userId, data.meetingId); const id = extractionId(data.meetingId, 'task', data.text)
  await db.transaction(async (tx) => { await tx.insert(tasks).values({ id, userId, meetingId: data.meetingId, text: data.text, assignee: data.assignee, dueDate: data.dueDate ? new Date(data.dueDate) : null, status: 'open' }).onConflictDoUpdate({ target: tasks.id, set: { text: data.text, assignee: data.assignee, dueDate: data.dueDate ? new Date(data.dueDate) : null }, where: eq(tasks.userId, userId) }); await saveExtractionKnowledge(tx, userId, { id: `${id}-knowledge`, meetingId: data.meetingId, type: 'task', title: `Tarea: ${data.text.slice(0, 120)}`, content: `${data.text}${data.assignee ? ` · Responsable: ${data.assignee}` : ''}${data.dueDate ? ` · Fecha: ${data.dueDate}` : ''} · Estado: pendiente`, evidence: data.evidence }) })
  revalidatePath('/'); return id
}

export async function confirmExtractedDecision(input: unknown) {
  const userId = await requireUserId(); const data = detectionDecisionInput.parse(input); await assertMeeting(userId, data.meetingId); const id = extractionId(data.meetingId, 'decision', data.text)
  await db.transaction(async (tx) => { await tx.insert(decisions).values({ id, userId, meetingId: data.meetingId, text: data.text, status: 'confirmed', confirmedByUser: true }).onConflictDoUpdate({ target: decisions.id, set: { text: data.text, status: 'confirmed', confirmedByUser: true }, where: eq(decisions.userId, userId) }); await saveExtractionKnowledge(tx, userId, { id: `${id}-knowledge`, meetingId: data.meetingId, type: 'decision', title: `Decisión: ${data.text.slice(0, 120)}`, content: `${data.text} · Contexto: ${data.context}${data.people.length ? ` · Personas: ${data.people.join(', ')}` : ''}`, evidence: data.evidence }) })
  revalidatePath('/'); return id
}

export async function confirmExtractedCommitment(input: unknown) { const userId = await requireUserId(); const data = detectionCommitmentInput.parse(input); await assertMeeting(userId, data.meetingId); const id = extractionId(data.meetingId, 'commitment', data.text); await saveExtractionKnowledge(db, userId, { id: `${id}-knowledge`, meetingId: data.meetingId, type: 'commitment', title: `Compromiso: ${data.text.slice(0, 120)}`, content: `${data.text}${data.assignee ? ` · Responsable: ${data.assignee}` : ''}${data.dueDate ? ` · Fecha: ${data.dueDate}` : ''}`, evidence: data.evidence }); revalidatePath('/'); return id }
export async function confirmExtractedQuestion(input: unknown) { const userId = await requireUserId(); const data = detectionQuestionInput.parse(input); await assertMeeting(userId, data.meetingId); const id = extractionId(data.meetingId, 'open_question', data.text); await saveExtractionKnowledge(db, userId, { id: `${id}-knowledge`, meetingId: data.meetingId, type: 'open_question', title: `Pregunta: ${data.text.slice(0, 120)}`, content: `${data.text} · Contexto: ${data.context}`, evidence: data.evidence }); revalidatePath('/'); return id }

export async function analyzeMeeting(input: unknown) {
  const userId = await requireUserId()
  const meetingId = idSchema.parse(input)
  await assertMeeting(userId, meetingId)
  const segments = await db.select({ id: transcriptSegments.id, speaker: transcriptSegments.speaker, text: transcriptSegments.text, startedAt: transcriptSegments.startedAt }).from(transcriptSegments).where(and(eq(transcriptSegments.meetingId, meetingId), eq(transcriptSegments.userId, userId)))
  if (!segments.length) throw new Error('Esta reunión no tiene transcripción disponible.')
  const transcript = segments.map((segment) => `[${segment.startedAt.toISOString()}] ${segment.speaker}: ${segment.text}`).join('\\n')
  const detections = await extractIrisDetections(transcript)
  const rows = [
    ...detections.tasks.map((item) => ({ category: 'task', evidence: [item.evidence], recommendedAction: `Revisar tarea · Confianza ${Math.round(item.confidence * 100)}% · Responsable: ${item.assignee ?? 'sin identificar'} · Fecha: ${item.dueDate ?? 'sin identificar'}` })),
    ...detections.decisions.map((item) => ({ category: 'decision', evidence: [item.evidence], recommendedAction: `Revisar decisión · ${item.context}` })),
    ...detections.commitments.map((item) => ({ category: 'commitment', evidence: [item.evidence], recommendedAction: `Revisar compromiso · Responsable: ${item.assignee ?? 'sin identificar'} · Cumplimiento: ${item.dueDate ?? 'sin identificar'}` })),
    ...detections.openQuestions.map((item) => ({ category: 'question', evidence: [item.evidence], recommendedAction: `Revisar pregunta · ${item.context}` })),
  ]
  const unique = new Map(rows.map((row) => [detectionKey(row.category, row.evidence[0]), row]))
  await db.transaction(async (tx) => {
    await tx.delete(suggestions).where(and(eq(suggestions.meetingId, meetingId), eq(suggestions.userId, userId), eq(suggestions.status, 'proposed')))
    if (unique.size) await tx.insert(suggestions).values([...unique.entries()].map(([key, row]) => ({ id: `${meetingId}-${Buffer.from(key).toString('base64url').slice(0, 80)}`, userId, meetingId, category: row.category, evidence: row.evidence, validity: 'uncertain', recommendedAction: row.recommendedAction, status: 'proposed' }))).onConflictDoNothing()
  })
  revalidatePath('/')
  return { count: unique.size }
}
