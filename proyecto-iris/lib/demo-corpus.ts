import type { KnowledgeItem } from './iris-domain'

export const demoCorpus: KnowledgeItem[] = [
  {
    id: 'knowledge-budget-pilot',
    title: 'Restricción de presupuesto del piloto',
    content: 'El piloto debe mantenerse dentro de un presupuesto máximo de 20.000 EUR.',
    source: { type: 'document', label: 'Brief de producto · DEMO' },
    sourceDate: '2026-09-08T09:00:00.000Z',
    validity: 'current',
    permissions: { canView: true, canUseForSuggestions: true },
    isDemo: true,
  },
  {
    id: 'knowledge-old-export-decision',
    title: 'Decisión anterior sobre exportación',
    content: 'La exportación avanzada se pospone hasta después del piloto de onboarding.',
    source: { type: 'meeting', label: 'Minuta de producto · DEMO' },
    sourceDate: '2026-09-05T10:00:00.000Z',
    validity: 'superseded',
    permissions: { canView: true, canUseForSuggestions: true },
    isDemo: true,
  },
  {
    id: 'knowledge-current-scope',
    title: 'Alcance vigente del piloto',
    content: 'Mantener el primer piloto centrado en onboarding y posponer la exportación avanzada.',
    source: { type: 'document', label: 'Minuta de producto · DEMO' },
    sourceDate: '2026-09-10T10:00:00.000Z',
    validity: 'current',
    permissions: { canView: true, canUseForSuggestions: true },
    isDemo: true,
  },
  {
    id: 'knowledge-pending-flow',
    title: 'Tarea pendiente del flujo',
    content: 'Preparar el flujo de onboarding y compartirlo el jueves. Responsable todavía no definido.',
    source: { type: 'task', label: 'Seguimiento de coordinación · DEMO' },
    sourceDate: '2026-09-12T10:00:00.000Z',
    validity: 'current',
    permissions: { canView: true, canUseForSuggestions: true },
    isDemo: true,
  },
]
