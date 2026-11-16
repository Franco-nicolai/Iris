'use client'

import useSWR from 'swr'
import { getMeetingPrismState } from '@/app/actions/iris'
import { IrisPrismFaces } from '@/components/iris-prism-faces'

export function IrisLiveMonitor({ meetingId }: { meetingId: string }) {
  const { data, error, isLoading, mutate } = useSWR(['iris-live-monitor', meetingId], () => getMeetingPrismState(meetingId), { refreshInterval: 500, dedupingInterval: 0, revalidateOnFocus: true, refreshWhenHidden: false })
  if (isLoading) return <main className="iris-remote-screen remote-loading"><p role="status">Conectando con Iris…</p></main>
  if (error || !data?.meeting) return <main className="iris-remote-screen remote-failed"><section className="iris-remote-error"><h1>No se pudo abrir esta reunión</h1><p>Inicia sesión con la misma cuenta de Iris que está usando el computador.</p></section></main>

  const intervention = data.intervention
  const currentMessage = intervention?.content?.trim() || data.activeAgenda?.title || 'Iris está escuchando la reunión.'
  const level = intervention?.level === 3 ? 3 : intervention?.level === 2 ? 2 : 1
  const live = data.meeting.status === 'live'

  return <main className="iris-remote-screen" data-level={level}>
    <header className="iris-remote-header"><span className="iris-remote-brand"><i>i</i> Iris</span><span className="iris-remote-mode">PRISMA · SIN AUDIO</span><span className={`iris-remote-live ${live ? 'is-live' : ''}`}><i />{live ? 'EN VIVO' : data.meeting.status === 'ended' ? 'FINALIZADA' : 'EN PAUSA'}</span><button type="button" onClick={() => void mutate()} aria-label="Actualizar pantalla">↻</button></header>
    <div className="iris-remote-title"><h1>{data.meeting.title}</h1><p>{data.activeAgenda?.title || 'Sin punto activo'}</p></div>
    <section className={`iris-remote-prism level-${level}`} aria-live="off" aria-label="Pantalla prisma de Iris">
      <IrisPrismFaces level={level} />
    </section>
    <footer className="iris-remote-footer"><span>{intervention ? 'INTERACCIÓN DE IRIS' : 'ESCUCHANDO'}</span><p>{currentMessage}</p><small>Sincronización automática cada 0,5 s · sin micrófono ni reproducción de voz</small></footer>
  </main>
}
