'use client'

import { useEffect, useRef, useState } from 'react'
import { IrisOrbVisual } from '@/components/iris-orb-visual'

export type IrisPrismLevel = 1 | 2 | 3

const faces = ['north', 'east', 'south', 'west'] as const

export function IrisPrismFaces({ level, message }: { level: IrisPrismLevel; message: string }) {
  const facesRef = useRef<HTMLDivElement>(null)
  const [fontSize, setFontSize] = useState(18)

  useEffect(() => {
    if (level === 1 || !facesRef.current) return
    const facesNode = facesRef.current
    const card = facesNode.querySelector<HTMLElement>('.iris-prism-message')
    if (!card) return
    const fitMessage = () => {
      const width = Math.max(0, card.clientWidth - 28)
      const height = Math.max(0, card.clientHeight - 28)
      const fitted = Math.sqrt((width * height) / (Math.max(message.length, 1) * 0.72))
      setFontSize(Math.round(Math.max(10, Math.min(24, fitted)) * 10) / 10)
    }
    fitMessage()
    const observer = new ResizeObserver(fitMessage)
    observer.observe(card)
    return () => observer.disconnect()
  }, [level, message])

  return <div ref={facesRef} className={`iris-prism-faces iris-prism-level-${level}`} data-level={level} aria-hidden="true">
    {faces.map((face) => <div className={`iris-prism-face iris-prism-face-${face}`} key={face}>
      <div className="iris-prism-projection">
        <IrisOrbVisual className="prism-orb-visual" />{level > 1 && <div className="iris-prism-message"><p style={{ fontSize }}>{message}</p></div>}
      </div>
    </div>)}
  </div>
}
