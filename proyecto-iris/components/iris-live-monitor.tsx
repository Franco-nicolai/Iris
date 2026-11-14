'use client'

import useSWR from 'swr'
import { listMeetingData } from '@/app/actions/iris'

export function IrisLiveMonitor({ meetingId }: { meetingId: string }) {
  const { data, error, isLoading, mutate } = useSWR(['iris-live-monitor', meetingId], () => listMeetingData(meetingId), { refreshInterval: 3000, revalidateOnFocus: true })

  if (isLoading) return <main className="mobile-monitor"><p role="status">Conectando con la reunión…</p></main>
  if (error || !data) return <main className="mobile-monitor"><section className="mobile-monitor-card"><h1>No se pudo abrir esta reunión</h1><p>Inicia sesión con la misma cuenta de Iris que está usando el computador, o revisa que el enlace corresponda a una reunión tuya.</p></section></main>

  const finalSegments = data.segments.filter((segment) => segment.isFinal)
  const activeAgenda = data.agenda.find((item) => item.status === 'active')
  const latestIntervention = data.interventions.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  const latestTranscript = finalSegments.slice().sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, 5)

  return <main className="mobile-monitor">
    <header className="mobile-monitor-header"><a href="/" className="mobile-monitor-brand"><span>i</span> Iris</a><span className={`mobile-monitor-status ${data.meeting?.status === 'live' ? 'is-live' : ''}`}><i />{data.meeting?.status === 'live' ? 'En vivo' : data.meeting?.status === 'ended' ? 'Finalizada' : 'En pausa'}</span></header>
    <section className="mobile-monitor-title"><span className="eyebrow accent">MONITOR REMOTO</span><h1>{data.meeting?.title || 'Reunión'}</h1><p>Actualización automática cada 3 segundos</p></section>
    <section className="mobile-monitor-kpis" aria-label="Métricas de la reunión"><article><span>SEGMENTOS</span><strong>{finalSegments.length}</strong></article><article><span>INTERVENCIONES</span><strong>{data.interventions.length}</strong></article><article><span>DECISIONES</span><strong>{data.decisions.length}</strong></article><article><span>TAREAS</span><strong>{data.tasks.length}</strong></article></section>
    <section className="mobile-monitor-card"><span className="eyebrow">PUNTO ACTIVO</span><h2>{activeAgenda?.title || 'Sin punto activo en la minuta'}</h2>{activeAgenda?.note && <p>{activeAgenda.note}</p>}</section>
    <section className="mobile-monitor-card"><div className="mobile-monitor-card-heading"><div><span className="eyebrow">GUÍA DE IRIS</span><h2>Última intervención</h2></div><button type="button" onClick={() => void mutate()} aria-label="Actualizar monitor">Actualizar</button></div>{latestIntervention ? <div className="mobile-monitor-intervention"><strong>Nivel {latestIntervention.level} · {latestIntervention.type.replaceAll('_', ' ')}</strong><p>{latestIntervention.content}</p><small>{latestIntervention.createdAt.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}{latestIntervention.observation ? ` · ${latestIntervention.observation}` : ''}</small></div> : <p className="mobile-monitor-muted">Aún no hay intervenciones.</p>}</section>
    <section className="mobile-monitor-card"><span className="eyebrow">TRANSCRIPCIÓN RECIENTE</span>{latestTranscript.length ? <div className="mobile-monitor-transcript">{latestTranscript.map((segment) => <article key={segment.id}><time>{segment.startedAt.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</time><p><strong>{segment.speaker}:</strong> {segment.text}</p></article>)}</div> : <p className="mobile-monitor-muted">La transcripción aparecerá aquí cuando haya segmentos finales.</p>}</section>
  </main>
}
