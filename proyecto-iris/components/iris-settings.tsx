'use client'

import { IrisAnalyticsDashboard } from '@/components/iris-analytics-dashboard'

type Props = {
  intensity: 'low' | 'medium' | 'high'
  muted: boolean
  onIntensityChange: (value: 'low' | 'medium' | 'high') => void
  onMutedChange: (value: boolean) => void
}

export function IrisSettings({ intensity, muted, onIntensityChange, onMutedChange }: Props) {
  return <section className="settings-view workspace-tool iris-settings" aria-labelledby="settings-title">
    <header className="settings-header">
      <div>
        <span className="eyebrow accent">RENDIMIENTO</span>
        <h1 id="settings-title">Métricas de Iris</h1>
        <p>Revisa qué aporta Iris y qué resultados deja cada reunión.</p>
      </div>
    </header>
    <IrisAnalyticsDashboard intensity={intensity} muted={muted} onIntensityChange={onIntensityChange} onMutedChange={onMutedChange} />
  </section>
}
