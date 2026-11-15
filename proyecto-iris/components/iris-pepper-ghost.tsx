'use client'
import type { PresentationLevel } from '@/components/iris-presentation'

type Presentation = { level: PresentationLevel; content: string; visualState: string } | null
type PresentationLayer = { level: PresentationLevel; content: string }

const faces = ['north', 'east', 'south', 'west'] as const

export function IrisPepperGhost({ activePresentation, layers, muted, onClose }: { activePresentation: Presentation; layers: PresentationLayer[]; muted: boolean; onClose: () => void }) {
  const level = activePresentation?.level
  const message = activePresentation?.content.trim() || ''

  return <section className="pepper-ghost-overlay" role="dialog" aria-modal="true" aria-label={level ? `Modo pirámide de Iris, nivel ${level}` : 'Modo pirámide de Iris, en espera'}>
    <button className="pepper-ghost-exit" type="button" onClick={onClose} aria-label="Salir del modo pirámide">×</button>
    <div className={`pepper-ghost-scene ${level ? `pepper-ghost-scene-n${level}` : 'pepper-ghost-scene-idle'}`} data-level={level ?? 'idle'}>
      {!level ? <div className="pepper-ghost-signals" aria-hidden="true">
        {faces.map((face) => <span className={`pepper-ghost-signal-dot pepper-ghost-signal-${face}`} key={face} />)}
      </div> : <div className={`pepper-ghost-faces pepper-ghost-pattern-${level}`} aria-hidden="true">
        {faces.map((face) => <div className={`pepper-ghost-face pepper-ghost-face-${face}`} key={face}>
          <div className="pepper-ghost-face-projection">
            {level === 1 && <span className="pepper-ghost-orb" />}
            {level === 2 && <div className="pepper-ghost-message-orb"><p>{message}</p></div>}
            {level === 3 && <div className="pepper-ghost-message-projection"><p>{message}</p></div>}
          </div>
        </div>)}
      </div>}
      {level === 3 && <span className="sr-only" aria-live="polite">{muted ? 'Voz silenciada.' : 'Voz activa, leyendo la secuencia.'}</span>}
      {level && <span className="sr-only" aria-live="polite">{level === 1 ? 'Señal visual de Iris.' : message}</span>}
    </div>
  </section>
}
