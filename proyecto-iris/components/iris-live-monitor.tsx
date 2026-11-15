'use client'

import useSWR from 'swr'
import { listMeetingData } from '@/app/actions/iris'

const faces = ['north', 'east', 'south', 'west'] as const

export function IrisLiveMonitor({ meetingId }: { meetingId: string }) {
  const { data, error, isLoading, mutate } = useSWR(['iris-live-monitor', meetingId], () => listMeetingData(meetingId), { refreshInterval: 1200, revalidateOnFocus: true })

  if (isLoading) return <main className="iris-remote-screen remote-loading"><p role="status">Conectando con Iris…</p></main>
  if (error || !data) return <main className="iris-remote-screen remote-failed"><section className="iris-remote-error"><h1>No se pudo abrir esta reunión</h1><p>Inicia sesión con la misma cuenta de Iris que está usando el computador.</p></section></main>

  const activeAgenda = data.agenda.find((item) => item.status === 'active')
  const latestIntervention = data.interventions.filter((item) => item.status === 'active').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  const currentMessage = latestIntervention?.content?.trim() || activeAgenda?.title || 'Iris está escuchando la reunión.'
  const level = latestIntervention?.level === 3 ? 3 : latestIntervention?.level === 2 ? 2 : 1
  const live = data.meeting?.status === 'live'

  return <main className="iris-remote-screen" data-level={level}>
    <header className="iris-remote-header"><span className="iris-remote-brand"><i>i</i> Iris</span><span className={`iris-remote-live ${live ? 'is-live' : ''}`}><i />{live ? 'EN VIVO' : data.meeting?.status === 'ended' ? 'FINALIZADA' : 'EN PAUSA'}</span><button type="button" onClick={() => void mutate()} aria-label="Actualizar pantalla">↻</button></header>
    <div className="iris-remote-title"><h1>{data.meeting?.title || 'Reunión'}</h1><p>{activeAgenda?.title || 'Sin punto activo'}</p></div>
    <section className={`iris-remote-prism level-${level}`} aria-live="polite" aria-label="Interacción actual de Iris">
      <p className="sr-only">{currentMessage}</p>
      <div className="iris-remote-faces" aria-hidden="true">{faces.map((face) => <div className={`iris-remote-face face-${face}`} key={face}><div className={`iris-remote-projection ${level > 1 ? 'has-message' : ''}`}>{level === 1 ? <span className="iris-remote-orb" /> : <p className="iris-remote-message-text">{currentMessage}</p>}</div></div>)}</div>
    </section>
    <footer className="iris-remote-footer"><span>{latestIntervention ? 'INTERACCIÓN DE IRIS' : 'ESCUCHANDO'}</span><p>{currentMessage}</p><small>Sincronización automática · última actualización {new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small></footer>
  </main>
}
