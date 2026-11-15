'use client'
import type { PresentationLevel } from '@/components/iris-presentation'
import { IrisPrismFaces } from '@/components/iris-prism-faces'

type Presentation = { level: PresentationLevel; content: string; visualState: string } | null
export function IrisPepperGhost({ activePresentation, muted, onClose }: { activePresentation: Presentation; muted: boolean; onClose: () => void }) {
  const level = activePresentation?.level ?? 1
  const message = activePresentation?.content.trim() || 'Iris está escuchando la reunión.'

  return <section className="pepper-ghost-overlay" role="dialog" aria-modal="true" aria-label={level ? `Modo pirámide de Iris, nivel ${level}` : 'Modo pirámide de Iris, en espera'}>
    <button className="pepper-ghost-exit" type="button" onClick={onClose} aria-label="Salir del modo pirámide">×</button>
    <div className={`pepper-ghost-scene ${activePresentation ? `pepper-ghost-scene-n${level}` : 'pepper-ghost-scene-idle'}`} data-level={activePresentation?.level ?? 'idle'}>
      <IrisPrismFaces level={level} message={message} />
      {level === 3 && <span className="sr-only" aria-live="polite">{muted ? 'Voz silenciada.' : 'Voz activa, leyendo la secuencia.'}</span>}
      {level && <span className="sr-only" aria-live="polite">{level === 1 ? 'Señal visual de Iris.' : message}</span>}
    </div>
  </section>
}
