'use client'

import { useEffect, useMemo, useState } from 'react'
import { getIrisAnalyticsAction } from '@/app/actions/iris'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type Analytics = Awaited<ReturnType<typeof getIrisAnalyticsAction>>
type Props = { meetingId: string | null; intensity: 'low' | 'medium' | 'high'; muted: boolean; onIntensityChange: (value: 'low' | 'medium' | 'high') => void; onMutedChange: (value: boolean) => void }

export function IrisAnalyticsDashboard({ meetingId, intensity, muted, onIntensityChange, onMutedChange }: Props) {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(Boolean(meetingId))
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError('')
    if (!meetingId) { setLoading(false); return }
    setLoading(true)
    void getIrisAnalyticsAction(meetingId).then((result) => { if (!cancelled) setData(result) }).catch(() => { if (!cancelled) setError('No se pudieron cargar las métricas de esta reunión.') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [meetingId])

  const metrics = useMemo(() => {
    if (!data) return null
    const accepted = data.suggestions.filter((item) => ['accepted', 'edited'].includes(item.status)).length
    const confirmed = data.decisions.filter((item) => item.confirmedByUser || item.status === 'confirmed').length
    const completed = data.tasks.filter((item) => item.status === 'done').length
    const finalSegments = data.segments.filter((item) => item.isFinal).length
    const rated = data.interventions.filter((item) => item.observation).length
    const helpful = data.interventions.filter((item) => item.observation === 'útil').length
    return { interventions: data.interventions.length, accepted, confirmed, completed, finalSegments, rated, helpful, acceptance: data.suggestions.length ? Math.round(accepted / data.suggestions.length * 100) : 0, precision: rated ? Math.round(helpful / rated * 100) : null }
  }, [data])

  const activity = useMemo(() => {
    if (!data) return []
    const start = data.meetings[0]?.startedAt.getTime() ?? Date.now()
    const buckets = new Map<number, { minute: number; transcript: number; interventions: number }>()
    for (const segment of data.segments.filter((item) => item.isFinal)) {
      const minute = Math.max(0, Math.floor((segment.startedAt.getTime() - start) / 300000) * 5)
      const bucket = buckets.get(minute) ?? { minute, transcript: 0, interventions: 0 }
      bucket.transcript += 1
      buckets.set(minute, bucket)
    }
    for (const item of data.interventions) {
      const minute = Math.max(0, Math.floor((item.createdAt.getTime() - start) / 300000) * 5)
      const bucket = buckets.get(minute) ?? { minute, transcript: 0, interventions: 0 }
      bucket.interventions += 1
      buckets.set(minute, bucket)
    }
    return [...buckets.values()].sort((a, b) => a.minute - b.minute).map((item) => ({ ...item, name: `${item.minute} min` }))
  }, [data])

  if (!meetingId) return <section className="analytics-view"><div className="analytics-empty"><h2>Selecciona una reunión</h2><p>El análisis se limita a una reunión a la vez.</p></div></section>
  if (loading) return <section className="analytics-view"><div className="analytics-loading">Cargando métricas de la reunión…</div></section>
  if (error || !metrics || !data) return <section className="analytics-view"><div className="analytics-empty"><h2>No se pudo cargar el análisis</h2><p>{error || 'Intenta seleccionar la reunión nuevamente.'}</p></div></section>

  const meeting = data.meetings[0]
  return <section className="analytics-view" aria-labelledby="analytics-title">
    <header className="analytics-header"><div><span className="eyebrow accent">ANÁLISIS DE SESIÓN</span><h1 id="analytics-title">{meeting?.title || 'Reunión activa'}</h1><p>Solo se muestran datos de esta reunión; no se mezclan con el historial.</p></div><a className="secondary-button analytics-monitor-link" href={`/monitor/${meetingId}`} target="_blank" rel="noreferrer">Abrir monitor móvil</a></header>
    <div className="analytics-kpis"><article><span>INTERVENCIONES ENTREGADAS</span><strong>{metrics.interventions}</strong><small>Durante esta reunión</small></article><article><span>VALORACIÓN POSITIVA</span><strong>{metrics.precision === null ? '—' : `${metrics.precision}%`}</strong><small>{metrics.helpful} útiles de {metrics.rated} evaluadas</small></article><article><span>TRANSCRIPCIÓN</span><strong>{metrics.finalSegments}</strong><small>Segmentos finales</small></article><article><span>RESULTADOS</span><strong>{metrics.confirmed + metrics.completed}</strong><small>{metrics.confirmed} decisiones · {metrics.completed} tareas completadas</small></article></div>
    <div className="analytics-grid"><article className="analytics-card analytics-chart-wide"><div className="analytics-card-heading"><div><span className="eyebrow">EVOLUCIÓN DE LA REUNIÓN</span><h2>Conversación e intervenciones</h2></div><span className="analytics-legend"><i /> Segmentos finales <i /> Intervenciones</span></div><div className="analytics-chart"><ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}><AreaChart data={activity}><CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeaf3"/><XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: '#9b96a3' }}/><YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: '#9b96a3' }}/><Tooltip/><Area type="monotone" dataKey="transcript" name="Segmentos" stroke="#b5a9df" fill="#eee9fb" strokeWidth={2}/><Area type="monotone" dataKey="interventions" name="Intervenciones" stroke="#74b79d" fill="#dff1ea" strokeWidth={2}/></AreaChart></ResponsiveContainer></div></article>
      <article className="analytics-card"><div className="analytics-card-heading"><div><span className="eyebrow">RESPUESTA DE LA GUÍA</span><h2>Intervenciones entregadas</h2></div></div>{data.interventions.length === 0 ? <p className="analytics-note">Todavía no hubo intervenciones registradas.</p> : <div className="analytics-interventions">{data.interventions.slice().reverse().slice(0, 8).map((item) => <div key={item.id}><time>{item.createdAt.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</time><strong>N{item.level} · {item.type.replaceAll('_', ' ')}</strong><p>{item.content}</p><small>{item.observation ? `Evaluación: ${item.observation}` : 'Sin evaluación todavía'}</small></div>)}</div>}</article>
      <article className="analytics-card"><div className="analytics-card-heading"><div><span className="eyebrow">ADOPCIÓN</span><h2>Resultados y seguimiento</h2></div></div><div className="analytics-bars"><div><span>Sugerencias aceptadas</span><strong>{metrics.acceptance}%</strong><em style={{ width: `${metrics.acceptance}%` }} /></div><div><span>Decisiones confirmadas</span><strong>{metrics.confirmed}</strong><em style={{ width: `${Math.min(100, metrics.confirmed * 14)}%` }} /></div><div><span>Tareas completadas</span><strong>{metrics.completed}</strong><em style={{ width: `${Math.min(100, metrics.completed * 14)}%` }} /></div></div><p className="analytics-note">La valoración de utilidad se calcula solo sobre intervenciones que marcaste como útiles o falsos positivos.</p></article>
    </div>
    <section className="analytics-config"><div><span className="eyebrow accent">CONFIGURACIÓN</span><h2>Controla el comportamiento de Iris</h2><p>Estos ajustes modifican las intervenciones de futuras evaluaciones en esta sesión.</p></div><label>Intensidad<select value={intensity} onChange={(event) => onIntensityChange(event.target.value as Props['intensity'])}><option value="low">Baja</option><option value="medium">Media</option><option value="high">Alta</option></select></label><label className="analytics-toggle"><input type="checkbox" checked={muted} onChange={(event) => onMutedChange(event.target.checked)} /> Silenciar voz</label></section>
  </section>
}
