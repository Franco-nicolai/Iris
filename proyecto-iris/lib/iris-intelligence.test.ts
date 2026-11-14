import { describe, expect, it } from 'vitest'
import { normalizeSuggestedAgenda, suggestedAgendaSchema } from './iris-intelligence'

describe('normalizeSuggestedAgenda', () => {
  it('normaliza rational sin conservar la key desconocida', () => {
    const normalized = normalizeSuggestedAgenda({
      rational: 'La reunión debe revisar los pendientes.',
      agendaItems: [{ title: 'Revisar tareas pendientes', reason: 'Hay tareas abiertas', extra: 'descartar' }],
    })

    expect(normalized).toEqual({
      rationale: 'La reunión debe revisar los pendientes.',
      agendaItems: [{ title: 'Revisar tareas pendientes', reason: 'Hay tareas abiertas' }],
    })
    expect(normalized).not.toHaveProperty('rational')
    expect(suggestedAgendaSchema.safeParse(normalized).success).toBe(true)
  })

  it('normaliza agenda y convierte items string en items válidos', () => {
    const normalized = normalizeSuggestedAgenda({
      agenda: ['Revisar tareas', 'Definir próximos pasos'],
      rational: 'Seguimiento',
    })

    expect(normalized).toEqual({
      rationale: 'Seguimiento',
      agendaItems: [
        { title: 'Revisar tareas', reason: null },
        { title: 'Definir próximos pasos', reason: null },
      ],
    })
    expect(suggestedAgendaSchema.safeParse(normalized).success).toBe(true)
  })
})
