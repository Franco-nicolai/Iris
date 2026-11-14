import { demoCorpus } from './demo-corpus'
import type { KnowledgeItem, Suggestion, TranscriptSegment } from './iris-domain'

const explicitSignals = {
  agreement: /\b(de acuerdo|acordamos|queda decidido|sí,? entonces|confirmamos)\b/i,
  decision: /\b(decidimos|decisión|vamos a|se hará|dejamos|mantener|posponer)\b/i,
  responsibility: /\b(yo puedo|me encargo|responsable|preparar(?:é|é)?|haré)\b/i,
  missingResponsibility: /\b(sin responsable|responsable todavía no definido|¿quién)\b/i,
}

const normalize = (value: string) => value.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const hasSharedTerms = (a: string, b: string) => {
  const aTerms = new Set(normalize(a).split(/\W+/).filter((term) => term.length > 4))
  return normalize(b).split(/\W+/).some((term) => term.length > 4 && aTerms.has(term))
}

function findEvidence(text: string, corpus: KnowledgeItem[]) {
  return corpus
    .filter((item) => item.permissions.canView && item.permissions.canUseForSuggestions && hasSharedTerms(text, `${item.title} ${item.content}`))
    .sort((a, b) => Date.parse(b.sourceDate) - Date.parse(a.sourceDate))
}

export function evaluateSegments(segments: TranscriptSegment[], corpus: KnowledgeItem[] = demoCorpus): Suggestion {
  const finalizedText = segments.filter((segment) => segment.isFinal).map((segment) => segment.text).join(' ')
  const evidence = findEvidence(finalizedText, corpus)
  const bestEvidence = evidence[0]
  const currentEvidence = evidence.find((item) => item.validity === 'current')
  const explicitAgreement = explicitSignals.agreement.test(finalizedText)
  const explicitDecision = explicitSignals.decision.test(finalizedText)
  const missingOwner = explicitSignals.missingResponsibility.test(finalizedText) || (explicitDecision && !explicitSignals.responsibility.test(finalizedText) && /\b(tarea|flujo|preparar|seguimiento)\b/i.test(finalizedText))

  let category: Suggestion['category'] = 'neutral'
  let recommendedAction = 'No realizar ninguna acción: seguir observando señales explícitas.'
  if (missingOwner) {
    category = 'falta_responsable'
    recommendedAction = 'Pedir a la persona usuaria que asigne un responsable antes de guardar la tarea.'
  } else if (explicitAgreement) {
    category = 'acuerdo_alcanzado'
    recommendedAction = 'Proponer el acuerdo para confirmación humana; no guardarlo todavía.'
  } else if (explicitDecision && !currentEvidence && !bestEvidence) {
    category = 'decision_sin_antecedente'
    recommendedAction = 'Proponer registrar la decisión como borrador y solicitar confirmación humana.'
  }

  if (!bestEvidence) {
    return { id: `suggestion-${Date.now()}`, category, evidence: [], validity: 'not_found', recommendedAction, status: 'proposed' }
  }

  return {
    id: `suggestion-${bestEvidence.id}`,
    category,
    evidence: [bestEvidence.content],
    validity: bestEvidence.validity,
    recommendedAction,
    status: 'proposed',
  }
}
