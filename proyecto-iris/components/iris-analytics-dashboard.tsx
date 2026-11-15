'use client'

import { useEffect, useMemo, useState } from 'react'
import { getIrisAnalyticsOverviewAction } from '@/app/actions/iris'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type Analytics = Awaited<ReturnType<typeof getIrisAnalyticsOverviewAction>>
type Props = { intensity: 'low' | 'medium' | 'high'; muted: boolean; onIntensityChange: (value: 'low' | 'medium' | 'high') => void; onMutedChange: (value: boolean) => void }
const percent = (value: number, total: number) => total ? Math.round(value / total * 100) : null

export function IrisAnalyticsDashboard({ intensity, muted, onIntensityChange, onMutedChange }: Props) {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scopeMeetingId, setScopeMeetingId] = useState('all')

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError('')
    setLoading(true)
    void getIrisAnalyticsOverviewAction().then((result) => { if (!cancelled) setData(result) }).catch(() => { if (!cancelled) setError('No se pudieron cargar las métricas.') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const scopedData = useMemo(() => {
    if (!data || scopeMeetingId === 'all') return data
    return {
      ...data,
      meetings: data.meetings.filter((item) => item.id === scopeMeetingId),
      interventions: data.interventions.filter((item) => item.meetingId === scopeMeetingId),
      suggestions: data.suggestions.filter((item) => item.meetingId === scopeMeetingId),
      segments: data.segments.filter((item) => item.meetingId === scopeMeetingId),
      decisions: data.decisions.filter((item) => item.meetingId === scopeMeetingId),
      tasks: data.tasks.filter((item) => item.meetingId === scopeMeetingId),
      summaries: data.summaries.filter((item) => item.meetingId === scopeMeetingId),
    }
  }, [data, scopeMeetingId])

  const metrics = useMemo(() => {
    if (!scopedData) return null
    const data = scopedData
    const accepted = data.suggestions.filter((item) => ['accepted', 'edited'].includes(item.status)).length
    const confirmed = data.decisions.filter((item) => item.confirmedByUser || item.status === 'confirmed').length
    const completed = data.tasks.filter((item) => item.status === 'done').length
    const finalSegments = data.segments.filter((item) => item.isFinal).length
    const observation = (item: (typeof data.interventions)[number]) => item.observation?.trim().toLocaleLowerCase() ?? ''
    const ratedItems = data.interventions.filter((item) => ['útil', 'falso positivo'].includes(observation(item)))
    const unclassified = data.interventions.filter((item) => Boolean(observation(item)) && !['útil', 'falso positivo'].includes(observation(item))).length
    const helpful = ratedItems.filter((item) => observation(item) === 'útil').length
    const falsePositives = ratedItems.filter((item) => observation(item) === 'falso positivo').length
    const now = Date.now()
    const durationMinutes = data.meetings.reduce((total, meeting) => {
      const start = meeting.startedAt.getTime()
      const end = meeting.endedAt?.getTime() ?? now
      return total + Math.max(0, Math.round((end - start) / 60000))
    }, 0)
    return {
      interventions: data.interventions.length,
      accepted,
      suggestions: data.suggestions.length,
      confirmed,
      decisions: data.decisions.length,
      completed,
      tasks: data.tasks.length,
      finalSegments,
      rated: ratedItems.length,
      unclassified,
      helpful,
      falsePositives,
      usefulness: percent(helpful, ratedItems.length),
      falsePositiveRate: percent(falsePositives, ratedItems.length),
      acceptance: percent(accepted, data.suggestions.length),
      decisionRate: percent(confirmed, data.decisions.length),
      taskRate: percent(completed, data.tasks.length),
      durationMinutes,
    }
  }, [scopedData])

  const activity = useMemo(() => {
    if (!scopedData) return []
    const meetingStarts = new Map(scopedData.meetings.map((meeting) => [meeting.id, meeting.startedAt.getTime()]))
    const buckets = new Map<number, { minute: number; transcript: number; interventions: number }>()
    for (const segment of scopedData.segments.filter((item) => item.isFinal)) {
      const start = meetingStarts.get(segment.meetingId) ?? segment.startedAt.getTime()
      const minute = Math.max(0, Math.floor((segment.startedAt.getTime() - start) / 300000) * 5)
      const bucket = buckets.get(minute) ?? { minute, transcript: 0, interventions: 0 }
      bucket.transcript += 1
      buckets.set(minute, bucket)
    }
    for (const item of scopedData.interventions) {
      const start = meetingStarts.get(item.meetingId) ?? item.createdAt.getTime()
      const minute = Math.max(0, Math.floor((item.createdAt.getTime() - start) / 300000) * 5)
      const bucket = buckets.get(minute) ?? { minute, transcript: 0, interventions: 0 }
      bucket.interventions += 1
      buckets.set(minute, bucket)
    }
    return [...buckets.values()].sort((a, b) => a.minute - b.minute).map((item) => ({ ...item, name: `${item.minute} min` }))
  }, [scopedData])

  if (loading) return <section className="analytics-view"><div className="analytics-loading" role="status">Cargando métricas…</div></section>
  if (error || !metrics || !scopedData || !data) return <section className="analytics-view"><div className="analytics-empty" role="alert"><h2>No se pudieron cargar las métricas</h2><p>{error || 'Intenta nuevamente.'}</p></div></section>

  if (data.meetings.length === 0) return <section className="analytics-view"><div className="analytics-empty"><h2>Aún no hay reuniones</h2><p>Cuando termines una reunión, aquí aparecerán métricas de actividad, pertinencia y seguimiento.</p></div></section>

  const viewData = scopedData
  const meeting = viewData.meetings[0]
  const meetingTitleById = new Map(viewData.meetings.map((item) => [item.id, item.title]))
  return <section className="analytics-view" aria-labelledby="analytics-title">
    <header className="analytics-header"><div><span className="eyebrow accent">{scopeMeetingId === 'all' ? 'VISTA GENERAL · ÚLTIMAS 100 REUNIONES' : 'REUNIÓN SELECCIONADA'}</span><h2 id="analytics-title">{meeting?.title || 'Rendimiento general'}</h2><p>Las tasas muestran el numerador y la cantidad de casos evaluados.</p></div><label className="analytics-scope">Ver métricas<select value={scopeMeetingId} onChange={(event) => setScopeMeetingId(event.target.value)}><option value="all">Todas las reuniones</option>{data.meetings.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{meeting && <a className="secondary-button analytics-monitor-link" href={`/monitor/${meeting.id}`} target="_blank" rel="noreferrer">Abrir modo Monitor</a>}</header>
    {metrics.rated === 0 && metrics.interventions > 0 && <p className="analytics-feedback-hint">Para medir pertinencia, abre Interacciones y marca cada aporte como Útil o Falso positivo.</p>}
    <div className="analytics-kpis">
      <article><span>INTERVENCIONES</span><strong>{metrics.interventions}</strong><small>{metrics.rated} evaluadas · {metrics.unclassified} con comentario libre</small></article>
      <article><span>VALORACIÓN ÚTIL</span><strong>{metrics.usefulness === null ? '—' : `${metrics.usefulness}%`}</strong><small>{metrics.helpful} útiles de {metrics.rated} evaluadas</small></article>
      <article><span>FALSOS POSITIVOS</span><strong>{metrics.falsePositiveRate === null ? '—' : `${metrics.falsePositiveRate}%`}</strong><small>{metrics.falsePositives} de {metrics.rated} evaluadas</small></article>
      <article><span>TRANSCRIPCIÓN</span><strong>{metrics.finalSegments}</strong><small>{viewData.meetings.length} reuniones · {metrics.durationMinutes} min acumulados</small></article>
    </div>
    <div className="analytics-grid">
      <article className="analytics-card analytics-chart-wide"><div className="analytics-card-heading"><div><span className="eyebrow">RITMO DE LA REUNIÓN</span><h3>Conversación e intervenciones</h3></div><span className="analytics-legend"><i /> Segmentos finales <i /> Intervenciones</span></div><div className="analytics-chart"><ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}><AreaChart data={activity}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeaf3"/><XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: '#9b96a3' }}/><YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: '#9b96a3' }}/><Tooltip/><Area type="monotone" dataKey="transcript" name="Segmentos" stroke="#5969d8" fill="#e8ebff" strokeWidth={2}/><Area type="monotone" dataKey="interventions" name="Intervenciones" stroke="#39a77b" fill="#dcf4e9" strokeWidth={2}/></AreaChart></ResponsiveContainer></div><p className="analytics-note">Cada punto agrupa reuniones por tramos de cinco minutos desde su inicio. Mide actividad, no calidad de transcripción.</p></article>
      <article className="analytics-card"><div className="analytics-card-heading"><div><span className="eyebrow">RESPUESTA DE LA GUÍA</span><h3>Últimas intervenciones</h3></div></div>{viewData.interventions.length === 0 ? <p className="analytics-note">Todavía no hubo intervenciones registradas.</p> : <div className="analytics-interventions">{viewData.interventions.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 6).map((item) => <div key={item.id}><time>{item.createdAt.toLocaleDateString('es-CL')} · {item.createdAt.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</time><small className="analytics-meeting-name">{meetingTitleById.get(item.meetingId) || 'Reunión'}</small><strong>N{item.level} · {item.type.replaceAll('_', ' ')}</strong><p>{item.content}</p><small>{item.observation ? `Evaluación: ${item.observation}` : 'Pendiente de evaluar en Interacciones'}</small></div>)}</div>}</article>
      <article className="analytics-card"><div className="analytics-card-heading"><div><span className="eyebrow">SEGUIMIENTO</span><h3>Qué se convirtió en acción</h3></div></div><div className="analytics-bars">
        <div><span>Sugerencias aceptadas</span><strong>{metrics.accepted}/{metrics.suggestions}{metrics.acceptance !== null ? ` · ${metrics.acceptance}%` : ''}</strong><em style={{ width: `${metrics.acceptance ?? 0}%` }} /></div>
        <div><span>Decisiones confirmadas</span><strong>{metrics.confirmed}/{metrics.decisions}{metrics.decisionRate !== null ? ` · ${metrics.decisionRate}%` : ''}</strong><em style={{ width: `${metrics.decisionRate ?? 0}%` }} /></div>
        <div><span>Tareas completadas</span><strong>{metrics.completed}/{metrics.tasks}{metrics.taskRate !== null ? ` · ${metrics.taskRate}%` : ''}</strong><em style={{ width: `${metrics.taskRate ?? 0}%` }} /></div>
      </div><p className="analytics-note">Las tasas se calculan sobre el total detectado en el alcance seleccionado.</p></article>
    </div>
    <section className="analytics-config"><div><span className="eyebrow accent">COMPORTAMIENTO ACTUAL</span><h3>Ajustes de Iris</h3><p>El cambio afecta evaluaciones futuras; no modifica los registros guardados.</p></div><label>Intensidad<select value={intensity} onChange={(event) => onIntensityChange(event.target.value as Props['intensity'])}><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option></select></label><label className="analytics-toggle"><input type="checkbox" checked={muted} onChange={(event) => onMutedChange(event.target.checked)} /> Silenciar voz</label></section>
    <p className="analytics-disclaimer">La valoración depende de las respuestas “Útil” y “Falso positivo” registradas en Interacciones. No hay una métrica histórica de latencia o errores del proveedor guardada en estos datos.</p>
  </section>
}
