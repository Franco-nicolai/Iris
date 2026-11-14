import { describe, expect, it } from 'vitest'
import { demoCorpus } from './demo-corpus'
import { evaluateSegments } from './contextual-evaluator'
import { transcriptSegmentSchema } from './iris-domain'

const segment = (text: string) => transcriptSegmentSchema.parse({
  id: crypto.randomUUID(), meetingId: 'meeting-demo', speaker: 'Ana', text,
  startedAt: '2026-09-12T10:00:00.000Z', endedAt: '2026-09-12T10:00:10.000Z', isFinal: true,
})

describe('Iris contextual evaluator', () => {
  it('uses current evidence when an explicit agreement matches it', () => {
    const result = evaluateSegments([segment('De acuerdo, mantenemos el piloto centrado en onboarding.')])
    expect(result.category).toBe('acuerdo_alcanzado')
    expect(result.validity).toBe('current')
    expect(result.evidence).toHaveLength(1)
  })

  it('does not present superseded evidence as a contradiction', () => {
    const result = evaluateSegments([segment('Decidimos posponer la exportación avanzada.')], [demoCorpus[1]])
    expect(result.validity).toBe('superseded')
    expect(result.category).not.toBe('decision_sin_antecedente')
  })

  it('returns not_found without sufficient explicit evidence', () => {
    const result = evaluateSegments([segment('Quizá podríamos revisarlo más adelante.')])
    expect(result.validity).toBe('not_found')
    expect(result.evidence).toEqual([])
  })

  it('detects a missing responsible person explicitly', () => {
    const result = evaluateSegments([segment('Hay que preparar el flujo, pero queda sin responsable.')])
    expect(result.category).toBe('falta_responsable')
  })
})
