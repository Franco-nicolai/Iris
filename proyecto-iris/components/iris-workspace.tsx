'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { WebSpeechTranscriptionProvider, type SpeechRecognitionErrorCode } from '@/lib/web-speech-provider'
import { useRouter } from 'next/navigation'
import { Check, CircleHelp, FileText, Flag, Loader2, LogOut, Mic, Pause, Play, Plus, Search, Sparkles, Square, X } from 'lucide-react'
import { analyzeMeeting, analyzeMeetingForInterventionAction, closeIntervention, confirmExtractedCommitment, confirmExtractedDecision, confirmExtractedQuestion, confirmExtractedTask, createIntervention, finalizeMeetingAction, deleteAgendaItem, deleteKnowledgeItem, getIrisRuntimeDiagnosticsAction, getMeetingDetections, getMeetingSummary, updateMeetingSummary, getVentanaCelesteStatus, importVentanaCelesteItems, listVentanaCelesteContent, listKnowledgeItems, testVentanaCelesteConnection, previewVentanaCelesteImport, saveAgendaItem, deleteTask, listMeetingData, suggestMeetingAgendaAction, saveDecision, saveKnowledgeItem, saveMeeting, saveMeetingContext, saveTask, saveTranscriptSegment, runProactiveScenarioAction, updateSuggestion, updateTask } from '@/app/actions/iris'
import { authClient } from '@/lib/auth-client'
import { IrisPresentation, queueIrisSpeechChunk } from '@/components/iris-presentation'
import { IrisOrbVisual } from '@/components/iris-orb-visual'
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
type KnowledgeItem = { id: string; title: string; content: string; source: { type?: string; label?: string; meetingId?: string; provider?: string; externalType?: string } | null; sourceDate: string; validity: string }
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
  // Start in the meeting setup flow; historical meetings remain available in the workspace.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [data, setData] = useState(emptyData)
  const [loadingData, setLoadingData] = useState(Boolean(initialMeetings[0]))
  const [dataError, setDataError] = useState('')
  const [query, setQuery] = useState('')
  const [session, setSession] = useState<SessionState>('idle')
  const [pending, setPending] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [detections, setDetections] = useState<Detections | null>(null)
  const [meetingSummary, setMeetingSummary] = useState<{ summary: string; topics: string[]; keyPoints: string[] } | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [extractingResults, setExtractingResults] = useState(false)
  const [extractionError, setExtractionError] = useState('')
  const [confirmedDetectionKeys, setConfirmedDetectionKeys] = useState(new Set<string>())
  const [suggestedIntervention, setSuggestedIntervention] = useState<SuggestedIntervention | null>(null)
  const [activePresentation, setActivePresentation] = useState<ActivePresentation | null>(null)
  const [tabletLinkStatus, setTabletLinkStatus] = useState('')
  const [pyramidState, setPyramidState] = useState<{ layers: ActivePresentation[]; speechContent: string | null }>({ layers: [], speechContent: null })
  const presentationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [analyzingIntervention, setAnalyzingIntervention] = useState(false)
  const [interventionLatencyMs, setInterventionLatencyMs] = useState<number | null>(null)
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<IrisRuntimeDiagnostics | null>(null)
  const [autoAnalysis, setAutoAnalysis] = useState(false)
  const [interventionIntensity, setInterventionIntensity] = useState<'low' | 'medium' | 'high'>('medium')
  const [interventionTestMode, setInterventionTestMode] = useState(false)
  const [presentationInspectionMode, setPresentationInspectionMode] = useState(false)
  const [scenarioResults, setScenarioResults] = useState<Record<'n1' | 'n2', Array<{ suggestion: SuggestedIntervention | null; policy: InterventionPolicyResult | null; error?: string }>>>({ n1: [], n2: [] })
  const [scenarioRunning, setScenarioRunning] = useState<string | null>(null)
  const [diagnosticStages, setDiagnosticStages] = useState<Record<'trigger' | 'model' | 'policy' | 'ui', DiagnosticStage>>({ trigger: 'waiting', model: 'waiting', policy: 'waiting', ui: 'waiting' })
  const [diagnosticTrigger, setDiagnosticTrigger] = useState<Record<string, unknown> | null>(null)
  const [diagnosticEvents, setDiagnosticEvents] = useState<DiagnosticEvent[]>([])
  const addDiagnosticEvent = (label: string) => setDiagnosticEvents((current) => [{ at: new Date().toLocaleTimeString('es-ES'), label }, ...current].slice(0, 10))
  const logPresentationEvent = (event: 'PRESENTATION_SET' | 'PRESENTATION_RENDERED' | 'PRESENTATION_CLEARED', presentation: ActivePresentation | null, clearReason?: 'timeout' | 'manual' | 'replaced' | 'meetingEnded') => { if (process.env.NODE_ENV !== 'production') console.log(`[v0] ${event}`, { source: presentation?.source, level: presentation?.level, visualState: presentation?.visualState, timestamp: new Date().toISOString(), ...(event === 'PRESENTATION_CLEARED' ? { clearReason } : {}) }) }
  const clearPresentation = (clearReason: 'timeout' | 'manual' | 'replaced' | 'meetingEnded') => { if (presentationTimerRef.current) { clearTimeout(presentationTimerRef.current); presentationTimerRef.current = null }; const previous = activePresentation; setActivePresentation(null); setPyramidState({ layers: [], speechContent: null }); setSuggestedIntervention(null); setIrisVisualState(irisMuted ? 'muted' : 'listening'); if (previous) { logPresentationEvent('PRESENTATION_CLEARED', previous, clearReason); addDiagnosticEvent(`PRESENTATION_CLEARED ${clearReason}`) } }
  useEffect(() => { if (!activePresentation || process.env.NODE_ENV === 'production') return; logPresentationEvent('PRESENTATION_RENDERED', activePresentation); addDiagnosticEvent('PRESENTATION_RENDERED') }, [activePresentation])
  useEffect(() => { if (presentationInspectionMode && presentationTimerRef.current) { clearTimeout(presentationTimerRef.current); presentationTimerRef.current = null } }, [presentationInspectionMode])
  useEffect(() => () => { if (presentationTimerRef.current) clearTimeout(presentationTimerRef.current); directInvocationAbortRef.current?.abort(); window.speechSynthesis?.cancel() }, [])
  const presentIntervention = (source: ActivePresentation['source'], suggestion: SuggestedIntervention, visualState: IrisVisualState) => {
    const level = Math.max(1, Math.min(3, suggestion.level)) as 1 | 2 | 3
    const presentation: ActivePresentation = { source, level, content: suggestion.content, type: suggestion.type, createdAt: new Date().toISOString(), visualState }
    if (activePresentation) { logPresentationEvent('PRESENTATION_CLEARED', activePresentation, 'replaced'); addDiagnosticEvent('PRESENTATION_CLEARED replaced') }
    setActivePresentation(presentation)
    setPyramidState((current) => {
      let layers = level === 1 ? [presentation] : current.layers.filter((layer) => layer.level < level)
      if (level >= 2 && !layers.some((layer) => layer.level === 1)) layers = [{ ...presentation, level: 1, content: 'Iris detectó una señal relacionada con la conversación.', visualState: 'signal' }, ...layers]
      if (level === 3 && !layers.some((layer) => layer.level === 2)) layers = [...layers, { ...presentation, level: 2, content: suggestion.reason, visualState: 'interventionLevel2' }]
      layers = [...layers.filter((layer) => layer.level < level), presentation]
      return { layers, speechContent: level === 3 && pepperGhostOpen ? suggestion.content : null }
    })
    logPresentationEvent('PRESENTATION_SET', presentation)
    if (process.env.NODE_ENV !== 'production') console.log('[v0] PRESENTATION_SET', { source, level, visualState })
    setSuggestedIntervention(suggestion)
    setIrisVisualState(visualState)
    setDiagnosticStages((current) => ({ ...current, ui: 'success' }))
    addDiagnosticEvent(`${source === 'ai' ? 'presentation set' : `presentation set ${source}`} level=${level}`)
    addDiagnosticEvent(`UI ${visualState}`)
    if (presentationTimerRef.current) clearTimeout(presentationTimerRef.current)
    // Every real interaction expires even while the prism overlay remains open.
    presentationTimerRef.current = presentationInspectionMode ? null : setTimeout(() => clearPresentation('timeout'), level === 1 ? 4500 : level === 2 ? 7000 : 10000)
  }
  const [irisMuted, setIrisMuted] = useState(false)
  const [speechOutputError, setSpeechOutputError] = useState('')
  const [speechOutputReady, setSpeechOutputReady] = useState(false)
  const [policyResult, setPolicyResult] = useState<InterventionPolicyResult | null>(null)
  const [lastAnalysisAt, setLastAnalysisAt] = useState<number | null>(null)
  const [newSegmentCount, setNewSegmentCount] = useState(0)
  const [irisVisualState, setIrisVisualState] = useState<IrisVisualState>('idle')
  const signalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [interventionDiagnostic, setInterventionDiagnostic] = useState<InterventionDiagnostic>({ status: 'idle', latencyMs: null, suggestion: null, policy: null, newSegments: 0, startedAt: null, visualState: 'idle' })
  const [postMeetingDiagnostic, setPostMeetingDiagnostic] = useState({ extraction: { status: 'idle', decisionsCount: 0, tasksCount: 0, commitmentsCount: 0, openQuestionsCount: 0, latencyMs: null as number | null }, summary: { status: 'idle', summaryCharacterCount: 0, topicsCount: 0, keyPointsCount: 0, latencyMs: null as number | null } })
  const transcriptWritesRef = useRef(0)
  const transcriptWriteWaitersRef = useRef<Array<() => void>>([])
  const autoAnalysisInFlightRef = useRef(false)
  const autoAnalysisRequestRef = useRef(0)
  const lastAnalyzedSegmentIdRef = useRef<string | null>(null)
  const cooldownUntilRef = useRef(0)
  const signalCooldownUntilRef = useRef(0)
  const [interventionDraft, setInterventionDraft] = useState({ level: 2, type: 'generic', reason: '', content: '' })
  const [interventionError, setInterventionError] = useState('')
  const [taskDraft, setTaskDraft] = useState<{ id?: string; text: string; assignee: string; dueDate: string }>({ text: '', assignee: '', dueDate: '' })
  const [taskEditorOpen, setTaskEditorOpen] = useState(false)
  const speechRef = useRef<WebSpeechTranscriptionProvider | null>(null)
  const sessionMeetingRef = useRef<string | null>(null)
  const activeMeetingIdRef = useRef<string | null>(null)
  const selectedMeetingIdRef = useRef<string | null>(selectedId)
  useEffect(() => { selectedMeetingIdRef.current = selectedId }, [selectedId])
  const finalTranscriptKeysRef = useRef(new Set<string>())
  const [interimTranscript, setInterimTranscript] = useState('')
  const [liveFinalSegments, setLiveFinalSegments] = useState<Segment[]>([])
  const liveFinalSegmentsRef = useRef<Segment[]>([])
  const sessionStateRef = useRef(session)
  const sessionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const audioSendCountRef = useRef(0)
  const [audioError, setAudioError] = useState('')
  const [liveAnalysisError, setLiveAnalysisError] = useState('')
  const [directInvocation, setDirectInvocation] = useState<{ query: string; status: 'idle' | 'detected' | 'answering' | 'success' | 'error'; latencyMs: number | null; answer: string; spoken: boolean; presented: boolean }>({ query: '', status: 'idle', latencyMs: null, answer: '', spoken: false, presented: false })
  const directInvocationIdsRef = useRef(new Set<string>())
  const directInvocationAbortRef = useRef<AbortController | null>(null)
  const irisMutedRef = useRef(irisMuted)
  const speechOutputReadyRef = useRef(false)
  const recentFinalSpeechRef = useRef<Array<{ text: string; at: number }>>([])
  const pendingDirectWakeRef = useRef<{ startedAt: number; segmentId: string } | null>(null)
  const followUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const followUpRef = useRef<{ expiresAt: number; user: string; iris: string } | null>(null)
  const [followUpMode, setFollowUpMode] = useState(false)
  const [knowledge, setKnowledge] = useState<KnowledgeItem[]>([])
  const [knowledgeDraft, setKnowledgeDraft] = useState({ id: '', title: '', type: 'note', content: '', sourceLabel: '' })
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importRaw, setImportRaw] = useState('')
  const [importFormat, setImportFormat] = useState<'json' | 'text'>('json')
  const [importPreview, setImportPreview] = useState<Array<{ id: string; title: string; content: string; type: string; source: Record<string, unknown>; sourceDate?: string | Date }>>([])
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set())
  const [importSummary, setImportSummary] = useState<{ imported: number; updated: number; duplicates: number; errors: string[] } | null>(null)
  const [importLoading, setImportLoading] = useState(false)
  const [externalStatus, setExternalStatus] = useState<'not_configured' | 'configured' | 'connected' | 'error'>('not_configured')
  const [externalItems, setExternalItems] = useState<typeof importPreview>([])
  const [externalSelected, setExternalSelected] = useState<Set<string>>(new Set())
  const [externalMessage, setExternalMessage] = useState('')
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [pepperGhostOpen, setPepperGhostOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [newMeetingOpen, setNewMeetingOpen] = useState(false)
  const initialSetupShownRef = useRef(false)
  const [preMeetingStep, setPreMeetingStep] = useState(0)
  const [dictatingField, setDictatingField] = useState<'title' | 'objective' | 'contextNotes' | 'agenda' | null>(null)
  const dictationRef = useRef<WebSpeechTranscriptionProvider | null>(null)
  const [newMeetingForm, setNewMeetingForm] = useState({ title: '', objective: '', contextNotes: '', agenda: '' })
  const newMeetingFormRef = useRef(newMeetingForm)
  newMeetingFormRef.current = newMeetingForm
  const [suggestedAgenda, setSuggestedAgenda] = useState<Array<{ title: string; reason: string | null }>>([])
  const [agendaSuggestionSource, setAgendaSuggestionSource] = useState<'model' | 'fallback' | 'immediate' | null>(null)
  const [agendaSuggestionLoading, setAgendaSuggestionLoading] = useState(false)
  const agendaPrefetchTitleRef = useRef('')
  const agendaRequestRef = useRef(0)
  const agendaDraftEditedRef = useRef(false)
  const [workspaceTab, setWorkspaceTab] = useState<'meetings' | 'summary' | 'interventions' | 'knowledge' | 'facilitator' | 'settings'>('meetings')
  const [editingBlock, setEditingBlock] = useState<'title' | 'objective' | 'summary' | 'agenda' | 'decision' | 'task' | null>(null)
  const [globalEditMode, setGlobalEditMode] = useState(false)
  const [globalDraft, setGlobalDraft] = useState({ title: '', objective: '', contextNotes: '', summary: '', agenda: '', decisions: '', tasks: '' })
  const [editDraft, setEditDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem('iris-preferences') || '{}') as { interventionIntensity?: 'low' | 'medium' | 'high'; irisMuted?: boolean }; if (saved.interventionIntensity) setInterventionIntensity(saved.interventionIntensity); if (typeof saved.irisMuted === 'boolean') setIrisMuted(saved.irisMuted) } catch {} }, [])
  useEffect(() => { try { localStorage.setItem('iris-preferences', JSON.stringify({ interventionIntensity, irisMuted })) } catch {} }, [interventionIntensity, irisMuted])
  useEffect(() => { irisMutedRef.current = irisMuted; if (irisMuted) window.speechSynthesis?.cancel() }, [irisMuted])
  function handleSpeechStart() {
    speechOutputReadyRef.current = true
    setSpeechOutputReady(true)
    setSpeechOutputError('')
  }
  function handleSpeechError(error: string) {
    speechOutputReadyRef.current = false
    setSpeechOutputReady(false)
    setSpeechOutputError(error === 'not-allowed' || error === 'service-not-allowed'
      ? 'El dispositivo bloqueó la voz. Toca “Probar voz” para habilitarla y revisa el modo silencioso.'
      : 'No se pudo reproducir la voz. Toca “Probar voz” y revisa el volumen del dispositivo.')
    console.warn('[iris] speech synthesis playback failed', { error })
  }
  function speakIris(content: string, onStart?: () => void) {
    const queued = queueIrisSpeechChunk(content, {
      onStart: () => { handleSpeechStart(); onStart?.() },
      onError: handleSpeechError,
    })
    if (!queued) handleSpeechError('speech_unavailable')
    return queued
  }
  function activateIrisSpeech(force = false) {
    if (force) window.speechSynthesis?.cancel()
    if (!irisMutedRef.current && (force || !speechOutputReadyRef.current)) speakIris('Iris está lista. La voz funciona en este dispositivo.')
  }
  const selected = meetings.find((meeting) => meeting.id === selectedId)
  const readSourceRefs = (marker: string) => [...new Set(data.interventions.flatMap((item) => { const start = item.reason.indexOf(marker); return start < 0 ? [] : item.reason.slice(start + marker.length).split(' | ').map((source) => source.trim()).filter(Boolean) }))]
  const legacyCitations = data.interventions.flatMap((item) => {
    if (!item.content.startsWith('Encontré información relacionada en')) return []
    const title = item.content.match(/“([^”]+)”/)?.[1]
    return title ? [title] : []
  })
  const knowledgeUsage = { cited: [...new Set([...readSourceRefs('Fuentes consultadas: '), ...legacyCitations])], considered: readSourceRefs('Contexto disponible: ') }
  const meetingLinkedKnowledge = selectedId ? knowledge.filter((item) => item.validity === 'current' && item.source?.meetingId === selectedId) : []
  const openPyramidMode = () => { setWorkspaceOpen(false); setPepperGhostOpen(true); if (activePresentation?.level === 3) setPyramidState((current) => ({ ...current, speechContent: activePresentation.content })) }
  const openNewMeetingSetup = () => {
    if (session === 'listening' || session === 'connecting' || session === 'paused' || session === 'analyzing' || selected?.status === 'live') return
    setSelectedId(null)
    setData(emptyData)
    setSession('idle')
    setNewMeetingForm({ title: '', objective: '', contextNotes: '', agenda: '' })
    setSuggestedAgenda([])
    setAgendaSuggestionSource(null)
    setPreMeetingStep(0)
    setDataError('')
    setWorkspaceOpen(false)
    setWorkspaceTab('meetings')
    setNewMeetingOpen(true)
  }
  const configureSelectedMeeting = () => { if (!selected) return; setNewMeetingForm({ title: selected.title, objective: data.meeting?.objective || '', contextNotes: data.meeting?.contextNotes || '', agenda: data.agenda.slice().sort((a, b) => a.position - b.position).map((item) => item.title).join('\n') }); setPreMeetingStep(0); setDataError(''); setNewMeetingOpen(true) }
  async function copyTabletMonitorLink() { if (!selectedId) return; const url = `${window.location.origin}/monitor/${encodeURIComponent(selectedId)}`; try { await navigator.clipboard.writeText(url); setTabletLinkStatus('Enlace copiado; ábrelo en la tablet con la misma cuenta de Iris.') } catch { setTabletLinkStatus(url) } }
  const terminationRequestedRef = useRef(false)
  const forcePresentation = (level: 1 | 2 | 3) => { const content = level === 1 ? 'Prueba N1: mensaje discreto de Iris.' : level === 2 ? 'Prueba N2: Iris quiere llamar la atención sobre este punto.' : 'Prueba N3: intervención explícita de Iris.'; presentIntervention('simulation', { shouldIntervene: true, level, type: level === 1 ? 'generic' : 'off_topic', reason: 'forced_development_test', content, confidence: 1, evidence: ['fixture'] }, level === 1 ? 'signal' : level === 2 ? 'interventionLevel2' : 'interventionLevel3') }
  const runScenario = async (scenario: 'n1' | 'n2', times = 1) => { if (process.env.NODE_ENV === 'production') return; setScenarioRunning(`${scenario}-${times}`); const results: Array<{ suggestion: SuggestedIntervention | null; policy: InterventionPolicyResult | null; error?: string }> = []; for (let index = 0; index < times; index += 1) { try { const suggestion = await runProactiveScenarioAction(scenario); const policy = evaluateInterventionPolicy(suggestion, { intensity: 'medium' }); results.push({ suggestion, policy }); if (times === 1 && policy.action !== 'ignore') presentIntervention('simulation', suggestion, policy.action === 'signal' ? 'signal' : suggestion.level === 3 ? 'interventionLevel3' : 'interventionLevel2') } catch (error) { results.push({ suggestion: null, policy: null, error: error instanceof Error ? error.message : 'error desconocido' }) } } setScenarioResults((current) => ({ ...current, [scenario]: results })); setScenarioRunning(null) }
  async function saveMeetingDraft(startAfterSave = false) {
    const title = newMeetingForm.title.trim()
    if (!title) return
    setPending(true)
    try {
      const editingScheduledMeeting = selected?.status === 'scheduled'
      const meetingId = editingScheduledMeeting ? selected.id : crypto.randomUUID()
      const startedAt = editingScheduledMeeting ? new Date(selected.startedAt) : new Date()
      const agendaItems = newMeetingForm.agenda.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 4)
      const meetingContext = { objective: newMeetingForm.objective.trim(), contextNotes: newMeetingForm.contextNotes.trim() || null }

      await saveMeeting({ id: meetingId, title, ...meetingContext, startedAt, endedAt: null, status: startAfterSave ? 'live' : 'scheduled', participantNames: selected?.participantNames ?? [] })

      if (editingScheduledMeeting) {
        const existing = await listMeetingData(meetingId)
        await Promise.all(existing.agenda.map((item) => deleteAgendaItem({ id: item.id, meetingId })))
        await Promise.all(agendaItems.map((item, position) => saveAgendaItem({ id: crypto.randomUUID(), meetingId, title: item, position, status: position === 0 ? 'active' : 'pending', note: null })))
        const confirmedData = await listMeetingData(meetingId)
        setData((current) => ({ ...current, meeting: { ...meetingContext }, agenda: confirmedData.agenda }))
        setMeetings((current) => current.map((meeting) => meeting.id === meetingId ? { ...meeting, title, status: startAfterSave ? 'live' : 'scheduled' } : meeting))
      } else {
        await Promise.all(agendaItems.map((item, position) => saveAgendaItem({ id: crypto.randomUUID(), meetingId, title: item, position, status: position === 0 ? 'active' : 'pending', note: null })))
        const confirmedData = await listMeetingData(meetingId)
        if (process.env.NODE_ENV !== 'production') console.log('[v0] ACTIVE_MEETING_AGENDA_CONFIRMED', { activeMeetingId: meetingId, agendaItemsCount: confirmedData.agenda.length })
        setData({ ...emptyData, meeting: meetingContext, agenda: confirmedData.agenda })
        const createdMeeting = { id: meetingId, title, startedAt: startedAt.toISOString(), endedAt: null, status: startAfterSave ? 'live' : 'scheduled', participantNames: [], createdAt: startedAt.toISOString() }
        setMeetings((current) => [createdMeeting, ...current])
      }

      activeMeetingIdRef.current = startAfterSave ? meetingId : activeMeetingIdRef.current
      setSelectedId(meetingId)
      setNewMeetingOpen(false)
      setWorkspaceOpen(false)
      setWorkspaceTab('meetings')
      setSession(startAfterSave ? 'connecting' : 'idle')
      router.refresh()
      if (startAfterSave) setTimeout(() => void start(), 0)
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'No se pudo guardar la reunión.')
    } finally {
      setPending(false)
    }
  }
  function toggleFieldDictation(field: 'title' | 'objective' | 'contextNotes' | 'agenda') { if (dictatingField === field) { dictationRef.current?.stop(); dictationRef.current = null; setDictatingField(null); return } dictationRef.current?.stop(); const provider = new WebSpeechTranscriptionProvider('es-CL'); provider.onFinal((text) => setNewMeetingForm((current) => ({ ...current, [field]: `${current[field].trim()}${current[field].trim() ? ' ' : ''}${text}` }))).onError(() => { setDictatingField(null); dictationRef.current = null }); provider.onState((state) => { if (state === 'ended') { setDictatingField(null); dictationRef.current = null } }); try { provider.start(); dictationRef.current = provider; setDictatingField(field) } catch { setDictatingField(null); dictationRef.current = null } }
  async function generateAgendaSuggestion(force = false) {
    const title = newMeetingForm.title.trim()
    if (!title || (!force && (agendaPrefetchTitleRef.current === title || (newMeetingForm.agenda.trim() && !agendaDraftEditedRef.current)))) return
    agendaPrefetchTitleRef.current = title
    const requestId = ++agendaRequestRef.current
    setAgendaSuggestionLoading(true)
    try {
      const result = await suggestMeetingAgendaAction({ title, objective: newMeetingForm.objective, contextNotes: newMeetingForm.contextNotes })
      if (requestId !== agendaRequestRef.current || newMeetingFormRef.current.title.trim() !== title) return
      const cleanAgendaTitle = (value: string) => value.replace(/^\s*(?:\d+\s*[.)\-:]\s*)+/, '').trim()
      const cleanAgendaItems = result.agendaItems.map((item) => ({ ...item, title: cleanAgendaTitle(item.title.replaceAll('\\n', '\n')).slice(0, 80) })).filter((item, index, items) => items.findIndex((candidate) => candidate.title.toLocaleLowerCase() === item.title.toLocaleLowerCase()) === index).slice(0, 4)
      setSuggestedAgenda(cleanAgendaItems)
      setAgendaSuggestionSource(result.rationale.includes('Borrador disponible de inmediato') ? 'fallback' : 'model')
      if (!agendaDraftEditedRef.current) setNewMeetingForm((current) => ({ ...current, agenda: cleanAgendaItems.map((item) => item.title).join('\n') }))
    } catch {
      if (requestId === agendaRequestRef.current) setDataError('La minuta automática sigue en segundo plano; puedes editar el borrador disponible.')
    } finally {
      if (requestId === agendaRequestRef.current) setAgendaSuggestionLoading(false)
    }
  }
  function startFromScratch() { agendaDraftEditedRef.current = true; setSuggestedAgenda([]); setAgendaSuggestionSource(null); setNewMeetingForm((current) => ({ ...current, agenda: '' })); setDataError(''); }
  function requestAgendaRegeneration() { if (newMeetingForm.agenda.trim() && !window.confirm('¿Reemplazar la minuta editada por una nueva sugerencia?')) return; agendaDraftEditedRef.current = false; void generateAgendaSuggestion(true) }
  function advancePreMeeting() {
    if (preMeetingStep === 0 && newMeetingForm.title.trim()) void generateAgendaSuggestion()
    if (preMeetingStep === 2 && !newMeetingForm.agenda.trim() && suggestedAgenda.length === 0) {
      const draft = buildImmediateAgenda(newMeetingForm.title, newMeetingForm.objective, newMeetingForm.contextNotes)
      agendaDraftEditedRef.current = true
      setNewMeetingForm((current) => ({ ...current, agenda: draft.map((item) => item.title).join('\n') }))
    }
    setPreMeetingStep((step) => Math.min(4, step + 1))
  }
  function retreatPreMeeting() { setPreMeetingStep((step) => Math.max(0, step - 1)) }
  async function createNewMeeting(event: React.FormEvent) { event.preventDefault(); if (preMeetingStep < 3) { advancePreMeeting(); return } await saveMeetingDraft(true) }
  const setAutoAnalysisLifecycle = (enabled: boolean, reason: 'meeting_started' | 'meeting_finalized' | 'meeting_loaded' | 'meeting_paused' | 'meeting_unselected') => { setAutoAnalysis(enabled); if (!enabled) { autoAnalysisRequestRef.current += 1; autoAnalysisInFlightRef.current = false; lastAnalyzedSegmentIdRef.current = null }; if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_LIFECYCLE', { meetingId: selectedId, meetingStatus: selected?.status ?? null, enabled, reason }) }
  const status = useMemo(() => ({ idle: { label: 'Lista para empezar', detail: 'La captura está inactiva', tone: 'idle' }, connecting: { label: 'Conectando', detail: 'Solicitando acceso al micrófono', tone: 'live' }, listening: { label: 'Escuchando', detail: 'Captura activa · Web Speech', tone: 'live' }, paused: { label: 'Pausada', detail: 'La captura está detenida', tone: 'paused' }, analyzing: { label: 'Procesando reunión…', detail: 'Extrayendo resultados', tone: 'live' }, error: { label: 'Error de captura', detail: 'Revisa el micrófono o la conexión', tone: 'error' }, ended: { label: 'Sesión finalizada', detail: 'Reunión persistida', tone: 'ended' } }[session]), [session])
  const filteredSegments = useMemo(() => data.segments.filter((item) => item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [data.segments, query])
  const transcriptBlocks = useMemo(() => groupTranscriptSegments(data.segments.filter((item) => item.isFinal)), [data.segments])
  const liveCaption = interimTranscript.trim() || liveFinalSegments.at(-1)?.text || ''
  const recommendedAgendaText = suggestedAgenda.map((item) => item.title).join('\n')

  useEffect(() => { sessionStateRef.current = session }, [session])
  useEffect(() => { if (data.meeting && newMeetingOpen && selected?.status === 'scheduled') setNewMeetingForm({ title: selected.title, objective: data.meeting.objective, contextNotes: data.meeting.contextNotes ?? '', agenda: data.agenda.slice().sort((a, b) => a.position - b.position).map((item) => item.title).join('\n') }) }, [data.meeting, data.agenda, newMeetingOpen, selected])
  useEffect(() => { if (!initialSetupShownRef.current && !workspaceOpen && !selectedId && !newMeetingOpen) { initialSetupShownRef.current = true; setNewMeetingOpen(true); setPreMeetingStep(0) } }, [workspaceOpen, selectedId, newMeetingOpen])
  useEffect(() => {
    if (!newMeetingOpen) {
      agendaRequestRef.current += 1
      agendaPrefetchTitleRef.current = ''
      agendaDraftEditedRef.current = false
      setAgendaSuggestionLoading(false)
      return
    }
    if (!newMeetingForm.title.trim() || agendaPrefetchTitleRef.current === newMeetingForm.title.trim() || (newMeetingForm.agenda.trim() && !agendaDraftEditedRef.current)) return
    const timer = setTimeout(() => void generateAgendaSuggestion(), 350)
    return () => clearTimeout(timer)
  }, [newMeetingOpen, newMeetingForm.title, newMeetingForm.agenda])
  useEffect(() => {
    if (!newMeetingOpen || preMeetingStep !== 3 || newMeetingForm.agenda.trim() || suggestedAgenda.length > 0) return
    const draft = buildImmediateAgenda(newMeetingForm.title, newMeetingForm.objective, newMeetingForm.contextNotes)
    setSuggestedAgenda(draft)
    setAgendaSuggestionSource('immediate')
    if (!agendaDraftEditedRef.current) {
      agendaDraftEditedRef.current = true
      setNewMeetingForm((current) => ({ ...current, agenda: draft.map((item) => item.title).join('\n') }))
    }
  }, [newMeetingOpen, preMeetingStep, newMeetingForm.title, newMeetingForm.objective, newMeetingForm.contextNotes, newMeetingForm.agenda, agendaSuggestionLoading, suggestedAgenda.length])
  useEffect(() => { if (process.env.NODE_ENV !== 'production') void getIrisRuntimeDiagnosticsAction().then((diagnostics) => setRuntimeDiagnostics(diagnostics)).catch(() => setRuntimeDiagnostics(null)) }, [])
  useEffect(() => { listKnowledgeItems().then((items) => setKnowledge(items.map((item) => ({ ...item, source: item.source as KnowledgeItem['source'], sourceDate: item.sourceDate.toISOString() })))).catch(() => setKnowledge([])); void getVentanaCelesteStatus().then(setExternalStatus).catch(() => setExternalStatus('error')) }, [])
  useEffect(() => {
    const finals = data.segments.filter((segment) => segment.isFinal)
    const newCount = countNewFinalSegments(finals, lastAnalyzedSegmentIdRef.current)
    const triggerConfig = interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG : { minNewSegments: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].minNewSegments, minAnalysisIntervalMs: AUTO_ANALYSIS_MIN_INTERVAL_MS, confidenceThreshold: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].confidenceThreshold, cooldownMs: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs, signalCooldownMs: SIGNAL_COOLDOWN_MS }
    setNewSegmentCount(newCount)
    const now = Date.now(); const msSinceLastAnalysis = lastAnalysisAt === null ? null : now - lastAnalysisAt
    const meetingIsLive = selected?.status === 'live'
    const triggerBase = { enabled: autoAnalysis && meetingIsLive && session === 'listening' && Boolean(selectedId), meetingStatus: selected?.status ?? null, testMode: interventionTestMode, newSegments: newCount, requiredSegments: triggerConfig.minNewSegments, msSinceLastAnalysis, requiredIntervalMs: triggerConfig.minAnalysisIntervalMs, inferenceInProgress: autoAnalysisInFlightRef.current }
    setDiagnosticTrigger(triggerBase)
    if (!autoAnalysis || !meetingIsLive || session !== 'listening' || !selectedId) { if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_TRIGGER', { ...triggerBase, trigger: false, skipReason: 'disabled_or_not_listening' }); return }
    if (autoAnalysisInFlightRef.current) { if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_TRIGGER', { ...triggerBase, trigger: false, skipReason: 'inference_in_progress' }); return }
    if (newCount < triggerConfig.minNewSegments) { if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_TRIGGER', { ...triggerBase, trigger: false, skipReason: 'not_enough_new_segments' }); return }
    if (lastAnalysisAt !== null && now - lastAnalysisAt < triggerConfig.minAnalysisIntervalMs) { if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_TRIGGER', { ...triggerBase, trigger: false, skipReason: 'minimum_interval' }); return }
    setDiagnosticStages((current) => ({ ...current, trigger: 'success' })); addDiagnosticEvent('Trigger accepted'); if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_TRIGGER', { ...triggerBase, trigger: true, skipReason: null })
    const analysisMeetingId = selectedId
    if (!analysisMeetingId || (activeMeetingIdRef.current && activeMeetingIdRef.current !== analysisMeetingId)) { if (process.env.NODE_ENV !== 'production') console.warn('[v0] AUTO_ANALYSIS_SKIPPED_MEETING_MISMATCH', { selectedMeetingId: selectedId, sessionMeetingId: activeMeetingIdRef.current }); return }
    autoAnalysisInFlightRef.current = true
    const analysisRequestId = ++autoAnalysisRequestRef.current
    const analysisStartedAt = Date.now()
    setLiveAnalysisError('')
    setIrisVisualState(irisMuted ? 'muted' : 'analyzing'); setInterventionDiagnostic({ status: 'in_progress', latencyMs: null, suggestion: null, policy: null, newSegments: newCount, startedAt: analysisStartedAt, visualState: 'analyzing' })
    const latestId = latestFinalSegmentId(finals)
    lastAnalyzedSegmentIdRef.current = latestId
    setLastAnalysisAt(now)
    console.log('[v0] auto analysis started', { newSegments: newCount, millisecondsSincePreviousAnalysis: lastAnalysisAt === null ? null : now - lastAnalysisAt })
    void analyzeMeetingForInterventionAction(analysisMeetingId).then((suggestion) => {
      if (analysisRequestId !== autoAnalysisRequestRef.current || selectedMeetingIdRef.current !== analysisMeetingId || sessionMeetingRef.current !== analysisMeetingId) { if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_RESULT_DISCARDED', { meetingId: analysisMeetingId, selectedMeetingId: selectedMeetingIdRef.current, sessionMeetingId: sessionMeetingRef.current }); return }
      if (suggestion.type === 'provider_unavailable' || !suggestion.content.trim()) { const message = 'Iris no pudo analizar este tramo. Sigue escuchando y volverá a revisar cuando llegue más transcripción.'; setLiveAnalysisError(message); setDiagnosticStages((current) => ({ ...current, model: 'error' })); setInterventionDiagnostic({ status: 'error', latencyMs: Date.now() - analysisStartedAt, suggestion: null, policy: null, newSegments: newCount, startedAt: analysisStartedAt, visualState: irisMuted ? 'muted' : 'listening' }); lastAnalyzedSegmentIdRef.current = null; setIrisVisualState(irisMuted ? 'muted' : 'listening'); addDiagnosticEvent('model unavailable'); return }
      if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_MODEL_RESULT', { shouldIntervene: suggestion.shouldIntervene, level: suggestion.level, type: suggestion.type, confidence: suggestion.confidence })
      setDiagnosticStages((current) => ({ ...current, model: 'success' })); addDiagnosticEvent(`model level${suggestion.level}`); const result = evaluateInterventionPolicy(suggestion, { muted: irisMuted, cooldownUntil: cooldownUntilRef.current, recentInterventions: data.interventions, intensity: interventionIntensity, signalCooldownUntil: signalCooldownUntilRef.current, confidenceThreshold: interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.confidenceThreshold : undefined }); const nextVisualState: IrisVisualState = result.action === 'signal' ? 'signal' : result.action === 'show' ? (result.level === 3 ? 'interventionLevel3' : 'interventionLevel2') : (irisMuted ? 'muted' : 'listening'); setDiagnosticStages((current) => ({ ...current, policy: result.action === 'ignore' ? 'ignored' : 'success' })); addDiagnosticEvent(`policy ${result.action}`); if (process.env.NODE_ENV !== 'production') console.log('[v0] POLICY_RESULT', { action: result.action, reason: result.reason }); if (result.action !== 'ignore') { presentIntervention('ai', suggestion, result.action === 'signal' ? 'signal' : result.level === 3 ? 'interventionLevel3' : 'interventionLevel2') } setPolicyResult(result); if (result.action === 'signal') { signalCooldownUntilRef.current = Date.now() + (interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.signalCooldownMs : SIGNAL_COOLDOWN_MS); if (signalTimerRef.current) clearTimeout(signalTimerRef.current); signalTimerRef.current = setTimeout(() => setIrisVisualState(irisMuted ? 'muted' : 'listening'), 5000) }; if (result.action !== 'signal') setIrisVisualState(nextVisualState); if (process.env.NODE_ENV !== 'production') console.log('[v0] INTERVENTION_POLICY_RESULT', { intensity: interventionIntensity, suggestionShouldIntervene: suggestion.shouldIntervene, suggestionLevel: suggestion.level, suggestionConfidence: suggestion.confidence, threshold: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].confidenceThreshold, cooldownActive: result.cooldownActive, duplicateDetected: result.duplicateDetected, action: result.action, policyReason: result.reason, visualState: nextVisualState, signalDurationMs: result.action === 'signal' ? 5000 : 0 })
      if ((result.action === 'show' || result.action === 'signal') && !irisMuted) { if (result.action === 'signal') signalCooldownUntilRef.current = Date.now() + (interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.signalCooldownMs : SIGNAL_COOLDOWN_MS); else cooldownUntilRef.current = Date.now() + (interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.cooldownMs : INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs); const interventionId = crypto.randomUUID(); void createIntervention({ ...suggestion, id: interventionId, meetingId: analysisMeetingId, source: 'ai' }).then(() => { addDiagnosticEvent('persisted intervention'); if (selectedMeetingIdRef.current === analysisMeetingId) return refreshData() }).catch((error) => { console.error('[v0] auto intervention persistence failed', { meetingId: analysisMeetingId, error }); setLiveAnalysisError('La interacción se mostró, pero no se pudo sincronizar con el Monitor.') }) }
      const latencyMs = Date.now() - analysisStartedAt; setInterventionDiagnostic({ status: 'success', latencyMs, suggestion, policy: result, newSegments: newCount, startedAt: analysisStartedAt }); if (process.env.NODE_ENV !== 'production') console.log('[v0] AUTO_ANALYSIS_MEETING_ID', { activeMeetingId: activeMeetingIdRef.current, actionMeetingId: activeMeetingIdRef.current ?? selectedId }); console.log('[v0] AUTO_INTERVENTION_ANALYSIS', { meetingId: activeMeetingIdRef.current ?? selectedId, newSegments: newCount, transcriptSegmentCount: finals.length, transcriptCharacterCount: finals.reduce((total, segment) => total + segment.text.length, 0), intensity: interventionIntensity, confidenceThreshold: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].confidenceThreshold, cooldownMs: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs, latencyMs, shouldIntervene: suggestion.shouldIntervene, type: suggestion.type, level: suggestion.level, confidence: suggestion.confidence, policyAction: result.action, policyReason: result.reason, modelDiagnostics: { shouldIntervene: suggestion.shouldIntervene, type: suggestion.type, level: suggestion.level, confidence: suggestion.confidence, reasonLength: suggestion.reason.length, evidenceCount: suggestion.evidence.length }, status: 'success', containsDecisionKeyword: /decisi[oó]n/i.test(finals.map((segment) => segment.text).join(' ')), containsTaskKeyword: /tarea/i.test(finals.map((segment) => segment.text).join(' ')) })
    }).catch((error) => { if (analysisRequestId !== autoAnalysisRequestRef.current || selectedMeetingIdRef.current !== analysisMeetingId || sessionMeetingRef.current !== analysisMeetingId) return; const latencyMs = Date.now() - analysisStartedAt; lastAnalyzedSegmentIdRef.current = null; setLiveAnalysisError('Iris no pudo analizar este tramo. Sigue escuchando y volverá a revisar cuando llegue más transcripción.'); setIrisVisualState(irisMuted ? 'muted' : 'listening'); setInterventionDiagnostic((current) => ({ ...current, status: 'error', latencyMs, visualState: irisMuted ? 'muted' : 'listening' })); if (process.env.NODE_ENV !== 'production') console.error('[v0] AUTO_INTERVENTION_ANALYSIS', { meetingId: activeMeetingIdRef.current ?? selectedId, newSegments: newCount, transcriptSegmentCount: finals.length, transcriptCharacterCount: finals.reduce((total, segment) => total + segment.text.length, 0), intensity: interventionIntensity, confidenceThreshold: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].confidenceThreshold, cooldownMs: INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs, latencyMs, shouldIntervene: false, type: null, level: null, confidence: null, policyAction: 'ignore', policyReason: error instanceof Error ? error.message : 'unknown_error', status: 'error', containsDecisionKeyword: /decisi[oó]n/i.test(finals.map((segment) => segment.text).join(' ')), containsTaskKeyword: /tarea/i.test(finals.map((segment) => segment.text).join(' ')) }) }).finally(() => { if (analysisRequestId === autoAnalysisRequestRef.current) autoAnalysisInFlightRef.current = false })
  }, [autoAnalysis, data.interventions, data.segments, interventionIntensity, interventionTestMode, irisMuted, lastAnalysisAt, selected, selectedId, session])
  const activeAgenda = data.agenda.find((item) => item.status === 'active')
  const agendaIndex = activeAgenda ? data.agenda.slice().sort((a, b) => a.position - b.position).findIndex((item) => item.id === activeAgenda.id) + 1 : 0
  const minuteSections = useMemo(() => ({ objective: data.meeting?.objective || 'Sin objetivo definido', agenda: data.agenda.slice().sort((a, b) => a.position - b.position), decisions: data.decisions, tasks: data.tasks, commitments: detections?.commitments ?? [], openQuestions: detections?.openQuestions ?? [] }), [data.agenda, data.decisions, data.meeting, data.tasks, detections])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopAudio()
    }
  }, [])

  useEffect(() => {
    setAutoAnalysisLifecycle(selected?.status === 'live', selected ? 'meeting_loaded' : 'meeting_unselected')
    let cancelled = false
    if (!selectedId) { setData(emptyData); liveFinalSegmentsRef.current = []; setLiveFinalSegments([]); setInterimTranscript(''); setLoadingData(false); return }
    setLoadingData(true); setData(emptyData); setDataError(''); setQuery(''); setDetections(null); setMeetingSummary(null); setExtractionError(''); setSummaryError(''); setInterventionDiagnostic({ status: 'idle', latencyMs: null, suggestion: null, policy: null, newSegments: 0, startedAt: null }); setPostMeetingDiagnostic({ extraction: { status: 'idle', decisionsCount: 0, tasksCount: 0, commitmentsCount: 0, openQuestionsCount: 0, latencyMs: null }, summary: { status: 'idle', summaryCharacterCount: 0, topicsCount: 0, keyPointsCount: 0, latencyMs: null } })
    const liveLoadId = selected?.status === 'live' ? (activeMeetingIdRef.current ?? selectedId) : selectedId
    if (process.env.NODE_ENV !== 'production' && selected?.status === 'live') console.log('[v0] LIVE_REFRESH_MEETING_ID', { activeMeetingId: activeMeetingIdRef.current, refreshMeetingId: liveLoadId })
    listMeetingData(liveLoadId).then((next) => { if (!cancelled) { const persistedSegments = next.segments.map((item) => ({ ...item, startedAt: item.startedAt.toISOString(), endedAt: item.endedAt.toISOString() })); const persistedIds = new Set(persistedSegments.map((segment) => segment.id)); const reconciledSegments = [...persistedSegments, ...liveFinalSegmentsRef.current.filter((segment) => !persistedIds.has(segment.id))].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()); liveFinalSegmentsRef.current = liveFinalSegmentsRef.current.filter((segment) => !persistedIds.has(segment.id)); setLiveFinalSegments(liveFinalSegmentsRef.current); setData({ meeting: next.meeting, agenda: next.agenda, interventions: next.interventions.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })), segments: reconciledSegments, tasks: next.tasks.map((item) => ({ ...item, dueDate: item.dueDate?.toISOString() ?? null })), decisions: next.decisions, suggestions: next.suggestions }); if (next.summary) { setMeetingSummary({ summary: next.summary.summary, topics: next.summary.topics, keyPoints: next.summary.keyPoints }); setDetections({ tasks: [], decisions: [], commitments: next.summary.commitments as Detections['commitments'], openQuestions: next.summary.openQuestions as Detections['openQuestions'] }) } } }).catch(() => { if (!cancelled) { setData(emptyData); setDataError('No se pudieron cargar los datos de esta reunión.') } }).finally(() => { if (!cancelled) setLoadingData(false) })
    return () => { cancelled = true }
  }, [selectedId, selected?.status])

  async function refreshData() { const refreshMeetingId = selected?.status === 'live' ? (activeMeetingIdRef.current ?? selectedId) : selectedId; if (refreshMeetingId) { if (process.env.NODE_ENV !== 'production' && selected?.status === 'live') console.log('[v0] LIVE_REFRESH_MEETING_ID', { activeMeetingId: activeMeetingIdRef.current, refreshMeetingId }); const next = await listMeetingData(refreshMeetingId); const persistedSegments = next.segments.map((item) => ({ ...item, startedAt: item.startedAt.toISOString(), endedAt: item.endedAt.toISOString() })); const persistedIds = new Set(persistedSegments.map((segment) => segment.id)); const reconciledSegments = [...persistedSegments, ...liveFinalSegmentsRef.current.filter((segment) => !persistedIds.has(segment.id))].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()); liveFinalSegmentsRef.current = liveFinalSegmentsRef.current.filter((segment) => !persistedIds.has(segment.id)); setLiveFinalSegments(liveFinalSegmentsRef.current); setData({ meeting: next.meeting, agenda: next.agenda, interventions: next.interventions.map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })), segments: reconciledSegments, tasks: next.tasks.map((item) => ({ ...item, dueDate: item.dueDate?.toISOString() ?? null })), decisions: next.decisions, suggestions: next.suggestions }); if (next.summary) { setMeetingSummary({ summary: next.summary.summary, topics: next.summary.topics, keyPoints: next.summary.keyPoints }); setDetections({ tasks: [], decisions: [], commitments: next.summary.commitments as Detections['commitments'], openQuestions: next.summary.openQuestions as Detections['openQuestions'] }) } } }
  async function runAnalysis() { if (!selectedId || analyzing) return; setAnalyzing(true); setAnalysisError(''); try { await analyzeMeeting(selectedId); await refreshData() } catch (error) { setAnalysisError(error instanceof Error ? error.message : 'No se pudo analizar la reunión.') } finally { setAnalyzing(false) } }
  async function extractResults() { if (!selectedId || extractingResults) return; setExtractingResults(true); setExtractionError(''); setAnalysisError(''); try { setDetections(await getMeetingDetections(selectedId)); setConfirmedDetectionKeys(new Set()) } catch (error) { setExtractionError(error instanceof Error ? error.message : 'No se pudieron extraer los resultados.') } finally { setExtractingResults(false) } }
  async function retrySummary() { if (!selectedId || summaryLoading) return; setSummaryLoading(true); setSummaryError(''); try { setMeetingSummary(await getMeetingSummary(selectedId)) } catch { setSummaryError('No se pudo generar la minuta.') } finally { setSummaryLoading(false) } }
  function exportMeeting(kind: 'transcript' | 'summary' | 'all') { if (!selected || !data.meeting) return; const transcript = `TRANSCRIPCIÓN\n\nReunión: ${selected.title}\nFecha: ${new Date(selected.startedAt).toLocaleString('es-CL')}\n\n${data.segments.filter((item) => item.isFinal).map((item) => `[${new Date(item.startedAt).toLocaleTimeString('es-CL')}] ${item.speaker}: ${item.text}`).join('\\n') || 'Sin segmentos.'}`; const summary = `MINUTA Y RESULTADOS\n\nObjetivo\n${data.meeting.objective || 'Sin objetivo definido'}\n\nResumen ejecutivo\n${meetingSummary?.summary || 'Sin resumen generado.'}\n\nAgenda\n${data.agenda.slice().sort((a, b) => a.position - b.position).map((item) => `- ${item.title} (${item.status})`).join('\\n') || 'No hay agenda definida.'}\n\nDecisiones\n${data.decisions.map((item) => `- ${item.text} [${item.status}]`).join('\\n') || 'Sin decisiones.'}\n\nTareas\n${data.tasks.map((item) => `- ${item.text}${item.assignee ? ` · ${item.assignee}` : ''}${item.dueDate ? ` · ${new Date(item.dueDate).toLocaleDateString('es-CL')}` : ''} [${item.status}]`).join('\\n') || 'Sin tareas.'}\n\nCompromisos\n${detections?.commitments.map((item) => `- ${item.text}${item.assignee ? ` · ${item.assignee}` : ''}`).join('\\n') || 'Sin compromisos registrados.'}\n\nPreguntas abiertas\n${detections?.openQuestions.map((item) => `- ${item.text}`).join('\\n') || 'Sin preguntas abiertas.'}`; const guide = `GUÍA ENTREGADA Y RESPUESTA OBSERVADA\n\n${data.interventions.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((item) => `[${new Date(item.createdAt).toLocaleTimeString('es-CL')}] Nivel ${item.level} · ${item.type} · ${item.source === 'ai' ? 'Iris' : 'Manual'}\\nGuía entregada: ${item.content}\\nMotivo/evidencia: ${item.reason}\\nReacción evaluada: ${item.observation || 'Sin evaluación'}\\nEstado: ${item.status}`).join('\\n\\n') || 'No se registraron intervenciones.'}`; const content = kind === 'transcript' ? transcript : kind === 'summary' ? summary : `${summary}\\n\\n${guide}\\n\\n${transcript}`; const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${selected.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${kind}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }
  function beginEdit(block: 'title' | 'objective' | 'summary' | 'agenda' | 'decision' | 'task', value: string, id?: string) { setEditingBlock(block); setEditingId(id ?? null); setEditDraft(value) }
  function enterGlobalEditMode() { setGlobalDraft({ title: selected?.title || '', objective: data.meeting?.objective || '', contextNotes: data.meeting?.contextNotes || '', summary: meetingSummary?.summary || '', agenda: data.agenda.slice().sort((a, b) => a.position - b.position).map((item) => item.title).join('\n'), decisions: data.decisions.map((item) => item.text).join('\n'), tasks: data.tasks.map((item) => item.text).join('\n') }); setGlobalEditMode(true) }
  async function saveGlobalEdits() {
    if (!selected) return
    setPending(true)
    try {
      await saveMeeting({ id: selected.id, title: globalDraft.title.trim() || selected.title, objective: globalDraft.objective.trim(), contextNotes: globalDraft.contextNotes.trim() || null, startedAt: new Date(selected.startedAt), endedAt: selected.endedAt ? new Date(selected.endedAt) : null, status: selected.status, participantNames: selected.participantNames })
      if (meetingSummary) await updateMeetingSummary({ meetingId: selected.id, summary: globalDraft.summary.trim(), topics: meetingSummary.topics, keyPoints: meetingSummary.keyPoints })
      const agendaLines = globalDraft.agenda.split('\n').map((line) => line.trim()).filter(Boolean)
      const agendaItems = data.agenda.slice().sort((a, b) => a.position - b.position)
      const agendaItemsToDelete = new Map(agendaItems.map((item) => [item.id, item]))
      for (const [index, title] of agendaLines.entries()) {
        const exactMatch = agendaItems.find((item) => agendaItemsToDelete.has(item.id) && item.title === title)
        const indexedMatch = agendaItems[index]
        const current = exactMatch ?? (indexedMatch && !agendaLines.includes(indexedMatch.title) && agendaItemsToDelete.has(indexedMatch.id) ? indexedMatch : undefined)
        if (current) {
          agendaItemsToDelete.delete(current.id)
          await saveAgendaItem({ ...current, title, position: index })
        } else {
          await saveAgendaItem({ id: crypto.randomUUID(), meetingId: selected.id, title, position: index, status: index === 0 && agendaItems.length === 0 ? 'active' : 'pending', note: null })
        }
      }
      for (const item of agendaItemsToDelete.values()) await deleteAgendaItem({ id: item.id, meetingId: selected.id })
      for (const [index, item] of data.decisions.entries()) {
        const next = globalDraft.decisions.split('\n').map((line) => line.trim()).filter(Boolean)[index]
        if (next && next !== item.text) await saveDecision({ ...item, text: next })
      }
      for (const [index, item] of data.tasks.entries()) {
        const next = globalDraft.tasks.split('\n').map((line) => line.trim()).filter(Boolean)[index]
        if (next && next !== item.text) await updateTask({ id: item.id, meetingId: selected.id, changes: { text: next } })
      }
      setGlobalEditMode(false)
      await refreshData()
    } finally {
      setPending(false)
    }
  }

  function editDetection(type: 'task' | 'decision' | 'commitment' | 'question', index: number, changes: Record<string, string>) { setDetections((current) => { if (!current) return current; const key = type === 'task' ? 'tasks' : type === 'decision' ? 'decisions' : type === 'commitment' ? 'commitments' : 'openQuestions'; const next = [...current[key]] as Array<Record<string, unknown>>; next[index] = { ...next[index], ...changes }; return { ...current, [key]: next } as Detections }) }
  async function confirmDetection(type: 'task' | 'decision' | 'commitment' | 'question', item: Detections['tasks'][number] | Detections['decisions'][number] | Detections['commitments'][number] | Detections['openQuestions'][number]) { if (!selectedId) return; const key = `${type}:${item.text.trim().toLocaleLowerCase()}`; try { if (type === 'task') await confirmExtractedTask({ ...item, meetingId: selectedId }); else if (type === 'decision') await confirmExtractedDecision({ ...item, meetingId: selectedId }); else if (type === 'commitment') await confirmExtractedCommitment({ ...item, meetingId: selectedId }); else await confirmExtractedQuestion({ ...item, meetingId: selectedId }); setConfirmedDetectionKeys((current) => new Set(current).add(key)); await refreshData(); const items = await listKnowledgeItems(); setKnowledge(items.map((entry) => ({ ...entry, source: entry.source as KnowledgeItem['source'], sourceDate: entry.sourceDate.toISOString() }))) } catch (error) { setAnalysisError(error instanceof Error ? error.message : 'No se pudo confirmar el resultado.') } }
  function simulateIntervention(level: 1 | 2 | 3) { const suggestion: SuggestedIntervention = { shouldIntervene: true, level, type: level === 1 ? 'listening' : 'generic', reason: `Simulación visual nivel ${level}`, content: level === 1 ? 'Señal visual de prueba' : level === 2 ? 'Sugerencia de prueba para el facilitador' : 'Intervención urgente de prueba', confidence: 1, evidence: ['UI simulation'] }; presentIntervention('simulation', suggestion, level === 1 ? 'listening' : level === 2 ? 'interventionLevel2' : 'interventionLevel3'); setDiagnosticStages((current) => ({ ...current, ui: 'success' })); addDiagnosticEvent(`UI simulation level ${level}`) }
  async function runInterventionAnalysis() {
    if (!selectedId || analyzingIntervention) return
    const startedAt = performance.now()
    setAnalyzingIntervention(true)
    setInterventionLatencyMs(null)
    setAnalysisError('')
    try {
      const result = await analyzeMeetingForInterventionAction(selectedId)
      if (result.type === 'provider_unavailable' || !result.content.trim()) {
        setSuggestedIntervention(null)
        setDiagnosticStages((current) => ({ ...current, model: 'error', policy: 'ignored' }))
        setInterventionDiagnostic({ status: 'error', latencyMs: Math.round(performance.now() - startedAt), suggestion: null, policy: null, newSegments: data.segments.filter((segment) => segment.isFinal).length, startedAt: Date.now(), visualState: irisMuted ? 'muted' : 'listening' })
        setAnalysisError('Iris no pudo analizar la transcripción. Vuelve a intentarlo cuando el servicio responda.')
        addDiagnosticEvent('model unavailable')
        return
      }
      setSuggestedIntervention(result)
      setDiagnosticStages((current) => ({ ...current, model: 'success' }))
      addDiagnosticEvent(`model level${result.level}`)
      const policy = evaluateInterventionPolicy(result, { muted: irisMuted, cooldownUntil: cooldownUntilRef.current, recentInterventions: data.interventions, intensity: interventionIntensity, signalCooldownUntil: signalCooldownUntilRef.current, confidenceThreshold: interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.confidenceThreshold : undefined })
      setPolicyResult(policy)
      setInterventionDiagnostic({ status: 'success', latencyMs: Math.round(performance.now() - startedAt), suggestion: result, policy, newSegments: data.segments.filter((segment) => segment.isFinal).length, startedAt: Date.now(), visualState: policy.action === 'signal' ? 'signal' : policy.action === 'show' ? (policy.level === 3 ? 'interventionLevel3' : 'interventionLevel2') : 'listening' })
      setDiagnosticStages((current) => ({ ...current, policy: policy.action === 'ignore' ? 'ignored' : 'success' }))
      addDiagnosticEvent(`policy ${policy.action}`)
      if (policy.action !== 'ignore') presentIntervention('ai', result, policy.action === 'signal' ? 'signal' : policy.level === 3 ? 'interventionLevel3' : 'interventionLevel2')
      if ((policy.action === 'show' || policy.action === 'signal') && !irisMuted) {
        if (policy.action === 'signal') signalCooldownUntilRef.current = Date.now() + (interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.signalCooldownMs : SIGNAL_COOLDOWN_MS)
        else cooldownUntilRef.current = Date.now() + (interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.cooldownMs : INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs)
        await createIntervention({ ...result, id: crypto.randomUUID(), meetingId: selectedId, source: 'ai' })
        addDiagnosticEvent('persisted intervention')
        await refreshData()
      }
      setInterventionLatencyMs(Math.round(performance.now() - startedAt))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo generar una propuesta.'
      setAnalysisError(message === 'Cloudflare está sin capacidad disponible. Intenta nuevamente.' ? message : message === 'Cloudflare tardó demasiado en responder.' ? 'El análisis tardó demasiado para una intervención en tiempo real.' : message)
    } finally {
      setAnalyzingIntervention(false)
    }
  }
  async function acceptSuggestedIntervention() { if (!selectedId || !suggestedIntervention?.shouldIntervene || suggestedIntervention.level === 0) return; const result = evaluateInterventionPolicy(suggestedIntervention, { muted: irisMuted, cooldownUntil: cooldownUntilRef.current, recentInterventions: data.interventions, intensity: interventionIntensity, signalCooldownUntil: signalCooldownUntilRef.current, confidenceThreshold: interventionTestMode ? INTERVENTION_TEST_MODE_CONFIG.confidenceThreshold : undefined }); setPolicyResult(result); if (result.action === 'ignore') return; const visualState: IrisVisualState = result.action === 'signal' ? 'signal' : result.level === 3 ? 'interventionLevel3' : 'interventionLevel2'; presentIntervention('ai', suggestedIntervention, visualState); addDiagnosticEvent(`policy ${result.action}`); try { await createIntervention({ ...suggestedIntervention, id: crypto.randomUUID(), meetingId: selectedId, source: 'ai' }); addDiagnosticEvent('persisted intervention'); if (result.action === 'signal') signalCooldownUntilRef.current = Date.now() + SIGNAL_COOLDOWN_MS; else cooldownUntilRef.current = Date.now() + INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs; setSuggestedIntervention(null); await refreshData() } catch (error) { setAnalysisError(error instanceof Error ? error.message : 'No se pudo crear la intervención.') } }
  async function saveEditableBlock() { if (!selectedId) return; if (editingBlock === 'title' && selected) await saveMeeting({ id: selected.id, title: editDraft, objective: data.meeting?.objective || '', contextNotes: data.meeting?.contextNotes || null, startedAt: new Date(selected.startedAt), endedAt: selected.endedAt ? new Date(selected.endedAt) : null, status: selected.status, participantNames: selected.participantNames }); if (editingBlock === 'objective') await saveMeetingContext({ id: selectedId, objective: editDraft, contextNotes: data.meeting?.contextNotes || null }); if (editingBlock === 'summary' && meetingSummary) await updateMeetingSummary({ meetingId: selectedId, summary: editDraft, topics: meetingSummary.topics, keyPoints: meetingSummary.keyPoints }); if (editingBlock === 'decision' && editingId) { const decision = data.decisions.find((item) => item.id === editingId); if (decision) await saveDecision({ ...decision, text: editDraft }) } if (editingBlock === 'task' && editingId) { const task = data.tasks.find((item) => item.id === editingId); if (task) await updateTask({ id: task.id, meetingId: selectedId, changes: { text: editDraft } }) } setEditingBlock(null); setEditingId(null); setEditDraft(''); await refreshData() }
  async function submitKnowledge(event: React.FormEvent) { event.preventDefault(); if (!knowledgeDraft.title.trim() || !knowledgeDraft.content.trim()) return; setKnowledgeLoading(true); try { await saveKnowledgeItem({ id: knowledgeDraft.id || crypto.randomUUID(), title: knowledgeDraft.title, content: knowledgeDraft.content, type: knowledgeDraft.type, sourceLabel: knowledgeDraft.sourceLabel || null, meetingId: selectedId, validity: 'current' }); const items = await listKnowledgeItems(); setKnowledge(items.map((item) => ({ ...item, source: item.source as KnowledgeItem['source'], sourceDate: item.sourceDate.toISOString() }))); setKnowledgeDraft({ id: '', title: '', type: 'note', content: '', sourceLabel: '' }); setKnowledgeOpen(false) } finally { setKnowledgeLoading(false) } }
  async function removeKnowledge(item: KnowledgeItem) { if (!window.confirm(`¿Eliminar “${item.title}”?`)) return; await deleteKnowledgeItem(item.id); setKnowledge((current) => current.filter((entry) => entry.id !== item.id)) }
  async function previewImport() { if (!importRaw.trim()) return; setImportLoading(true); setImportSummary(null); try { const items = await previewVentanaCelesteImport({ raw: importRaw, format: importFormat }); setImportPreview(items); setImportSelected(new Set(items.map((item) => item.id))) } catch (error) { setImportSummary({ imported: 0, updated: 0, duplicates: 0, errors: [error instanceof Error ? error.message : 'Formato no válido'] }) } finally { setImportLoading(false) } }
  async function confirmImport() { const items = importPreview.filter((item) => importSelected.has(item.id)); setImportLoading(true); try { const summary = await importVentanaCelesteItems({ items }); setImportSummary(summary); const refreshed = await listKnowledgeItems(); setKnowledge(refreshed.map((item) => ({ ...item, source: item.source as KnowledgeItem['source'], sourceDate: item.sourceDate.toISOString() }))) } finally { setImportLoading(false) } }
  async function checkExternalStatus() { setExternalMessage(''); try { const status = await getVentanaCelesteStatus(); setExternalStatus(status); if (status === 'not_configured') setExternalMessage('La conexión automática requiere acceso de servicio a Ventana Celeste. Puedes seguir usando la importación manual.') } catch { setExternalStatus('error'); setExternalMessage('No se pudo comprobar la configuración.') } }
  async function testExternalConnection() { setExternalMessage(''); const result = await testVentanaCelesteConnection(); setExternalStatus(result.status); setExternalMessage(result.message) }
  async function exploreExternalContent() { setExternalMessage(''); const result = await listVentanaCelesteContent(); setExternalItems(result.items); setExternalSelected(new Set(result.items.map((item) => item.id))); setExternalStatus(result.error ? 'error' : 'connected'); setExternalMessage(result.error ?? `${result.items.length} contenidos disponibles.`) }
  async function importExternalSelected() { const items = externalItems.filter((item) => externalSelected.has(item.id)); setImportLoading(true); try { setImportSummary(await importVentanaCelesteItems({ items })); const refreshed = await listKnowledgeItems(); setKnowledge(refreshed.map((item) => ({ ...item, source: item.source as KnowledgeItem['source'], sourceDate: item.sourceDate.toISOString() }))) } finally { setImportLoading(false) } }
  async function dispatchIntervention(event: React.FormEvent) { event.preventDefault(); if (!selectedId) return; setInterventionError(''); try { await createIntervention({ ...interventionDraft, id: crypto.randomUUID(), meetingId: selectedId, level: Number(interventionDraft.level), source: 'manual' }); setInterventionDraft({ level: 2, type: 'generic', reason: '', content: '' }); await refreshData() } catch (error) { setInterventionError(error instanceof Error ? error.message : 'No se pudo registrar la intervención.') } }
  function isLikelyFollowUp(text: string) { return /\?|^(y\s+)?(qu[eé]|cu[aá]l|cu[aá]ndo|qui[eé]n|por qu[eé]|c[oó]mo|d[oó]nde)\b/i.test(text.trim()) }
  function armFollowUp(user: string, iris: string) { if (followUpTimerRef.current) clearTimeout(followUpTimerRef.current); followUpRef.current = { expiresAt: Date.now() + 12000, user, iris }; setFollowUpMode(true); followUpTimerRef.current = setTimeout(() => { followUpRef.current = null; setFollowUpMode(false) }, 12000) }
  function stopAudio(reason = 'manual') {
    console.log('[v0] speech recognition stopping', { reason })
    speechRef.current?.stop()
    speechRef.current = null
    sessionMeetingRef.current = null
    setInterimTranscript('')
    if (signalTimerRef.current) { clearTimeout(signalTimerRef.current); signalTimerRef.current = null }
    if (mountedRef.current && reason !== 'unmount') { setIrisVisualState(irisMuted ? 'muted' : 'idle'); setSession('paused') }
  }
  async function startSpeech(meetingId: string) {
    const provider = new WebSpeechTranscriptionProvider('es-CL')
    if (!provider.supported) throw new Error('El reconocimiento de voz requiere un navegador compatible, recomendado Chrome.')
    console.log('[v0] speech recognition supported', { language: 'es-CL' })
    provider.onInterim((text) => { if (mountedRef.current) { setInterimTranscript(text); if (sessionStateRef.current === 'listening' && irisVisualState !== 'signal' && !autoAnalysisInFlightRef.current) setIrisVisualState('listening'); console.log('[v0] interim transcript length', { length: text.length }) } })
    provider.onFinal((text) => {
      const now = new Date(); const transcriptMeetingId = activeMeetingIdRef.current ?? meetingId
      if (process.env.NODE_ENV !== 'production') console.log('[v0] LIVE_MEETING_IDENTITY', { activeMeetingId: activeMeetingIdRef.current, selectedMeetingId: selectedId, transcriptMeetingId })
      const segment: Segment = { id: crypto.randomUUID(), meetingId: transcriptMeetingId, speaker: 'Participante', text, startedAt: now.toISOString(), endedAt: now.toISOString(), isFinal: true }; liveFinalSegmentsRef.current = [...liveFinalSegmentsRef.current, segment]; setLiveFinalSegments(liveFinalSegmentsRef.current); setInterimTranscript('')
      if (process.env.NODE_ENV !== 'production') console.log('[v0] DIRECT_SPEECH_FINAL', { segmentId: segment.id, textPreview: text.trim().slice(0, 80), pendingWakeWord: Boolean(pendingDirectWakeRef.current) })
      void handleDirectIrisInvocation(text, transcriptMeetingId, segment.id)
      console.log('[v0] final transcript received', { length: text.length })
      transcriptWritesRef.current += 1
      const write = saveTranscriptSegment({ id: segment.id, meetingId: transcriptMeetingId, speaker: 'Participante', text, startedAt: now, endedAt: now, isFinal: true }).then(() => { console.log('[v0] final segment persisted', { length: text.length }); return refreshData() }).catch((error) => console.error('[v0] final segment persistence failed', error)).finally(() => { transcriptWritesRef.current -= 1; if (transcriptWritesRef.current === 0) { transcriptWriteWaitersRef.current.splice(0).forEach((resolve) => resolve()) } })
      void write
    })
    provider.onError((code: SpeechRecognitionErrorCode) => {
      const normalizedCode = typeof code === 'string' && code.trim() ? code : 'unknown'
      if (normalizedCode === 'no-speech' || normalizedCode === 'aborted') {
        console.log('[v0] speech recognition recovered', { code: normalizedCode })
        return
      }
      console.warn('[v0] speech recognition error', { code: normalizedCode })
      if (normalizedCode === 'not-allowed' || normalizedCode === 'service-not-allowed') { setAudioError('Permiso de micrófono denegado. Habilítalo en el navegador para continuar.'); setSession('error') }
      else if (normalizedCode === 'audio-capture') setAudioError('No hay un micrófono disponible.')
      else if (normalizedCode === 'network') setAudioError('La red de reconocimiento está inestable; Iris seguirá intentando escuchar.')
      else setAudioError('El reconocimiento de voz encontró un error. Puedes volver a intentarlo.')
    })
    provider.onState((state) => { if (state === 'started') { console.log('[v0] recognition started'); setSession('listening'); setIrisVisualState(irisMuted ? 'muted' : 'listening') } else console.log('[v0] recognition ended') })
    speechRef.current = provider
    provider.start()
  }
  /* AssemblyAI is intentionally disabled while Web Speech provides the interim/final flow. */
  /*
  function stopAudioLegacy(reason = 'manual') {
    console.log('[v0] stopping audio', { reason })
    if (sessionTimerRef.current) { clearTimeout(sessionTimerRef.current); sessionTimerRef.current = null }
    const audio = audioRef.current
    if (!audio) return
    audio.processor.disconnect()
    audio.source.disconnect()
    audio.stream.getTracks().forEach((track) => track.stop())
    if (audio.context.state !== 'closed') void audio.context.close()
    if (audio.socket.readyState === WebSocket.OPEN && !terminationRequestedRef.current) {
      terminationRequestedRef.current = true
      console.log('[v0] sending AssemblyAI terminate', { readyState: audio.socket.readyState })
      audio.socket.send(JSON.stringify({ type: 'Terminate' }))
      return
    }
    if (audio.socket.readyState === WebSocket.CONNECTING) audio.socket.close(1000, reason.slice(0, 120))
    audioRef.current = null
    sessionMeetingRef.current = null
  }
  function downsample(buffer: Float32Array, inputRate: number, outputRate = 16000) {
    if (inputRate === outputRate) return buffer
    const ratio = inputRate / outputRate
    const output = new Float32Array(Math.max(1, Math.round(buffer.length / ratio)))
    for (let i = 0; i < output.length; i++) {
      const position = i * ratio
      const left = Math.floor(position)
      const right = Math.min(left + 1, buffer.length - 1)
      const weight = position - left
      output[i] = buffer[left] * (1 - weight) + buffer[right] * weight
    }
    return output
  }
  function encodePCM(buffer: Float32Array) {
    const pcm = new Int16Array(buffer.length)
    for (let i = 0; i < buffer.length; i++) pcm[i] = Math.max(-1, Math.min(1, buffer[i])) < 0 ? Math.max(-1, Math.min(1, buffer[i])) * 0x8000 : Math.max(-1, Math.min(1, buffer[i])) * 0x7fff
    return pcm.buffer
  }
  async function start() {
    if (pending || audioRef.current) return
    setPending(true); setAudioError('')
    let meetingId = selectedId
    let context: AudioContext | null = null
    try {
      // Construct and resume synchronously from the click before network/media awaits.
      context = new AudioContext()
      console.log('[v0] audio context created from user gesture', { state: context.state, sampleRate: context.sampleRate })
      const resumed = await context.resume()
      console.log('[v0] audio context resumed', { state: context.state, resumeResult: resumed })
      if (context.state !== 'running') throw new Error(`AudioContext no pudo iniciar: ${context.state}`)
      if (!meetingId) {
        meetingId = crypto.randomUUID(); const now = new Date(); const title = `Reunión de coordinación · ${now.toLocaleDateString('es-ES')}`
        await saveMeeting({ id: meetingId, title, startedAt: now, status: 'live', participantNames: [] })
        setMeetings((current) => [{ id: meetingId!, title, startedAt: now.toISOString(), endedAt: null, status: 'live', participantNames: [], createdAt: now.toISOString() }, ...current]); setSelectedId(meetingId)
      }
      else {
        const existing = meetings.find((meeting) => meeting.id === meetingId)
        if (existing && existing.status !== 'live') {
          const persisted = await listMeetingData(meetingId)
          await saveMeeting({ id: existing.id, title: existing.title, objective: persisted.meeting?.objective || '', contextNotes: persisted.meeting?.contextNotes || null, startedAt: new Date(existing.startedAt), endedAt: null, status: 'live', participantNames: existing.participantNames })
          setMeetings((current) => current.map((meeting) => meeting.id === existing.id ? { ...meeting, status: 'live', endedAt: null } : meeting))
        }
      }
      sessionMeetingRef.current = meetingId; setSession('connecting')
      const response = await fetch('/api/transcription/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meetingId }) })
      const payload = await response.json() as { token?: string; error?: string }
      if (!response.ok || !payload.token) throw new Error(payload.error ?? 'No se pudo iniciar la transcripción.')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      console.log('[v0] microphone stream ready', { active: stream.active, tracks: stream.getTracks().map((track) => ({ kind: track.kind, state: track.readyState, enabled: track.enabled })) })
      const socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${new URLSearchParams({ token: payload.token, speech_model: 'universal-3-6-pro', language_codes: '["es"]', sample_rate: '16000' })}`)
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      let callbackCount = 0
      processor.onaudioprocess = (event) => {
        callbackCount += 1
        const input = event.inputBuffer.getChannelData(0); const samples = downsample(input, context!.sampleRate)
        let sum = 0; for (const value of input) sum += value * value
        const rms = Math.sqrt(sum / Math.max(1, input.length))
        if (callbackCount <= 3 || callbackCount % 50 === 0) console.log('[v0] audio callback', { callbackCount, samples: input.length, rms: Number(rms.toFixed(4)), socketState: socket.readyState, contextState: context!.state })
        if (socket.readyState === WebSocket.OPEN && sessionMeetingRef.current === meetingId && sessionStateRef.current === 'listening') {
          const pcm = encodePCM(samples)
          socket.send(pcm)
          audioSendCountRef.current += 1
          if (audioSendCountRef.current <= 3 || audioSendCountRef.current % 50 === 0) console.log('[v0] PCM sent', { frames: audioSendCountRef.current, bytes: pcm.byteLength, format: 'PCM16 mono binary', inputRate: context!.sampleRate, outputRate: 16000, rms: Number(rms.toFixed(4)) })
        }
      }
      source.connect(processor); processor.connect(context.destination)
      audioRef.current = { context, stream, source, processor, socket, sessionId: crypto.randomUUID() }
      socket.onopen = () => { console.log('[v0] AssemblyAI websocket open', { readyState: socket.readyState, sampleRate: context!.sampleRate, format: 'PCM16 mono', model: 'universal-3-6-pro' }); setSession('listening'); sessionTimerRef.current = setTimeout(() => finish(), 60 * 60 * 1000) }
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as { type?: string; error?: string; message?: string; transcript?: string; utterance?: string; end_of_turn?: boolean; turn_is_formatted?: boolean }
          console.log('[v0] AssemblyAI message', { type: message.type, error: message.error, hasTranscript: Boolean(message.transcript || message.utterance), endOfTurn: message.end_of_turn })
          if (message.type === 'Error') {
            const detail = message.error || message.message || 'Error del proveedor de transcripción.'
            console.error('[v0] AssemblyAI protocol error', { code: message.type, message: detail })
            if (mountedRef.current) { setAudioError(detail); setSession('error') }
            return
          }
          if (message.type === 'Termination') {
            terminationRequestedRef.current = false
            const current = audioRef.current
            if (current?.socket === socket) {
              audioRef.current = null
              sessionMeetingRef.current = null
              if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) socket.close(1000, 'terminated')
            }
            return
          }
          const text = message.transcript || message.utterance
          const isFinal = message.type === 'Turn' && (message.end_of_turn === true || message.turn_is_formatted === true)
          if (text && isFinal && sessionMeetingRef.current === meetingId) {
            void handleDirectIrisInvocation(text, meetingId)
            const now = new Date()
            void saveTranscriptSegment({ id: crypto.randomUUID(), meetingId, speaker: 'Participante', text, startedAt: now, endedAt: now, isFinal: true }).then(() => refreshData()).catch((error) => console.error('[v0] segment persistence failed', error))
          }
        } catch { console.error('[v0] invalid AssemblyAI message') }
      }
      socket.onerror = (event) => { console.error('[v0] AssemblyAI websocket error', { event, readyState: socket.readyState }); if (mountedRef.current) { setAudioError('La conexión de transcripción falló.'); setSession('error') } }
      socket.onclose = (event) => { console.log('[v0] AssemblyAI websocket closed', { code: event.code, reason: event.reason, wasClean: event.wasClean, frames: audioSendCountRef.current }); if (audioRef.current?.socket === socket) { stopAudio('websocket-close'); if (mountedRef.current && sessionStateRef.current === 'listening') { setAudioError(`La conexión se cerró (${event.code}).`); setSession('error') } } }
    } catch (error) {
      console.error('[v0] capture start failed', error)
      if (context && context.state !== 'closed') await context.close()
      stopAudio('start-failed'); sessionMeetingRef.current = null; if (mountedRef.current) { setAudioError(error instanceof Error ? error.message : 'No se pudo iniciar la captura.'); setSession('error') }
    } finally { setPending(false) }
  }
  */
  async function handleDirectIrisInvocation(text: string, meetingId: string, segmentId = crypto.randomUUID()) {
    const now = Date.now()
    recentFinalSpeechRef.current = [...recentFinalSpeechRef.current.filter((item) => now - item.at <= 8000), { text: text.trim(), at: now }].slice(-3)
    const directText = text.trim()
    if (isIsolatedIrisWakeWord(directText)) {
      pendingDirectWakeRef.current = { startedAt: now, segmentId }
      if (!irisMutedRef.current) { window.speechSynthesis?.cancel(); speakIris('Sí, dime.') }
      return
    }
    let mode: 'single_segment' | 'multi_segment' = 'single_segment'
    let candidateText = directText
    const pendingWake = pendingDirectWakeRef.current
    if (pendingWake && now - pendingWake.startedAt <= 6000 && segmentId !== pendingWake.segmentId) { candidateText = normalizeDirectInvocationQuery(directText); mode = 'multi_segment'; pendingDirectWakeRef.current = null } else {
      const combined = recentFinalSpeechRef.current.map((item) => item.text).join(' ')
      const combinedInvocation = detectDirectIrisInvocation(combined)
      if (!detectDirectIrisInvocation(directText).invoked && combinedInvocation.invoked) { candidateText = combined; mode = 'multi_segment' }
    }
    const invocation = detectDirectIrisInvocation(candidateText)
    const followUp = followUpRef.current
    const followUpValid = Boolean(followUp && followUp.expiresAt > now && isLikelyFollowUp(directText))
    if (!invocation.invoked && !followUpValid) return
    const resolvedInvocation = invocation.invoked ? invocation : { invoked: true, query: directText, invocationId: `follow-up-${segmentId}` }
    if (directInvocationIdsRef.current.has(resolvedInvocation.invocationId)) return
    if (process.env.NODE_ENV !== 'production') console.log('[v0] DIRECT_INVOCATION_DETECTED', { mode: followUpValid ? 'follow_up' : mode, queryPreview: resolvedInvocation.query.slice(0, 100) })
    directInvocationIdsRef.current.add(resolvedInvocation.invocationId)
    directInvocationAbortRef.current?.abort()
    const requestController = new AbortController()
    directInvocationAbortRef.current = requestController
    const startedAt = Date.now()
    let firstDeltaAt: number | null = null
    let streamedAnswer = ''
    const streamedResponseRef = { current: null as DirectIrisResponse | null }
    setDirectInvocation({ query: resolvedInvocation.query, status: 'answering', latencyMs: null, answer: '', spoken: false, presented: false })
    const pendingPresentation: SuggestedIntervention = { shouldIntervene: true, level: 1, type: 'generic', reason: `Consulta directa: ${resolvedInvocation.query}`, content: 'Iris está consultando Ventana Celeste y las reuniones anteriores.', confidence: 1, evidence: [] }
    presentIntervention('direct', pendingPresentation, 'signal')
    const previousExchange = followUpValid && followUp ? { user: followUp.user, iris: followUp.iris } : undefined
    setIrisVisualState(irisMutedRef.current ? 'muted' : 'analyzing')
    addDiagnosticEvent(`DIRECT INVOCATION detected: ${resolvedInvocation.query}`)
    if (!irisMutedRef.current) { window.speechSynthesis?.cancel(); speakIris('Ya lo reviso.') }
    const receiveStreamBlock = (block: string) => {
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'))
      if (!dataLine) return
      const event = JSON.parse(dataLine.slice(5).trim()) as { type?: string; delta?: string; answer?: DirectIrisResponse; message?: string }
      if (event.type === 'delta' && typeof event.delta === 'string') {
        if (firstDeltaAt === null) firstDeltaAt = Date.now()
        streamedAnswer += event.delta
        setDirectInvocation((current) => ({ ...current, answer: streamedAnswer }))
      } else if (event.type === 'final' && event.answer && typeof event.answer.answer === 'string') streamedResponseRef.current = event.answer
      else if (event.type === 'error') throw new Error(event.message || 'No se pudo completar la respuesta de Iris.')
    }
    try {
      const actionMeetingId = activeMeetingIdRef.current ?? meetingId
      if (process.env.NODE_ENV !== 'production') console.log('[v0] DIRECT_INVOCATION_MEETING_ID', { activeMeetingId: activeMeetingIdRef.current, actionMeetingId })
      const response = await fetch('/api/iris/direct-question', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meetingId: actionMeetingId, query: resolvedInvocation.query, invocationId: resolvedInvocation.invocationId, previousExchange }), signal: requestController.signal })
      if (!response.ok) throw new Error(`No se pudo iniciar la respuesta de Iris (${response.status}).`)
      if (!response.body) throw new Error('El navegador no recibió la respuesta en streaming.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let separator = buffer.indexOf('\n\n')
        while (separator >= 0) {
          receiveStreamBlock(buffer.slice(0, separator))
          buffer = buffer.slice(separator + 2)
          separator = buffer.indexOf('\n\n')
        }
        if (done) break
      }
      if (buffer.trim()) receiveStreamBlock(buffer)
      const finalResponse = streamedResponseRef.current
      if (!finalResponse) throw new Error('Iris terminó la respuesta sin un resultado validado.')
      const sourceBackedFallback = Boolean(finalResponse.fallback && finalResponse.confidence >= 0.55 && finalResponse.evidence.length && finalResponse.answer.trim())
      if (finalResponse.fallback && !sourceBackedFallback) {
        const message = finalResponse.answer || 'No encontré una respuesta respaldada en las fuentes consultadas.'
        setDirectInvocation({ query: resolvedInvocation.query, status: 'error', latencyMs: Date.now() - startedAt, answer: message, spoken: false, presented: false })
        clearPresentation('replaced')
        setLiveAnalysisError(message)
        setIrisVisualState(irisMutedRef.current ? 'muted' : 'listening')
        if (!irisMutedRef.current) { window.speechSynthesis?.cancel(); speakIris(message) }
        addDiagnosticEvent('DIRECT ANSWER fallback had no matching evidence')
        return
      }
      const responseLatency = Date.now() - startedAt
      const suggestion = { shouldIntervene: true, level: 3 as const, type: 'generic' as const, reason: `${sourceBackedFallback ? 'Respuesta extraída de fuentes coincidentes; Cloudflare no pudo sintetizarla. ' : ''}Solicitud directa: ${resolvedInvocation.query}${finalResponse.evidence.length ? ` · Fuentes consultadas: ${finalResponse.evidence.slice(0, 4).map((source) => source.trim().slice(0, 120)).join(' | ')}` : ''}`, content: finalResponse.answer, confidence: finalResponse.confidence, evidence: finalResponse.evidence }
      const sourceLayer: ActivePresentation = { source: 'direct', level: 2, type: 'generic', content: finalResponse.answer, createdAt: new Date().toISOString(), visualState: 'interventionLevel2' }
      setPyramidState((current) => ({ ...current, layers: [...current.layers.filter((layer) => layer.level < 2), sourceLayer], speechContent: null }))
      const message = { ...suggestion, level: 2 as const }
      presentIntervention('direct', message, 'interventionLevel2')
      if (!irisMutedRef.current) window.speechSynthesis?.cancel()
      window.setTimeout(() => {
        if (requestController.signal.aborted) return
        presentIntervention('direct', suggestion, 'interventionLevel3')
        if (!irisMutedRef.current) speakIris(finalResponse.answer, () => setDirectInvocation((current) => ({ ...current, spoken: true })))
      }, 1300)
      setDirectInvocation({ query: resolvedInvocation.query, status: 'success', latencyMs: responseLatency, answer: finalResponse.answer, spoken: false, presented: true })
      armFollowUp(resolvedInvocation.query, finalResponse.answer)
      addDiagnosticEvent(`DIRECT ANSWER ${sourceBackedFallback ? 'source excerpt' : 'model'} presented level=2 → 3 spoken=${!irisMutedRef.current}`)
      if (process.env.NODE_ENV !== 'production') console.log('[v0] DIRECT_STREAM_METRICS', { latencyMs: responseLatency, timeToFirstTextMs: firstDeltaAt ? firstDeltaAt - startedAt : null, mode: followUpValid ? 'follow_up' : mode })
      void createIntervention({ ...suggestion, id: crypto.randomUUID(), meetingId: actionMeetingId, source: 'ai' }).then(() => refreshData()).catch((error) => { console.error('[v0] direct intervention persistence failed', error); addDiagnosticEvent('DIRECT ANSWER persistence failed') })
    } catch (error) {
      if (requestController.signal.aborted) return
      setDirectInvocation({ query: resolvedInvocation.query, status: 'error', latencyMs: Date.now() - startedAt, answer: '', spoken: false, presented: false })
      setIrisVisualState(irisMutedRef.current ? 'muted' : 'listening')
      window.speechSynthesis?.cancel()
      if (!irisMutedRef.current) speakIris('No pude completar la respuesta. Inténtalo de nuevo.')
      addDiagnosticEvent(`DIRECT ANSWER error: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      if (directInvocationAbortRef.current === requestController) directInvocationAbortRef.current = null
    }
  }
  async function start() {
    if (pending || speechRef.current) return
    activateIrisSpeech()
    setInterventionDiagnostic((current) => ({ ...current, status: 'enabled' })); setLiveAnalysisError(''); setLastAnalysisAt(null); lastAnalyzedSegmentIdRef.current = null; autoAnalysisInFlightRef.current = false
    setPending(true); setAudioError(''); setSession('connecting')
    let meetingId = activeMeetingIdRef.current ?? selectedId
    try {
      if (!meetingId) {
        meetingId = crypto.randomUUID(); const now = new Date(); const title = `Reunión de coordinación · ${now.toLocaleDateString('es-ES')}`
        await saveMeeting({ id: meetingId, title, startedAt: now, status: 'live', participantNames: [] })
        setMeetings((current) => [{ id: meetingId!, title, startedAt: now.toISOString(), endedAt: null, status: 'live', participantNames: [], createdAt: now.toISOString() }, ...current]); setSelectedId(meetingId)
      } else if (selected?.id === meetingId && selected.status !== 'live') {
        const startedAt = new Date(selected.startedAt)
        await saveMeeting({ id: selected.id, title: selected.title, objective: data.meeting?.objective ?? '', contextNotes: data.meeting?.contextNotes ?? null, startedAt, endedAt: null, status: 'live', participantNames: selected.participantNames })
        setMeetings((current) => current.map((item) => item.id === selected.id ? { ...item, status: 'live', endedAt: null } : item))
      }
      activeMeetingIdRef.current = meetingId
      sessionMeetingRef.current = meetingId
      if (process.env.NODE_ENV !== 'production') console.log('[v0] ACTIVE_MEETING_STARTED', { activeMeetingId: meetingId, selectedMeetingId: selectedId })
      finalTranscriptKeysRef.current = new Set(data.segments.map((segment) => segment.text.toLocaleLowerCase().replace(/\\s+/g, ' ')))
      await startSpeech(meetingId)
      setAutoAnalysisLifecycle(true, 'meeting_started')
      setIrisVisualState(irisMuted ? 'muted' : 'listening')
      sessionTimerRef.current = setTimeout(() => finish(), 60 * 60 * 1000)
    } catch (error) {
      console.error('[v0] speech capture start failed', error)
      stopAudio('start-failed')
      setAudioError(error instanceof Error ? error.message : 'No se pudo iniciar el reconocimiento de voz.')
      setIrisVisualState('error'); setSession('error')
    } finally { setPending(false) }
  }
  async function waitForTranscriptWrites() { if (transcriptWritesRef.current === 0) return; await new Promise<void>((resolve) => transcriptWriteWaitersRef.current.push(resolve)) }
  async function finish() { if (!selected) return; setAutoAnalysisLifecycle(false, 'meeting_finalized'); stopAudio(); await waitForTranscriptWrites(); setPending(true); setExtractionError(''); setSummaryError(''); setSummaryLoading(true); setExtractingResults(true); setSession('analyzing'); try { const endedAt = new Date(); await saveMeeting({ id: selected.id, title: selected.title, startedAt: new Date(selected.startedAt), endedAt, status: 'ended', participantNames: selected.participantNames }); setMeetings((current) => current.map((item) => item.id === selected.id ? { ...item, status: 'ended', endedAt: endedAt.toISOString() } : item)); const postStartedAt = Date.now(); const finalization = await finalizeMeetingAction(selected.id); const [detectionResult, summaryResult] = await Promise.allSettled([Promise.resolve(finalization.extraction), Promise.resolve(finalization.summary)]); if (detectionResult.status === 'fulfilled') { setDetections(detectionResult.value); setConfirmedDetectionKeys(new Set()); setPostMeetingDiagnostic((current) => ({ ...current, extraction: { status: 'success', decisionsCount: detectionResult.value.decisions.length, tasksCount: detectionResult.value.tasks.length, commitmentsCount: detectionResult.value.commitments.length, openQuestionsCount: detectionResult.value.openQuestions.length, latencyMs: Date.now() - postStartedAt } })) } else { setExtractionError('No se pudieron extraer los resultados.'); setPostMeetingDiagnostic((current) => ({ ...current, extraction: { ...current.extraction, status: 'error', latencyMs: Date.now() - postStartedAt } })) } if (summaryResult.status === 'fulfilled') { setMeetingSummary(summaryResult.value); setPostMeetingDiagnostic((current) => ({ ...current, summary: { status: 'success', summaryCharacterCount: summaryResult.value.summary.length, topicsCount: summaryResult.value.topics.length, keyPointsCount: summaryResult.value.keyPoints.length, latencyMs: Date.now() - postStartedAt } })) } else { setSummaryError('No se pudo generar la minuta.'); setPostMeetingDiagnostic((current) => ({ ...current, summary: { ...current.summary, status: 'error', latencyMs: Date.now() - postStartedAt } })) } setWorkspaceOpen(true); setWorkspaceTab('summary') } catch (error) { const message = error instanceof Error ? error.message : 'Error desconocido'; setExtractionError(`No se pudo procesar la reunión: ${message}`); setSummaryError('La transcripción guardada sigue disponible. Vuelve a intentar el procesamiento.'); } finally { setExtractingResults(false); setSummaryLoading(false); setSession('ended'); setWorkspaceOpen(true); setWorkspaceTab('summary'); setSelectedId(selected.id); setPending(false) } }
  async function submitTask(event: React.FormEvent) { event.preventDefault(); if (!selectedId || !taskDraft.text.trim()) return; setPending(true); try { const payload = { id: taskDraft.id ?? crypto.randomUUID(), meetingId: selectedId, text: taskDraft.text, assignee: taskDraft.assignee || null, dueDate: taskDraft.dueDate ? new Date(`${taskDraft.dueDate}T12:00:00`) : null, status: 'open' as const }; if (taskDraft.id) await updateTask({ id: taskDraft.id, meetingId: selectedId, changes: payload }); else await saveTask(payload); setTaskEditorOpen(false); setTaskDraft({ text: '', assignee: '', dueDate: '' }); await refreshData() } finally { setPending(false) } }
  async function toggleTask(task: Task) { if (!selectedId) return; await updateTask({ id: task.id, meetingId: selectedId, changes: { status: task.status === 'done' ? 'open' : 'done' } }); await refreshData() }
  async function removeTask(task: Task) { if (!selectedId || !window.confirm('¿Eliminar esta tarea?')) return; await deleteTask({ id: task.id, meetingId: selectedId }); await refreshData() }
  async function confirmDecision(decision: Decision) { await saveDecision({ ...decision, status: 'confirmed', confirmedByUser: true }); await refreshData() }
  async function logout() { await authClient.signOut(); router.push('/sign-in'); router.refresh() }

  return <main className={`iris-shell ${workspaceOpen ? 'workspace-open' : ''} ${selectedId ? 'has-selection' : 'no-selection'} ${workspaceOpen && workspaceTab === 'settings' ? 'settings-open' : ''} ${selected?.status === 'scheduled' ? 'meeting-scheduled' : ''} ${selected?.status === 'live' ? 'meeting-live' : ''} ${selected?.status === 'ended' ? 'meeting-ended' : ''}`} data-workspace-tab={workspaceTab}>{process.env.NODE_ENV !== 'production' && !workspaceOpen && presentationInspectionMode && activePresentation && <div className="debug-presentation-badge">DEBUG PRESENTATION<br />N{activePresentation.level} · {activePresentation.visualState}<br />ACTIVE</div>}
    <header className="topbar"><div className="brand-lockup"><div className="brand-mark">i</div><span>Iris</span></div><nav className="top-nav" aria-label="Navegación principal"><button className="new-meeting-nav" type="button" onClick={openNewMeetingSetup} disabled={session === 'listening' || session === 'connecting' || session === 'paused' || session === 'analyzing' || selected?.status === 'live'}><Plus size={14} aria-hidden="true" /> Nueva reunión</button><button className={`pepper-mode-nav ${pepperGhostOpen ? 'active' : ''}`} type="button" onClick={openPyramidMode} aria-label="Abrir modo Pirámide"><Sparkles size={13} aria-hidden="true" /> Modo Pirámide</button><button className="tablet-monitor-nav" type="button" onClick={() => void copyTabletMonitorLink()} disabled={!selectedId} title="Copia el enlace para abrir esta misma reunión en la tablet, sin audio">{tabletLinkStatus.startsWith('http') ? 'Enlace listo' : tabletLinkStatus ? 'Enlace copiado' : 'Pantalla tablet'}</button>{tabletLinkStatus && <span className="sr-only" role="status">{tabletLinkStatus}</span>}<button className={`workspace-nav ${workspaceOpen && workspaceTab !== 'settings' ? 'active' : ''}`} onClick={() => { setWorkspaceOpen(true); setWorkspaceTab('summary') }} type="button">Workspace</button><button className={workspaceOpen && workspaceTab === 'settings' ? 'active' : ''} onClick={() => { setWorkspaceOpen(true); setWorkspaceTab('settings') }} type="button">Configuración</button>{!workspaceOpen && activePresentation && <span className="presentation-nav-badge" role="status" aria-live="polite">Interacción activa · N{activePresentation.level}</span>}</nav><div className="top-actions account-wrap"><button className="account-button" onClick={() => setAccountOpen((open) => !open)} type="button" aria-expanded={accountOpen} aria-haspopup="menu"><span className="account-avatar">{(user.name || user.email).charAt(0).toUpperCase()}</span><span className="account-label">{user.name || 'Cuenta'}</span></button>{accountOpen && <div className="account-menu" role="menu"><strong>Cuenta</strong><span>{user.email}</span><button className="account-logout" type="button" role="menuitem" onClick={logout}><LogOut size={14} /> Cerrar sesión</button></div>}</div></header>
    <div className="meeting-history"><span className="eyebrow">HISTORIAL</span>{meetings.length === 0 ? <span className="history-empty">Todavía no hay reuniones guardadas.</span> : meetings.map((meeting) => <div className={`history-item-row ${selectedId === meeting.id ? 'active' : ''}`} key={meeting.id}><button className="history-item" onClick={() => { setSelectedId(meeting.id); setSession(meeting.status === 'ended' ? 'ended' : 'idle'); setWorkspaceTab('summary') }}>{meeting.title}</button></div>)}</div>
    <IrisPresentation activePresentation={!workspaceOpen ? activePresentation : null} irisVisualState={irisVisualState} muted={irisMuted} speechContent={pyramidState.speechContent ?? undefined} speakEnabled={activePresentation?.source !== 'direct'} renderContent={!pepperGhostOpen} workspaceOpen={workspaceOpen} ambientModeVisible={!workspaceOpen} onSpeechStart={handleSpeechStart} onSpeechError={handleSpeechError} />
    {pepperGhostOpen && <IrisPepperGhost activePresentation={activePresentation} muted={irisMuted} onClose={() => setPepperGhostOpen(false)} />}
    <div className="workspace-main">
    {(!workspaceOpen || workspaceTab === 'summary') && <div className="workspace"><div className="workspace-context" style={{ display: workspaceOpen ? 'flex' : 'none' }}><label htmlFor="meeting-selector">Reunión</label><select id="meeting-selector" value={selectedId ?? ''} onChange={(event) => { setSelectedId(event.target.value || null); setSession('idle'); setWorkspaceTab('summary') }}><option value="">Selecciona una reunión</option>{meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.title} · {formatMeetingDate(meeting.startedAt)}</option>)}</select>{selected && <span>{selected.status === 'ended' ? 'Finalizada' : selected.status === 'live' ? 'En curso' : 'Lista'}</span>}</div><section className="hero-column" aria-label="Estado de la sesión"><div className="hero-kicker" aria-live="polite"><span className={`state-dot ${status.tone}`} />{status.detail}</div>{liveAnalysisError && <p className="live-analysis-error" role="status">{liveAnalysisError}</p>}{session !== 'listening' && session !== 'paused' && session !== 'connecting' && session !== 'analyzing' && selected?.status !== 'live' && <section className="premeeting-card"><span className="eyebrow">PREPARAR REUNIÓN</span><h1>{selected?.title || 'Nueva reunión'}</h1>{selected && <><p>{data.meeting?.objective || 'Configura el objetivo, contexto y agenda antes de comenzar.'}</p>{data.agenda.length > 0 && <div className="premeeting-agenda"><span className="eyebrow">AGENDA</span>{data.agenda.slice().sort((a, b) => a.position - b.position).map((item, index) => <div key={item.id}>{index + 1}. {item.title}</div>)}</div>}</>}<div className="premeeting-actions"><button className="primary-button" type="button" onClick={() => selected ? configureSelectedMeeting() : setNewMeetingOpen(true)}>{selected ? 'Configurar reunión' : 'Nueva reunión'}</button>{selected && <><button className="secondary-button" type="button" onClick={configureSelectedMeeting}>Editar</button><button className="secondary-button" type="button" onClick={() => void start()}><Play size={14} /> {selected.status === 'ended' ? 'Continuar reunión' : 'Iniciar reunión'}</button></>}</div></section>}
<div className={`orb-stage ${irisVisualState}`} data-visual-state={irisVisualState}><div className="live-caption-stack" aria-live="polite">{liveCaption && <p className="live-caption">{liveCaption}</p>}{followUpMode && <p className="live-caption">Puedes seguir preguntando</p>}</div><IrisOrbVisual className="home-orb-visual" />{session === 'listening' && <div className="sound-lines"><i /><i /><i /><i /><i /></div>}</div><div className="agenda-live-summary">{activeAgenda ? `${agendaIndex} de ${data.agenda.length} · ${activeAgenda.title}` : data.meeting?.objective || 'Sin objetivo definido'}</div><div className="status-copy"><h1>{status.label}</h1><p>{audioError || speechOutputError || (session === 'idle' ? '' : session === 'ended' ? 'Reunión persistida. Puedes revisar sus acuerdos.' : session === 'paused' ? 'Reanuda cuando quieras. Nada se procesa mientras está pausada.' : session === 'connecting' ? 'Preparando una sesión segura de transcripción.' : session === 'error' ? 'La captura no está activa.' : 'Transcripción progresiva en español. El audio no se almacena.')}</p></div><div className="ambient-actions"><button className="sheet-trigger" type="button" onClick={() => { setWorkspaceOpen(true); setWorkspaceTab('summary') }}><FileText size={15} /> Workspace</button>{session === 'ended' && <details className="export-menu"><summary>Exportar</summary><button type="button" onClick={() => exportMeeting('transcript')}>Transcripción</button><button type="button" onClick={() => exportMeeting('summary')}>Resumen</button><button type="button" onClick={() => exportMeeting('all')}>Todo</button></details>}{!irisMuted && <button className="sheet-trigger" type="button" onClick={() => activateIrisSpeech(true)}>{speechOutputReady ? 'Probar voz' : 'Activar voz'}</button>}<button className={`sheet-trigger ${irisMuted ? 'selected' : ''}`} type="button" onClick={() => setIrisMuted((value) => !value)} aria-pressed={irisMuted}>{irisMuted ? 'Activar Iris' : 'Silenciar Iris'}</button></div><div className="session-controls">{session === 'idle' || session === 'ended' ? <button className="primary-button" onClick={start} disabled={pending}><Play size={16} fill="currentColor" /> {pending ? 'Guardando…' : session === 'ended' ? 'Nueva sesión' : 'Iniciar sesión'}</button> : <button className="primary-button" onClick={() => { if (session === 'paused') { void start() } else { stopAudio('manual'); setSession('paused') } }}><>{session === 'paused' ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />} {session === 'paused' ? 'Reanudar' : 'Pausar'}</></button>}{session !== 'idle' && session !== 'ended' && <button className="secondary-button finish-meeting-button" onClick={finish} disabled={pending}><Square size={14} fill="currentColor" /> Finalizar reunión</button>}</div></section>
    {workspaceOpen && workspaceTab === 'summary' && !selected && <section className="workspace-empty panel"><span className="eyebrow">INFORMES</span><h1>Selecciona una reunión</h1><p>El informe reúne la minuta, el contexto, las interacciones de Iris y la transcripción completa.</p></section>}
    {workspaceOpen && workspaceTab === 'summary' && selected && globalEditMode && <section className="workspace-global-editor"><header><div><span className="eyebrow">EDICIÓN</span><h1>Editar informe</h1></div><span>{selected.title}</span></header><label>Nombre de la reunión<input value={globalDraft.title} onChange={(event) => setGlobalDraft((draft) => ({ ...draft, title: event.target.value }))} /></label><label>Objetivo<textarea value={globalDraft.objective} onChange={(event) => setGlobalDraft((draft) => ({ ...draft, objective: event.target.value }))} /></label><label>Contexto previo<textarea value={globalDraft.contextNotes} onChange={(event) => setGlobalDraft((draft) => ({ ...draft, contextNotes: event.target.value }))} /></label><label>Resumen ejecutivo<textarea value={globalDraft.summary} onChange={(event) => setGlobalDraft((draft) => ({ ...draft, summary: event.target.value }))} /></label><label>Minuta / puntos<textarea value={globalDraft.agenda} onChange={(event) => setGlobalDraft((draft) => ({ ...draft, agenda: event.target.value }))} /></label><label>Decisiones<textarea value={globalDraft.decisions} onChange={(event) => setGlobalDraft((draft) => ({ ...draft, decisions: event.target.value }))} /></label><label>Tareas<textarea value={globalDraft.tasks} onChange={(event) => setGlobalDraft((draft) => ({ ...draft, tasks: event.target.value }))} /></label><footer><button className="secondary-button" type="button" onClick={() => setGlobalEditMode(false)}>Volver al informe</button><button className="primary-button" type="button" disabled={pending} onClick={() => void saveGlobalEdits()}>{pending ? 'Guardando…' : 'Guardar informe'}</button></footer></section>}
    {workspaceOpen && workspaceTab === 'summary' && selected && !globalEditMode && <article className="workspace-inline-document meeting-report">
      <header className="document-header">
        <div>
          <span className="eyebrow">INFORME DE REUNIÓN</span>
          <h1>{selected.title}</h1>
          <p className="document-meta">{formatMeetingDate(selected.startedAt)} · {selected.status === 'ended' ? 'Finalizada' : selected.status === 'live' ? 'En curso' : 'Preparada'}</p>
        </div>
        <div className="meeting-export-actions">
          <button className="secondary-button" type="button" onClick={() => exportMeeting('all')} disabled={!data.meeting}>Descargar informe</button>
          <button className="secondary-button" type="button" onClick={() => exportMeeting('transcript')} disabled={!data.meeting}>Descargar transcripción</button>
          <button className="edit-meeting-button" type="button" onClick={enterGlobalEditMode}>Editar informe</button>
        </div>
      </header>
      {dataError && <p className="analysis-error" role="alert">{dataError}</p>}
      <nav className="report-toc" aria-label="Secciones del informe"><a href="#report-context">Contexto</a><a href="#report-minute">Minuta</a><a href="#report-decisions">Decisiones</a><a href="#report-tasks">Tareas</a><a href="#report-interactions">Interacciones</a><a href="#report-knowledge">Conocimiento</a><a href="#report-transcript">Transcripción</a></nav>
      <section className="report-section report-context-section" id="report-context"><span className="report-section-index">01 · CONTEXTO</span><h2>Objetivo y antecedentes</h2><div className="report-fields"><div><span>Objetivo</span><p>{data.meeting?.objective || 'No se definió un objetivo para esta reunión.'}</p></div><div><span>Notas de contexto</span><p>{data.meeting?.contextNotes || 'No se añadieron antecedentes.'}</p></div></div>{data.suggestions.length > 0 && <div className="report-context-sources"><h3>Hallazgos de análisis</h3>{data.suggestions.map((item) => <article className="report-context-source" key={item.id}><p>{item.recommendedAction}</p><small>{item.status === 'accepted' ? 'Aceptada' : item.status === 'dismissed' ? 'Descartada' : 'Pendiente'} · {item.evidence.join(' · ')}</small>{item.status === 'proposed' && <div className="suggestion-actions"><button type="button" className="accept-button" onClick={async () => { await updateSuggestion({ id: item.id, status: 'accepted' }); await refreshData() }}><Check size={14} /> Aceptar</button><button type="button" className="text-button" onClick={async () => { await updateSuggestion({ id: item.id, status: 'dismissed' }); await refreshData() }}>Descartar</button></div>}</article>)}</div>}</section>
      <section className="report-section" id="report-minute"><span className="report-section-index">02 · MINUTA</span><h2>Resumen ejecutivo</h2>{summaryLoading && <p role="status">Generando minuta…</p>}{summaryError && <p className="analysis-error" role="alert">{summaryError} <button className="text-button" type="button" onClick={() => void retrySummary()}>Reintentar</button></p>}<p>{meetingSummary?.summary || 'La minuta aún no ha sido generada.'}</p>{Boolean(meetingSummary?.topics.length) && <div className="report-topic-list"><strong>Temas tratados</strong><ul>{meetingSummary!.topics.map((topic, index) => <li key={`${topic}-${index}`}>{topic}</li>)}</ul></div>}{Boolean(meetingSummary?.keyPoints.length) && <div className="report-topic-list"><strong>Puntos clave</strong><ul>{meetingSummary!.keyPoints.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}</ul></div>}<h3>Puntos de agenda</h3>{data.agenda.length ? <ol className="minute-list">{data.agenda.slice().sort((a, b) => a.position - b.position).map((item) => <li className="minute-topic" key={item.id}><h3>{item.title}</h3><p>{item.note || 'Sin notas registradas todavía.'}</p><small>{item.status === 'done' ? 'Completado' : item.status === 'active' ? 'En curso' : 'Pendiente'}</small></li>)}</ol> : <p>No hay puntos de agenda registrados.</p>}</section>
      <section className="report-section" id="report-decisions"><span className="report-section-index">03 · ACUERDOS</span><h2>Decisiones</h2>{data.decisions.length ? data.decisions.map((decision) => <article className="report-list-item" key={decision.id}><p>{decision.text}</p><small>{decision.status === 'confirmed' ? 'Confirmada' : 'Pendiente de confirmar'}</small></article>) : <p>No se registraron decisiones.</p>}</section>
      <section className="report-section" id="report-tasks"><span className="report-section-index">04 · SEGUIMIENTO</span><h2>Tareas y compromisos</h2>{data.tasks.length ? data.tasks.map((task) => <article className="report-list-item" key={task.id}><p>{task.text}</p><small>{task.assignee || 'Sin responsable'} · {task.status === 'done' ? 'Completada' : 'Pendiente'}{task.dueDate ? ` · ${new Date(task.dueDate).toLocaleDateString('es-CL')}` : ''}</small></article>) : <p>No se registraron tareas.</p>}{detections?.commitments.length ? <><h3>Compromisos detectados</h3>{detections.commitments.map((item, index) => <article className="report-list-item" key={`${item.text}-${index}`}><p>{item.text}</p><small>{item.assignee || 'Sin responsable'}{item.dueDate ? ` · ${item.dueDate}` : ''}</small></article>)}</> : null}</section>
      <section className="report-section report-interactions-section" id="report-interactions"><div className="panel-heading"><div><span className="report-section-index">05 · ASISTENCIA</span><h2>Interacciones de Iris</h2></div><span className="count-badge">{data.interventions.length}</span></div>{data.interventions.length === 0 ? <p>No hubo interacciones durante esta reunión.</p> : data.interventions.slice().sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()).map((item) => <article className="report-interaction" key={item.id}><header><span>{new Date(item.createdAt).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</span><strong>N{item.level} · {item.type}</strong></header><p>{item.content}</p><small>{item.reason} · {item.source === 'ai' ? 'Iris' : 'Manual'} · {item.observation ? `Evaluación: ${item.observation}` : 'Sin evaluación'}</small>{!item.observation && <div className="intervention-feedback"><span>¿Fue pertinente?</span><button type="button" onClick={() => void closeIntervention({ id: item.id, meetingId: item.meetingId, status: 'closed', observation: 'útil' }).then(refreshData)}>Útil</button><button type="button" onClick={() => void closeIntervention({ id: item.id, meetingId: item.meetingId, status: 'closed', observation: 'falso positivo' }).then(refreshData)}>Falso positivo</button></div>}</article>)}</section>
      <section className="report-section report-knowledge-section" id="report-knowledge"><span className="report-section-index">06 · FUENTES</span><h2>Conocimiento utilizado</h2><p className="report-section-intro">Referencias recuperadas por Iris para responder durante esta reunión. Las fuentes directas se distinguen del contexto entregado al análisis de interacciones.</p>{knowledgeUsage.cited.length > 0 && <div className="knowledge-usage-group"><h3>Fuentes citadas en respuestas</h3>{knowledgeUsage.cited.map((source) => <article className="knowledge-usage-row" key={`cited-${source}`}><span>{source.startsWith('Ventana Celeste') ? 'VENTANA CELESTE' : source.startsWith('Memoria Iris') ? 'MEMORIA IRIS' : 'FUENTE'}</span><p>{source.replace(/^(?:Ventana Celeste|Memoria Iris) · /, '')}</p></article>)}</div>}{knowledgeUsage.considered.length > 0 && <div className="knowledge-usage-group"><h3>Contexto entregado al análisis</h3>{knowledgeUsage.considered.map((source) => <article className="knowledge-usage-row" key={`context-${source}`}><span>{source.startsWith('Ventana Celeste') ? 'VENTANA CELESTE' : 'MEMORIA IRIS'}</span><p>{source.replace(/^(?:Ventana Celeste|Memoria Iris) · /, '')}</p></article>)}</div>}{meetingLinkedKnowledge.length > 0 && <div className="knowledge-usage-group"><h3>Conocimiento asociado a esta reunión</h3>{meetingLinkedKnowledge.map((item) => <article className="knowledge-usage-row" key={item.id}><span>{item.source?.type || 'NOTA'}</span><p>{item.title}</p></article>)}</div>}{knowledgeUsage.cited.length === 0 && knowledgeUsage.considered.length === 0 && meetingLinkedKnowledge.length === 0 && <div className="report-empty-note">No hay fuentes de conocimiento registradas para esta reunión.</div>}</section>
      <section className="document-transcript report-section" id="report-transcript"><div className="document-transcript-header"><div><span className="report-section-index">07 · REGISTRO</span><h2>Conversación completa</h2><p>{data.segments.filter((item) => item.isFinal).length} segmentos guardados</p></div><div className="transcript-search"><Search size={15} aria-hidden="true" /><input aria-label="Buscar en la transcripción" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar…" /></div></div>{groupTranscriptSegments(data.segments.filter((item) => item.isFinal && (!query || item.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())))).map((block) => <div className="transcript-block" key={block.id}><time>{new Date(block.startedAt).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</time>{block.speaker && block.speaker.toLocaleLowerCase() !== 'participante' && <strong>{block.speaker}</strong>}<p>{block.text}</p></div>)}{!data.segments.some((item) => item.isFinal) && <p>No hay segmentos de transcripción guardados.</p>}</section>
    </article>}
    </div>}
    {workspaceOpen && workspaceTab === 'settings' && <IrisSettings intensity={interventionIntensity} muted={irisMuted} onIntensityChange={setInterventionIntensity} onMutedChange={setIrisMuted}>
      <section className="knowledge-panel knowledge-settings-section" aria-labelledby="knowledge-settings-title"><div className="panel-heading"><div><span className="eyebrow accent">BASE DE CONOCIMIENTO</span><h2 id="knowledge-settings-title">Conocimiento integrado</h2><p className="knowledge-intro">Fuentes disponibles para dar contexto a Iris durante las reuniones.</p></div><div className="knowledge-inventory-summary"><div><strong>{knowledge.filter((item) => item.validity === 'current').length}</strong><span>elementos activos</span></div><div><strong>{knowledge.filter((item) => item.source?.provider === 'ventana_celeste').length}</strong><span>importados de Ventana Celeste</span></div><div><strong>{knowledge.filter((item) => item.source?.provider !== 'ventana_celeste' && item.validity === 'current').length}</strong><span>conocimientos propios</span></div></div><div className="external-source-panel"><div><strong>Ventana Celeste</strong><span className={`knowledge-connection-status ${externalStatus}`}>{externalStatus === 'not_configured' ? 'No conectado' : externalStatus === 'connected' ? 'Conectado' : externalStatus === 'configured' ? 'Configurado' : 'Revisar conexión'}</span></div><div className="knowledge-actions"><button className="secondary-button" type="button" onClick={() => void checkExternalStatus()}>Comprobar</button><button className="secondary-button" type="button" onClick={() => void testExternalConnection()}>Probar conexión</button><button className="secondary-button" type="button" onClick={() => void exploreExternalContent()}>Explorar contenido</button></div>{externalMessage && <p className="external-message">{externalMessage}</p>}{externalItems.length > 0 && <div className="import-preview">{externalItems.map((item) => <label key={item.id}><input type="checkbox" checked={externalSelected.has(item.id)} onChange={() => setExternalSelected((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next })} /><span><strong>{item.title}</strong><small>{item.source.externalType ? String(item.source.externalType) : item.type} · {item.sourceDate ? new Date(item.sourceDate).toLocaleDateString() : 'Sin fecha'} · {item.content.slice(0, 180)}</small></span></label>)}</div>}{externalItems.length > 0 && <button className="primary-button" type="button" onClick={() => void importExternalSelected()} disabled={importLoading || externalSelected.size === 0}>Importar seleccionados ({externalSelected.size})</button>}</div><div className="knowledge-actions"><button className="secondary-button" type="button" onClick={() => { setKnowledgeDraft({ id: '', title: '', type: 'note', content: '', sourceLabel: '' }); setKnowledgeOpen(true) }}><Plus size={15} /> Pegar texto</button><button className="secondary-button" type="button" onClick={() => { setImportOpen((open) => !open); setImportSummary(null) }}>Importar</button></div></div>{importOpen && <div className="import-form"><div className="import-heading"><strong>Ventana Celeste</strong><span>Importación controlada, sin conexión automática</span></div><div className="knowledge-fields"><select value={importFormat} onChange={(event) => setImportFormat(event.target.value as 'json' | 'text')}><option value="json">JSON estructurado</option><option value="text">Texto por bloques</option></select></div><textarea aria-label="Contenido Ventana Celeste" placeholder={importFormat === 'json' ? '{"items":[{"title":"...","content":"...","type":"decision"}]}' : 'Un bloque por elemento, separado por una línea vacía'} value={importRaw} onChange={(event) => setImportRaw(event.target.value)} /><div className="knowledge-form-actions"><button type="button" className="secondary-button" onClick={() => void previewImport()} disabled={importLoading}>Previsualizar</button>{importPreview.length > 0 && <button type="button" className="primary-button" onClick={() => void confirmImport()} disabled={importLoading || importSelected.size === 0}>Importar {importSelected.size}</button>}</div>{importPreview.length > 0 && <div className="import-preview">{importPreview.map((item) => <label key={item.id}><input type="checkbox" checked={importSelected.has(item.id)} onChange={() => setImportSelected((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next })} /><span><strong>{item.title}</strong><small>{item.type} · {item.content}</small></span></label>)}</div>}{importSummary && <div className="import-summary">Importados: {importSummary.imported} · Actualizados: {importSummary.updated} · Duplicados: {importSummary.duplicates}{importSummary.errors.length > 0 && <><br />Errores: {importSummary.errors.join(' · ')}</>}</div>}</div>}{knowledgeOpen && <form className="knowledge-form" onSubmit={submitKnowledge}><div className="knowledge-fields"><input aria-label="Título" placeholder="Título" value={knowledgeDraft.title} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, title: event.target.value })} required /><select aria-label="Tipo" value={knowledgeDraft.type} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, type: event.target.value })}><option value="note">Nota</option><option value="minute">Minuta</option><option value="context">Contexto</option><option value="decision">Decisión</option><option value="agreement">Acuerdo</option><option value="task">Tarea</option><option value="other">Otro</option></select><input aria-label="Fuente" placeholder="Fuente opcional" value={knowledgeDraft.sourceLabel} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, sourceLabel: event.target.value })} /></div><textarea aria-label="Contenido" placeholder="Pega aquí una minuta, acuerdo o contexto…" value={knowledgeDraft.content} onChange={(event) => setKnowledgeDraft({ ...knowledgeDraft, content: event.target.value })} required /><div className="knowledge-form-actions"><button type="button" className="text-button" onClick={() => setKnowledgeOpen(false)}>Cancelar</button><button className="primary-button" disabled={knowledgeLoading}>{knowledgeLoading ? 'Guardando…' : 'Guardar conocimiento'}</button></div></form>}{knowledge.length === 0 ? <div className="empty-hint">Añade una minuta, decisión o contexto para que Iris lo considere en futuras reuniones.</div> : <div className="knowledge-list">{knowledge.map((item) => <article className="knowledge-row" key={item.id}><div><div className="knowledge-row-meta"><strong>{item.title}</strong><span>{item.source?.type || 'note'}</span></div><p>{item.content}</p><small>{item.source?.label || 'Carga manual'} · {new Date(item.sourceDate).toLocaleDateString('es-ES')}</small></div><div className="knowledge-actions"><button className="text-button" onClick={() => { setKnowledgeDraft({ id: item.id, title: item.title, type: item.source?.type || 'note', content: item.content, sourceLabel: item.source?.label || '' }); setKnowledgeOpen(true) }}>Editar</button><button className="text-button danger" onClick={() => removeKnowledge(item)}>Eliminar</button></div></article>)}</div>}</section></IrisSettings>}
  {process.env.NODE_ENV !== 'production' && workspaceOpen && workspaceTab === 'facilitator' && <section className="suggestions-panel panel facilitator-panel sheet-insights workspace-tool"><div className="panel-heading"><div><span className="eyebrow accent">WIZARD OF OZ</span><h2>Intervenir ahora</h2></div><span className="count-badge">{data.interventions.filter((item) => item.status === 'active').length} activa(s)</span></div><button className="secondary-button" type="button" onClick={runInterventionAnalysis} disabled={!selectedId || !data.segments.length || analyzingIntervention}>{analyzingIntervention ? <><Loader2 size={15} className="spin" /> Analizando…</> : <><Sparkles size={15} /> Evaluar intervención</>}</button><div className="iris-controls"><label>Intervención de Iris <select value={interventionIntensity} onChange={(event) => setInterventionIntensity(event.target.value as 'low' | 'medium' | 'high')} aria-label="Intensidad de intervención"><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option></select></label><label>Análisis automático <button type="button" className={`toggle-button ${autoAnalysis ? 'on' : ''}`} aria-pressed={autoAnalysis} onClick={() => setAutoAnalysis((value) => !value)}>{autoAnalysis ? 'ON' : 'OFF'}</button></label><label>Silenciar Iris <button type="button" className={`toggle-button ${irisMuted ? 'on' : ''}`} aria-pressed={irisMuted} onClick={() => setIrisMuted((value) => !value)}>{irisMuted ? 'ON' : 'OFF'}</button></label></div>{process.env.NODE_ENV !== 'production' && <div className="auto-debug">Auto-analysis: {autoAnalysis ? 'ON' : 'OFF'} · Last analysis: {lastAnalysisAt ? `${Math.round((Date.now() - lastAnalysisAt) / 1000)} sec ago` : '—'} · New segments: {newSegmentCount} · Policy: {policyResult?.action ?? '—'}</div>}{runtimeDiagnostics && <dl className="runtime-diagnostics" aria-label="Diagnóstico de runtime Iris"><div><dt>provider</dt><dd>{runtimeDiagnostics.provider}</dd></div><div><dt>model</dt><dd>{runtimeDiagnostics.model}</dd></div><div><dt>timeoutMs</dt><dd>{runtimeDiagnostics.timeoutMs}</dd></div><div><dt>rejectIfBusy</dt><dd>{String(runtimeDiagnostics.rejectIfBusy)}</dd></div><div><dt>Cloudflare account</dt><dd>{String(runtimeDiagnostics.hasCloudflareAccountId)}</dd></div><div><dt>Cloudflare token</dt><dd>{String(runtimeDiagnostics.hasCloudflareApiToken)}</dd></div><div><dt>NODE_ENV</dt><dd>{runtimeDiagnostics.nodeEnv}</dd></div>{runtimeDiagnostics.vercelEnv && <div><dt>VERCEL_ENV</dt><dd>{runtimeDiagnostics.vercelEnv}</dd></div>}{runtimeDiagnostics.fallbackMessages.map((message) => <div className="runtime-diagnostic-warning" key={message}>{message}</div>)}</dl>}{suggestedIntervention && <div className="ai-proposal" aria-live="polite"><div className="ai-proposal-header"><strong>Propuesta del observador</strong><span>{suggestedIntervention.shouldIntervene ? `Nivel ${suggestedIntervention.level}` : 'No intervenir'} · {Math.round(suggestedIntervention.confidence * 100)}%{interventionLatencyMs !== null ? ` · ${interventionLatencyMs} ms` : ''}</span></div><p className="proposal-content">{suggestedIntervention.content}</p><dl className="proposal-details"><div><dt>Tipo</dt><dd>{suggestedIntervention.type}</dd></div><div><dt>Motivo</dt><dd>{suggestedIntervention.reason}</dd></div><div><dt>Evidencia</dt><dd>{suggestedIntervention.evidence.length ? suggestedIntervention.evidence.join(' · ') : 'Sin evidencia'}</dd></div></dl><div className="suggestion-actions"><button onClick={acceptSuggestedIntervention} disabled={!suggestedIntervention.shouldIntervene || suggestedIntervention.level === 0}>Crear intervención</button><button onClick={() => setSuggestedIntervention(null)}>Descartar</button></div></div>}<form className="facilitator-form" onSubmit={dispatchIntervention}><select aria-label="Nivel" value={interventionDraft.level} onChange={(event) => setInterventionDraft({ ...interventionDraft, level: Number(event.target.value) })}><option value="1">Nivel 1 · Mensaje</option><option value="2">Nivel 2 · Mensaje + esfera</option><option value="3">Nivel 3 · Mensaje + esfera + voz</option></select><select aria-label="Tipo" value={interventionDraft.type} onChange={(event) => setInterventionDraft({ ...interventionDraft, type: event.target.value })}><option value="generic">Genérica</option><option value="agenda_reminder">Recordatorio de agenda</option><option value="off_topic">Fuera de tema</option><option value="previous_decision">Decisión previa</option><option value="pending_task">Tarea pendiente</option><option value="unresolved_question">Pregunta sin resolver</option><option value="time_warning">Aviso de tiempo</option></select><input aria-label="Motivo" placeholder="Motivo" value={interventionDraft.reason} onChange={(event) => setInterventionDraft({ ...interventionDraft, reason: event.target.value })} required /><input aria-label="Contenido" placeholder="Mensaje para el grupo" value={interventionDraft.content} onChange={(event) => setInterventionDraft({ ...interventionDraft, content: event.target.value })} required /><button className="secondary-button" type="submit">Disparar</button></form>{interventionError && <p className="analysis-error" role="alert">{interventionError}</p>}{data.interventions.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((item) => <div className="intervention-row" key={item.id}><span className={`intervention-level level-${item.level}`}>N{item.level}</span><div><strong>{item.content}</strong><small>{item.reason} · {new Date(item.createdAt).toLocaleTimeString('es-ES')}</small></div><button className="text-button" onClick={async () => { const observation = window.prompt('Observación posterior (opcional):') ?? null; await closeIntervention({ id: item.id, meetingId: item.meetingId, status: 'closed', observation }); await refreshData() }}>Cerrar</button></div>)}</section>}
    {process.env.NODE_ENV !== 'production' && workspaceOpen && workspaceTab === 'facilitator' && <section className="diagnostics-panel panel live-diagnostics-panel" style={{ display: workspaceTab === 'facilitator' ? 'block' : 'none' }}><div className="panel-heading"><div><span className="eyebrow">DEVELOPMENT / FACILITATOR</span><h2>Live diagnostics</h2></div><span className="count-badge">{selectedId ? 'active meeting' : 'no meeting'}</span></div><section className="direct-invocation-diagnostic"><strong>DIRECT INVOCATION</strong><span>Last detected: {directInvocation.query || '—'}</span><span>Status: {directInvocation.status} · Latency: {directInvocation.latencyMs ? `${directInvocation.latencyMs}ms` : '—'}</span><span>Answer generated: {directInvocation.answer ? 'true' : 'false'} · Presented: {directInvocation.presented ? 'true' : 'false'} · Spoken: {directInvocation.spoken ? 'true' : 'false'}</span></section><div className="presentation-inspection-control"><strong>Presentation inspection mode</strong><button type="button" className={`toggle-button ${presentationInspectionMode ? 'on' : ''}`} aria-pressed={presentationInspectionMode} onClick={() => setPresentationInspectionMode((value) => !value)}>{presentationInspectionMode ? 'ON' : 'OFF'}</button></div><section className="dev-test-panel"><strong>FORCED PRESENTATION TEST</strong><p>Solo presentation; no modelo, policy ni Neon.</p><div className="diagnostic-actions"><button type="button" className="secondary-button" onClick={() => forcePresentation(1)}>Force N1</button><button type="button" className="secondary-button" onClick={() => forcePresentation(2)}>Force N2</button><button type="button" className="secondary-button" onClick={() => forcePresentation(3)}>Force N3</button></div></section><section className="dev-test-panel"><strong>PROACTIVE SCENARIO TEST</strong><p>Fixtures aislados; ejecutan modelo real y policy, sin persistir transcript.</p>{(['n1', 'n2'] as const).map((scenario) => { const results = scenarioResults[scenario]; const latest = results[0]; const counts = results.reduce((acc, item) => { const key = item.error ? 'errors' : item.suggestion?.shouldIntervene === false || item.suggestion?.level === 0 ? 'n0' : `n${item.suggestion?.level ?? 0}` as keyof typeof acc; acc[key] = (acc[key] ?? 0) + 1; return acc }, { n0: 0, n1: 0, n2: 0, n3: 0, errors: 0 }); return <div className="scenario-row" key={scenario}><strong>Scenario {scenario.toUpperCase()} candidate</strong><div className="diagnostic-actions"><button type="button" className="secondary-button" onClick={() => void runScenario(scenario)} disabled={Boolean(scenarioRunning)}>Run once</button><button type="button" className="secondary-button" onClick={() => void runScenario(scenario, 10)} disabled={Boolean(scenarioRunning)}>Run 10 times</button></div>{latest && <div className="scenario-result"><span>MODEL · shouldIntervene: {String(latest.suggestion?.shouldIntervene)} · type: {latest.suggestion?.type ?? '—'} · level: {latest.suggestion?.level ?? '—'} · confidence: {latest.suggestion?.confidence ?? '—'}</span><span>reason: {latest.suggestion?.reason ?? latest.error ?? '—'}</span><span>POLICY · action: {latest.policy?.action ?? '—'} · reason: {latest.policy?.reason ?? '—'}</span><span>PRESENTATION · presented: {latest.policy?.action !== 'ignore' ? 'true' : 'false'} · visualState: {activePresentation?.visualState ?? '—'}</span></div>}{results.length > 1 && <div className="scenario-distribution">N0: {counts.n0} · N1: {counts.n1} · N2: {counts.n2} · N3: {counts.n3} · errors: {counts.errors}</div>}</div> })}</section><section className="current-presentation"><div className="panel-heading"><strong>CURRENT PRESENTATION</strong>{activePresentation && <button className="secondary-button" type="button" onClick={() => clearPresentation('manual')}>Cerrar presentación</button>}</div>{activePresentation ? <div className="presentation-details"><span>source: {activePresentation.source}</span><span>level: {activePresentation.level}</span><span>type: {activePresentation.type}</span><span>visualState: {activePresentation.visualState}</span><span>content: {activePresentation.content}</span><span>createdAt: {activePresentation.createdAt}</span><span>age seconds: {Math.floor((Date.now() - new Date(activePresentation.createdAt).getTime()) / 1000)}</span><span>visible=true</span></div> : <p className="empty-hint">No active presentation</p>}</section><section className="presentation-preview"><strong>PRESENTATION PREVIEW</strong><div className={`presentation-preview-stage ${activePresentation?.visualState ?? irisVisualState}`} data-visual-state={activePresentation?.visualState ?? irisVisualState}><span className="presentation-preview-orb" aria-hidden="true" />{activePresentation?.content && <p>{activePresentation.content}</p>}</div></section>{!selectedId && <p className="empty-hint">No hay una reunión activa.</p>}<div className="diagnostic-flow"><span className={`stage-${diagnosticStages.trigger}`}>TRIGGER<br /><small>{diagnosticStages.trigger}</small></span><b>↓</b><span className={`stage-${diagnosticStages.model}`}>MODEL<br /><small>{diagnosticStages.model}</small></span><b>↓</b><span className={`stage-${diagnosticStages.policy}`}>POLICY<br /><small>{diagnosticStages.policy}</small></span><b>↓</b><span className={`stage-${diagnosticStages.ui}`}>UI<br /><small>{diagnosticStages.ui}</small></span></div><div className="diagnostic-grid"><div><strong>TEST MODE</strong><label className="diagnostic-toggle"><input type="checkbox" checked={interventionTestMode} onChange={(event) => setInterventionTestMode(event.target.checked)} /> Modo de prueba de intervenciones <span>{interventionTestMode ? 'ON' : 'OFF'}</span></label><small>Min segments: {interventionTestMode ? 1 : INTERVENTION_INTENSITY_CONFIG[interventionIntensity].minNewSegments} · Interval: {interventionTestMode ? 8 : Math.round(AUTO_ANALYSIS_MIN_INTERVAL_MS / 1000)}s · Confidence: {interventionTestMode ? 0.35 : INTERVENTION_INTENSITY_CONFIG[interventionIntensity].confidenceThreshold} · Cooldown: {interventionTestMode ? 10 : Math.round(INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs / 1000)}s · Signal cooldown: {interventionTestMode ? 5 : Math.round(SIGNAL_COOLDOWN_MS / 1000)}s</small></div><div><strong>AUTO-ANALYSIS</strong><span>{autoAnalysis ? 'ON' : 'OFF'} · Visual state: {irisVisualState}</span><span>New segments: {newSegmentCount}</span></div><div><strong>TRIGGER</strong><span>{Object.entries(diagnosticTrigger ?? {}).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || 'waiting'}</span></div><div><strong>MODEL</strong><span>Status: {interventionDiagnostic.status}</span><span>Latency: {interventionDiagnostic.latencyMs ?? '—'}ms</span><span>Should intervene: {interventionDiagnostic.suggestion?.shouldIntervene ? 'true' : 'false'} · Type: {interventionDiagnostic.suggestion?.type ?? '—'} · Level: {interventionDiagnostic.suggestion?.level ?? '—'} · Confidence: {interventionDiagnostic.suggestion?.confidence ?? '—'}</span></div><div><strong>POLICY</strong><span>Action: {policyResult?.action ?? '—'} · Reason: {policyResult?.reason ?? '—'}</span><span>Cooldown active: {policyResult?.cooldownActive ? 'true' : 'false'} · Duplicate detected: {policyResult?.duplicateDetected ? 'true' : 'false'}</span></div><div><strong>PRESENTATION / UI</strong><span>Last presentation: {activePresentation ? `${activePresentation.source} · level ${activePresentation.level}` : '—'}</span><span>contentLength: {activePresentation?.content.length ?? 0} · visualState: {activePresentation?.visualState ?? irisVisualState} · visible: {activePresentation ? 'true' : 'false'} · startedAt: {activePresentation?.createdAt ?? '—'}</span><span>Visual state: {irisVisualState}</span><span>Visible message: {activePresentation?.content?.slice(0, 100) || '—'}</span><span>Signal active: {irisVisualState === 'signal' ? 'true' : 'false'} · Intervention active: {irisVisualState === 'interventionLevel2' || irisVisualState === 'interventionLevel3' ? 'true' : 'false'}</span></div></div><div className="diagnostic-actions"><button className="secondary-button" type="button" onClick={() => simulateIntervention(1)}>Simular level 1</button><button className="secondary-button" type="button" onClick={() => simulateIntervention(2)}>Simular level 2</button><button className="secondary-button" type="button" onClick={() => simulateIntervention(3)}>Simular level 3</button>{activePresentation && <button type="button" className="secondary-button" onClick={() => { setWorkspaceOpen(false); setWorkspaceTab('meetings') }}>Ver en Main</button>}<button className="primary-button" type="button" onClick={() => void runInterventionAnalysis()} disabled={!selectedId || !data.segments.length || analyzingIntervention}>Evaluar ahora</button></div><div className="diagnostic-timeline"><strong>EVENT TIMELINE</strong>{diagnosticEvents.length ? diagnosticEvents.map((event, index) => <div key={`${event.at}-${index}`}><time>{event.at}</time><span>{event.label}</span></div>) : <span>waiting</span>}</div></section>}{process.env.NODE_ENV !== 'production' && workspaceOpen && (workspaceTab === 'settings' || workspaceTab === 'facilitator') && <section className="diagnostics-panel panel workspace-tool"><div className="panel-heading"><div><span className="eyebrow">DEVELOPMENT</span><h2>Diagnostics</h2></div><span className="count-badge">{selectedId ? 'selected meeting' : 'no meeting'}</span></div><div className="diagnostic-grid"><div><strong>EXPERIMENTAL</strong><label className="diagnostic-toggle"><input type="checkbox" checked={interventionTestMode} onChange={(event) => setInterventionTestMode(event.target.checked)} /> Modo de prueba de intervenciones <span>{interventionTestMode ? 'ON' : 'OFF'}</span></label>{interventionTestMode && <span className="test-mode-badge">Modo de prueba</span>}</div><div><strong>TRANSCRIPTION</strong><span>finalSegments {data.segments.filter((item) => item.isFinal).length}</span><span>transcriptCharacters {data.segments.filter((item) => item.isFinal).reduce((total, item) => total + item.text.length, 0)}</span><span>lastFinalSegmentAt {data.segments.filter((item) => item.isFinal).at(-1)?.startedAt ?? '—'}</span></div><div><strong>AUTO ANALYSIS</strong><span>enabled {autoAnalysis ? 'true' : 'false'}</span><span>intensity {interventionIntensity}</span><span>minSegments {INTERVENTION_INTENSITY_CONFIG[interventionIntensity].minNewSegments}</span><span>confidenceThreshold {INTERVENTION_INTENSITY_CONFIG[interventionIntensity].confidenceThreshold}</span><span>cooldownMs {INTERVENTION_INTENSITY_CONFIG[interventionIntensity].cooldownMs}</span><span>newSegmentsSinceLastAnalysis {newSegmentCount}</span><span>lastAnalysisAt {lastAnalysisAt ? new Date(lastAnalysisAt).toISOString() : '—'}</span><span>inferenceInProgress {autoAnalysisInFlightRef.current ? 'true' : 'false'}</span><span>diagnosticVisualState {interventionDiagnostic.visualState ?? '—'}</span></div><div><strong>LAST INTERVENTION ANALYSIS</strong><span>status {interventionDiagnostic.status}</span><span>visualState {irisVisualState}</span><span>latencyMs {interventionDiagnostic.latencyMs ?? '—'}</span><span>shouldIntervene {interventionDiagnostic.suggestion?.shouldIntervene ?? '—'}</span><span>type {interventionDiagnostic.suggestion?.type ?? '—'}</span><span>level {interventionDiagnostic.suggestion?.level ?? '—'}</span><span>confidence {interventionDiagnostic.suggestion?.confidence ?? '—'}</span><span>policyAction {interventionDiagnostic.policy?.action ?? '—'}</span><span>policyReason {interventionDiagnostic.policy?.reason ?? '—'}</span></div><div><strong>POST MEETING DETECTIONS</strong><span>status {postMeetingDiagnostic.extraction.status}</span><span>decisionsCount {postMeetingDiagnostic.extraction.decisionsCount}</span><span>tasksCount {postMeetingDiagnostic.extraction.tasksCount}</span><span>commitmentsCount {postMeetingDiagnostic.extraction.commitmentsCount}</span><span>openQuestionsCount {postMeetingDiagnostic.extraction.openQuestionsCount}</span><span>latencyMs {postMeetingDiagnostic.extraction.latencyMs ?? '—'}</span></div><div><strong>MEETING SUMMARY</strong><span>status {postMeetingDiagnostic.summary.status}</span><span>summaryCharacterCount {postMeetingDiagnostic.summary.summaryCharacterCount}</span><span>topicsCount {postMeetingDiagnostic.summary.topicsCount}</span><span>keyPointsCount {postMeetingDiagnostic.summary.keyPointsCount}</span><span>latencyMs {postMeetingDiagnostic.summary.latencyMs ?? '—'}</span></div></div></section>}


    </div>
    {newMeetingOpen && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-meeting-title"><div className="modal-card new-meeting-modal"><div className="modal-heading"><div><span className="eyebrow">ANTES DE ENTRAR A IRIS</span><h2 id="new-meeting-title">Nueva reunión</h2></div><button className="close-button" type="button" onClick={() => setNewMeetingOpen(false)} aria-label="Cerrar"><X size={18} /></button></div><form onSubmit={createNewMeeting}><div className="progress-step" key={preMeetingStep}>{preMeetingStep === 0 && <label><span className="step-question">¿Cómo se llama esta reunión?</span><div className="dictation-field"><input autoFocus required value={newMeetingForm.title} onChange={(event) => setNewMeetingForm((current) => ({ ...current, title: event.target.value }))} placeholder="Ej. Planificación piloto" /><button type="button" className={`dictation-button ${dictatingField === 'title' ? 'active' : ''}`} onClick={() => toggleFieldDictation('title')} aria-label="Dictar nombre de reunión" aria-pressed={dictatingField === 'title'}><Mic size={16} /></button></div></label>}{preMeetingStep === 1 && <label><span className="step-question">¿Qué quieres lograr?</span><div className="dictation-field"><textarea autoFocus rows={4} value={newMeetingForm.objective} onChange={(event) => setNewMeetingForm((current) => ({ ...current, objective: event.target.value }))} placeholder="Puedes dejarlo vacío" /><button type="button" className={`dictation-button ${dictatingField === 'objective' ? 'active' : ''}`} onClick={() => toggleFieldDictation('objective')} aria-label="Dictar objetivo" aria-pressed={dictatingField === 'objective'}><Mic size={16} /></button></div></label>}{preMeetingStep === 2 && <label><span className="step-question">¿Hay contexto previo que Iris deba conocer?</span><div className="dictation-field"><textarea autoFocus rows={4} value={newMeetingForm.contextNotes} onChange={(event) => setNewMeetingForm((current) => ({ ...current, contextNotes: event.target.value }))} placeholder="Opcional" /><button type="button" className={`dictation-button ${dictatingField === 'contextNotes' ? 'active' : ''}`} onClick={() => toggleFieldDictation('contextNotes')} aria-label="Dictar contexto previo" aria-pressed={dictatingField === 'contextNotes'}><Mic size={16} /></button></div></label>}{preMeetingStep === 3 && <div className="agenda-draft-editor"><span className="step-question">Minuta de reunión · hasta 4 temas</span>{agendaSuggestionLoading && <p className="empty-hint" aria-live="polite">La propuesta automática se genera en segundo plano. Esta agenda no cambiará sola mientras la revisas.</p>}{dataError && <p className="empty-hint" role="status">{dataError}</p>}<textarea className="agenda-textarea" rows={9} value={newMeetingForm.agenda} onChange={(event) => { agendaDraftEditedRef.current = true; setNewMeetingForm((current) => ({ ...current, agenda: event.target.value })) }} placeholder="Un punto de agenda por línea" aria-label="Minuta editable" /><div className="agenda-actions">{agendaSuggestionSource === 'model' && recommendedAgendaText && recommendedAgendaText !== newMeetingForm.agenda.trim() && <button type="button" className="secondary-button" onClick={() => { agendaDraftEditedRef.current = true; setNewMeetingForm((current) => ({ ...current, agenda: recommendedAgendaText })) }}>Aplicar propuesta de Iris</button>}<button type="button" className="edit-link" onClick={startFromScratch}>Empezar desde cero</button><button type="button" className="edit-link" onClick={requestAgendaRegeneration}>Regenerar sugerencia</button></div></div>}</div><div className="step-indicator"><span>{preMeetingStep + 1} de 4</span><div><i className={preMeetingStep >= 0 ? 'active' : ''} /><i className={preMeetingStep >= 1 ? 'active' : ''} /><i className={preMeetingStep >= 2 ? 'active' : ''} /><i className={preMeetingStep >= 3 ? 'active' : ''} /></div></div><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => preMeetingStep === 0 ? setNewMeetingOpen(false) : retreatPreMeeting()}>{preMeetingStep === 0 ? 'Cancelar' : 'Atrás'}</button>{preMeetingStep < 3 ? <button className="primary-button" type="submit">Continuar</button> : <><button className="secondary-button" type="button" onClick={() => void saveMeetingDraft(false)} disabled={pending || !newMeetingForm.title.trim()}>{pending ? 'Guardando…' : 'Guardar borrador'}</button><button className="primary-button" type="submit" disabled={pending || !newMeetingForm.title.trim()}>{pending ? 'Iniciando…' : 'Iniciar reunión'}</button></>}</div></form></div></div>}
    {taskEditorOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setTaskEditorOpen(false) }}><form className="task-modal" onSubmit={submitTask} aria-label={taskDraft.id ? 'Editar tarea' : 'Nueva tarea'}><div className="task-modal-header"><div><span className="eyebrow accent">SEGUIMIENTO</span><h2>{taskDraft.id ? 'Editar tarea' : 'Nueva tarea'}</h2><p>Convierte este acuerdo en una acción clara.</p></div><button type="button" className="close-button" onClick={() => setTaskEditorOpen(false)} aria-label="Cerrar formulario"><X size={17} /></button></div><label className="task-field task-field-wide"><span>Qué hay que hacer <em>Obligatorio</em></span><input autoFocus value={taskDraft.text} onChange={(event) => setTaskDraft({ ...taskDraft, text: event.target.value })} placeholder="Ej. Compartir el resumen con el equipo" required /></label><div className="task-fields-row"><label className="task-field"><span>Responsable <small>Opcional</small></span><input value={taskDraft.assignee} onChange={(event) => setTaskDraft({ ...taskDraft, assignee: event.target.value })} placeholder="Nombre o equipo" /></label><label className="task-field"><span>Fecha límite <small>Opcional</small></span><input type="date" value={taskDraft.dueDate} onChange={(event) => setTaskDraft({ ...taskDraft, dueDate: event.target.value })} /></label></div><div className="task-modal-footer"><span><CircleHelp size={14} /> Podrás editarla después</span><button className="primary-button" disabled={pending}>{pending ? 'Guardando…' : taskDraft.id ? 'Guardar cambios' : 'Crear tarea'}</button></div></form></div>}
    <footer className="app-footer"><span>Iris · Reuniones con contexto</span><span>{user.email}</span></footer>
  </main>
}
