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
  const [interventionRows, suggest