'use client'

import { IrisOrbVisual } from '@/components/iris-orb-visual'

export type IrisPrismLevel = 1 | 2 | 3

const faces = ['north', 'east', 'south', 'west'] as const

export function IrisPrismFaces({ level }: { level: IrisPrismLevel }) {
  return <div className={`iris-prism-faces iris-prism-level-${level}`} data-level={level} aria-hidden="true">
    {faces.map((face) => <div className={`iris-prism-face iris-prism-face-${face}`} key={face}>
      <div className="iris-prism-projection">
        {level === 1 ? <IrisOrbVisual className="prism-orb-visual" /> : <div className={`iris-prism-attention iris-prism-attention-n${level}`} aria-hidden="true"><i /><i /><i /><span /></div>}
      </div>
    </div>)}
  </div>
}
