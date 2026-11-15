'use client'

import Image from 'next/image'
import type { PresentationLevel } from '@/components/iris-presentation'

type Presentation = { level: PresentationLevel; content: string; visualState: string } | null
type PresentationLayer = { level: PresentationLevel; content: string }

const faces = ['north', 'east', 'south', 'west'] as const

function stageName(level: PresentationLevel) {
  return level === 1 ? 'Señal' : level === 2 ? 'Mensaje' : 'Intervención'
}

export function IrisPepperGhost({ activePresentation, layers, muted, onClose }: { activePresentation: Presentation; layers: PresentationLayer[]; muted: boolean; onClose: () => void }) {
  const level = activePresentation?.level
  const visibleLayers = level ? layers.filter((layer) => layer.level <= level) : []
  const faceLayers = level === 1 ? [] : level === 2 ? visibleLayers.filter((layer) => layer.level === 2) : visibleLayers
  const accessibleSequence = visibleLayers.map((layer) => `N${layer.level}, ${stageName(layer.level)}: ${layer.content}`).join('. ')

  return <section className="pepper-ghost-overlay" role="dialog" aria-modal="true" aria-label={level ? `Modo pirámide de Iris, nivel ${level}` : 'Modo pirámide de Iris, en espera'}>
    <button className="pepper-ghost-exit" type="button" onClick={onClose} aria-label="Salir del modo pirámide">×</button>
    <div className={`pepper-ghost-scene ${level ? `pepper-ghost-scene-n${level}` : 'pepper-ghost-scene-idle'}`} data-level={level ?? 'idle'}>
      {!level ? <div className="pepper-ghost-signals" aria-hidden="true">
        {faces.map((face) => <span className={`pepper-ghost-signal-dot pepper-ghost-signal-${face}`} key={face} />)}
      </div> : <div className={`pepper-ghost-faces pepper-ghost-pattern-${level}`} aria-hidden="true">
        {faces.map((face) => <div className={`pepper-ghost-face pepper-ghost-face-${face}`} key={face}>
          <div className="pepper-ghost-face-projection">
            <div className="pepper-ghost-directional-eye" aria-hidden="true">
              <Image className="pepper-ghost-image" src="/images/iris-pyramid-projection.png" width={1024} height={1024} alt="" draggable={false} priority />
              <span className="pepper-ghost-gaze-marker" />
            </div>
            {faceLayers.length > 0 && <div className="pepper-ghost-face-copy">
              {faceLayers.map((layer) => <article className={`pepper-ghost-face-stage pepper-ghost-face-stage-n${layer.level}`} key={`${layer.level}-${layer.content}`}>
                <span>N{layer.level} · {stageName(layer.level).toUpperCase()}</span>
                <p>{layer.content}</p>
              </article>)}
            </div>}
          </div>
        </div>)}
      </div>}
      {level !== 1 && <div className="pepper-ghost-center" aria-hidden="true">
        {level ? <Image className="pepper-ghost-center-eye" src="/images/iris-pyramid-projection.png" width={1024} height={1024} alt="" draggable={false} priority /> : <span className="pepper-ghost-idle-orb" />}
      </div>}
      {level === 3 && <span className="sr-only" aria-live="polite">{muted ? 'Voz silenciada.' : 'Voz activa, leyendo la secuencia.'}</span>}
      {level && <span className="sr-only" aria-live="polite">{level === 1 ? 'N1: señal visual discreta.' : accessibleSequence}</span>}
    </div>
  </section>
}
