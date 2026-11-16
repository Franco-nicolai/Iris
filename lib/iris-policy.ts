export const INTERVENTION_INTENSITY_CONFIG = { low: { confidenceThreshold: 0.85, minNewSegments: 4, cooldownMs: 90_000 }, medium: { confidenceThreshold: 0.75, minNewSegments: 3, cooldownMs: 45_000 }, high: { confidenceThreshold: 0.65, minNewSegments: 2, cooldownMs: 30_000 } } as const
export type InterventionIntensity = keyof typeof INTERVENTION_INTENSITY_CONFIG
export const INTERVENTION_TEST_MODE_CONFIG = { minNewSegments: 1, minAnalysisIntervalMs: 8_000, confidenceThreshold: 0.35, cooldownMs: 10_000, signalCooldownMs: 5_000 } as const
export const AUTO_ANALYSIS_MIN_INTERVAL_MS = 15_000
export const AUTO_ANALYSIS_MIN_NEW_SEGMENTS = 3
export const INTERVENTION_COOLDOWN_MS = 45_000
export const INTERVENTION_DUPLICATE_WINDOW_MS = 5 * 60_000
export const SIGNAL_COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS) > 0 ? Number(process.env.SIGNAL_COOLDOWN_MS) : 12_000

export type InterventionAction = 'ignore' | 'signal' | 'show'
export type InterventionSuggestion = { shouldIntervene: boolean; level: 0 | 1 | 2 | 3; type: string; content: string; reason: string; confidence: number }
export type PolicyContext = { now?: number; muted?: boolean; cooldownUntil?: number; recentInterventions?: Array<{ type: string; content: string; createdAt: string | Date }>; activeAgendaItemId?: string | null; intensity?: InterventionIntensity; signalCooldownUntil?: number; confidenceThreshold?: number }
export type InterventionPolicyResult = { action: InterventionAction; level: 0 | 1 | 2 | 3; reason: string; cooldownActive: boolean; duplicateDetected: boolean; repeatedIssueCount: number }

function normalize(value: string) { return value.trim().toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ') }
function similar(a: InterventionSuggestion, b: { type: string; content: string }) { return a.type === b.type && normalize(a.content) === normalize(b.content) }

export function evaluateInterventionPolicy(suggestion: InterventionSuggestion, context: PolicyContext = {}): InterventionPolicyResult {
  const now = context.now ?? Date.now()
  const intensity = INTERVENTION_INTENSITY_CONFIG[context.intensity ?? 'medium']
  const recent = (context.recentInterventions ?? []).filter((item) => now - new Date(item.createdAt).getTime() <= INTERVENTION_DUPLICATE_WINDOW_MS)
  const duplicateDetected = recent.some((item) => similar(suggestion, item))
  const repeatedIssueCount = recent.filter((item) => item.type === suggestion.type).length
  const interventionCooldownActive = Boolean(context.cooldownUntil && context.cooldownUntil > now)
  const signalCooldownActive = Boolean(context.signalCooldownUntil && context.signalCooldownUntil > now)
  const cooldownActive = suggestion.level === 1 ? signalCooldownActive : interventionCooldownActive
  let action: InterventionAction = 'show'
  let reason = 'level_allows_intervention'
  if (context.muted) { action = 'ignore'; reason = 'muted' }
  else if (!suggestion.shouldIntervene) { action = 'ignore'; reason = 'should_intervene_false' }
  else if (suggestion.level === 0) { action = 'ignore'; reason = 'level_zero' }
  else if (suggestion.confidence < (context.confidenceThreshold ?? intensity.confidenceThreshold)) { action = 'ignore'; reason = 'confidence_below_threshold' }
  else if (cooldownActive) { action = 'ignore'; reason = 'cooldown' }
  else if (duplicateDetected) { action = 'ignore'; reason = 'duplicate' }
  else if (suggestion.level === 1) { action = 'signal'; reason = 'level_one_signal' }
  else if (suggestion.level === 2 || suggestion.level === 3) { action = 'show' }
  return { action, level: suggestion.level, reason, cooldownActive, duplicateDetected, repeatedIssueCount }
}

export function latestFinalSegmentId(segments: Array<{ id: string; isFinal: boolean }>) { return segments.filter((segment) => segment.isFinal).at(-1)?.id ?? null }
export function countNewFinalSegments(segments: Array<{ id: string; isFinal: boolean }>, lastAnalyzedSegmentId: string | null) {
  const finals = segments.filter((segment) => segment.isFinal)
  if (!lastAnalyzedSegmentId) return finals.length
  const index = finals.findIndex((segment) => segment.id === lastAnalyzedSegmentId)
  return index < 0 ? finals.length : finals.length - index - 1
}
