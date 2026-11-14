import { z } from 'zod'

export const meetingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  status: z.enum(['scheduled', 'live', 'paused', 'ended']),
  participantNames: z.array(z.string().min(1)),
})

export const transcriptSegmentSchema = z.object({
  id: z.string().min(1),
  meetingId: z.string().min(1),
  speaker: z.string().min(1),
  text: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  isFinal: z.literal(true),
})

export const knowledgeItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  source: z.object({
    type: z.enum(['meeting', 'document', 'task']),
    label: z.string().min(1),
    url: z.string().url().optional(),
  }),
  sourceDate: z.string().datetime(),
  validity: z.enum(['current', 'superseded', 'unknown']),
  permissions: z.object({
    canView: z.boolean(),
    canUseForSuggestions: z.boolean(),
  }),
  isDemo: z.boolean(),
})

export const suggestionSchema = z.object({
  id: z.string().min(1),
  category: z.enum(['neutral', 'decision_sin_antecedente', 'falta_responsable', 'acuerdo_alcanzado']),
  evidence: z.array(z.string().min(1)),
  validity: z.enum(['current', 'superseded', 'unknown', 'not_found']),
  recommendedAction: z.string().min(1),
  status: z.enum(['proposed', 'accepted', 'edited', 'dismissed']),
})

export const agendaItemSchema = z.object({ id: z.string().min(1), meetingId: z.string().min(1), title: z.string().min(1), position: z.number().int().nonnegative(), status: z.enum(['pending', 'active', 'completed']), note: z.string().nullable() })

export const suggestedInterventionSchema = z.object({ shouldIntervene: z.boolean(), level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), type: z.enum(['agenda_reminder', 'off_topic', 'previous_decision', 'pending_task', 'unresolved_question', 'time_warning', 'generic']), reason: z.string().min(1).max(1000), content: z.string().min(1).max(1000), confidence: z.number().min(0).max(1), evidence: z.array(z.string().min(1)).max(10) })

export type SuggestedIntervention = z.infer<typeof suggestedInterventionSchema>

export const interventionSchema = z.object({ id: z.string().min(1), meetingId: z.string().min(1), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), type: z.enum(['agenda_reminder', 'off_topic', 'previous_decision', 'pending_task', 'unresolved_question', 'time_warning', 'generic']), reason: z.string().min(1), content: z.string().min(1), source: z.enum(['manual', 'ai']), status: z.enum(['active', 'closed', 'muted']), observation: z.string().nullable(), createdAt: z.string().datetime() })

export const decisionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(['draft', 'confirmed', 'dismissed']),
  confirmedByUser: z.boolean(),
})

export const taskSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  assignee: z.string().min(1).nullable(),
  dueDate: z.string().datetime().nullable(),
  status: z.enum(['open', 'done']),
})

export type Meeting = z.infer<typeof meetingSchema>
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>
export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>
export type Suggestion = z.infer<typeof suggestionSchema>
export type Decision = z.infer<typeof decisionSchema>
export type Task = z.infer<typeof taskSchema>
export type SuggestionCategory = Suggestion['category']
export type SuggestionValidity = Suggestion['validity']
