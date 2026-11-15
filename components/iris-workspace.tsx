'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { WebSpeechTranscriptionProvider, type SpeechRecognitionErrorCode } from '@/lib/web-speech-provider'
import { useRouter } from 'next/navigation'
import { Check, CircleHelp, FileText, Flag, Loader2, LogOut, Mic, MoreHorizontal, Pause, Play, Plus, Search, Sparkles, Square, X } from 'lucide-react'
import { analyzeMeeting, analyzeMeetingForInterventionAction, closeIntervention, confirmExtractedCommitment, confirmExtractedDecision, confirmExtractedQuestion, confirmExtractedTask, createIntervention, finalizeMeetingAction, deleteAgendaItem, deleteMeeting, deleteKnowledgeItem, getIrisRuntimeDiagnosticsAction, getMeetingDetections, getMeetingSummary, updateMeetingSummary, getVentanaCelesteStatus, importVentanaCelesteItems, listVentanaCelesteContent, listKnowledgeItems, testVentanaCelesteConnection, previewVentanaCelesteImport, saveAgendaItem, deleteTask, listMeetingData, suggestMeetingAgendaAction, saveDecision, saveKnowledgeItem, saveMeeting, saveMeetingContext, saveTask, saveTranscriptSegment, runProactiveScenarioAction, updateAgendaItem, updateSuggestion, updateTask } from '@/app/actions/iris'
import { authClient } from '@/lib/auth-client'
import { IrisPresentation, queueIrisSpeechChunk } from '@/components/iris-presentation'
import { IrisPepperGhost } from '@/components/iris-pepper-ghost'
import { IrisSettings } from '@/components/iris-settings'
import { detectDirectIrisInvocation, isIsolatedIrisWakeWord, normalizeDirectInvocationQuery, type DirectIrisResponse } from '@/lib/direct-invocation'
import { AUTO_ANALYSIS_MIN_INTERVAL_MS, countNewFinalSegments, evaluateInterventionPolicy, INTERVENTION_INTENSITY_CONFIG, INTERVENTION_TEST_MODE_CONFIG, latestFinalSegmentId, SIGNAL_COOLDOWN_MS, type InterventionPolicyResult } from '@/lib/iris-policy'

type IrisRuntimeDiagnostics = { provider: string; model: string; timeoutMs: number; rejectIfBusy: boolean; hasCloudflareAccountId: boolean; hasCloudflareApiToken: boolean; nodeEnv: string; vercelEnv: string | null; fallbackMessages: string[] }
type IrisVisualState = 'idle' | 'listening' | 'analyzing' | 'signal' | 'interventionLevel2' | 'interventionLevel3' | 'muted' | 'error'
type DiagnosticStage = 'waiting' | 'success' | 'ignored' | 'error'
type DiagnosticEvent = { at: string; label: string }
type ActivePresentation = { source: 'ai' | 'manual' | 'simulation' | 'direct'; level: 1 | 2 | 3; content: string; type: string; createdAt: string; visualState: IrisVisualState }
type PresentationLayer = Pick<ActivePresentation, 'level' | 'content'>
type InterventionDiagnostic = { status: string; latencyMs: number | null; suggestion: SuggestedIntervention | null; policy: InterventionPolicyResult | null; newSegments: number; startedAt: number | null; visualState?: IrisVisualState }

type Meeting = { id: string; title: string; startedAt: string; endedAt: string | null; status: string; participantNames: string[]; createdAt: string }
type Segment = { id: string; meetingId: string; speaker: string; text: string; startedAt: string; endedAt: string; isFinal: boolean }
type Task = { id: string; meetingId: string; text: string; assignee: string | null; dueDate: string | null; status: string }
type Decision = { id: string; meetingId: string; text: string; status: string; confirmedByUser: boolean }
type Suggestion = { id: string; meetingId: string; category: string; evidence: string[]; recommendedAction: string; status: string }
type AgendaItem = { id: string; meetingId: string; title: string; position: number; status: string; note: string | null }
type Intervention = { id: string; meetingId: string; createdAt: string; level: number; type: string; reason: string; content: string; source: string; status: string; observation: string | null }
type SuggestedIntervention = { shouldIntervene: boolean; level: 0 | 1 | 2 | 3; type: string; reason: string; content: string; confidence: number; evidence: string[] }
type KnowledgeItem = { id: string; title: string; content: string; source: { type?: string; label?: string; meetingId?: string } | null; sourceDate: string; validity: string }
type SessionState = 'idle' | 'connecting' | 'listening' | 'paused' | 'analyzing' | 'error' | 'ended'
type Detections = { tasks: Array<{ text: string; assignee: string | null; dueDate: string | null; confidence: number; evidence: string }>; decisions: Array<{ text: string; context: string; people: string[]; evidence: string }>; commitments: Array<{ text: string; assignee: string | null; dueDate: string | null; evidence: string }>; openQuestions: Array<{ text: string; context: string; evidence: string }> }

const emptyData = { segments: [] as Segment[], tasks: [] as Task[], decisions: [] as Decision[], suggestions: [] as Suggestion[], agenda: [] as AgendaItem[], interventions: [] as Intervention[], meeting: undefined as { objective: string; contextNotes: string | null } | undefined }

function formatMeetingDate(value: string) { return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Santiago' }).format(new Date(value)) }
function groupTranscriptSegments(segments: Segment[]) { const groups: Array<{ id: string; startedAt: string; speaker: string; text: string }> = []; for (const segment of segments) { const previous = groups.at(-1); const sameSpeaker = previous && segment.speaker && previous.speaker && segment.speaker === previous.speaker; const closeInTime = previous && new Date(segment.startedAt).getTime() - new Date(previous.startedAt).getTime() < 90000; if (previous && (sameSpeaker || closeInTime) && previous.text.split(/\\s+/).length < 70) { previous.text = `${previous.text} ${segment.text}`.trim(); } else { groups.push({ id: segment.id, startedAt: segment.startedAt, speaker: segment.speaker, text: segment.text }); } } return groups }
function buildPyramidNarration(layers: PresentationLayer[]) { return layers.map((layer) => `${layer.level === 1 ? 'Señal inicial' : layer.level === 2 ? 'Mensaje junto al patrón' : 'Intervención final'}: ${layer.content}`).join('. ') }
function buildImmediateAgenda(title: string, objective: string, contextNotes: string) { return [ ...(objective.trim() ? [{ title: 'Alinear el resultado esperado', reason: objective.trim() }] : []), ...(contextNotes.trim() ? [{ title: 'Revisar antecedentes y restricciones', reason: contextNotes.trim() }] : []), { title: `Revisar los temas centrales de ${title.trim() || 'la reunión'}`, reason: 'Ordenar los temas prioritarios y resolver las preguntas abiertas.' }, { title: 'Definir decisiones y próximos pasos', reason: 'Cerrar con responsables y plazos acordados.' }].slice(0, 7) }

export function IrisWorkspace({ user, meetings: initialMeetings }: { user: { name: string; email: string }; meetings: Meeting[] }) {
  const router = useRouter()
  const [meetings, setMeetings] = useState(initialMeetings)
  const [selectedId, setSelectedId] = useState<string | null>(initialMeetings[0]?.id ?? nu