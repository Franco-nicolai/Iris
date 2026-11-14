'use client'

import { useEffect, useRef } from 'react'

export type PresentationLevel = 1 | 2 | 3
export type IrisPresentationData = { source: 'ai' | 'manual' | 'simulation' | 'direct'; level: PresentationLevel; content: string; type: string; createdAt: string; visualState: string }

type IrisPresentationProps = { activePresentation: IrisPresentationData | null; irisVisualState: string; muted: boolean; speechContent?: string; renderContent?: boolean; onViewMain?: () => void; preview?: boolean; workspaceOpen?: boolean; ambientModeVisible?: boolean; session?: string; onPause?: () => void; onMute?: () => void; onFinish?: () => void; speakEnabled?: boolean }

function createIrisUtterance(content: string, synthesis: SpeechSynthesis) {
  const utterance = new SpeechSynthesisUtterance(content)
  const voices = synthesis.getVoices()
  const spanishVoice = voices.find((voice) => /es[-_]CL/i.test(voice.lang))
  const fallbackSpanishVoice = voices.find((voice) => /es[-_]/i.test(voice.lang))
  const defaultVoice = voices[0]
  const selectedVoice = spanishVoice ?? fallbackSpanishVoice ?? defaultVoice
  if (selectedVoice) utterance.voice = selectedVoice
  utterance.lang = spanishVoice?.lang ?? fallbackSpanishVoice?.lang ?? defaultVoice?.lang ?? 'es-CL'
  utterance.rate = 1
  utterance.pitch = 1
  utterance.volume = 1
  return utterance
}

export function queueIrisSpeechChunk(content: string) {
  if (typeof window === 'undefined' || !content.trim() || !window.speechSynthesis) return false
  window.speechSynthesis.speak(createIrisUtterance(content, window.speechSynthesis))
  return true
}

export function speakIrisIntervention(content: string) {
  if (typeof window === 'undefined' || !content.trim() || !window.speechSynthesis) return false
  window.speechSynthesis.cancel()
  return queueIrisSpeechChunk(content)
}

export function IrisPresentation({ activePresentation, irisVisualState, muted, speechContent, renderContent = true, onViewMain, preview = false, workspaceOpen = false, ambientModeVisible = true, session, onPause, onMute, onFinish, speakEnabled = true }: IrisPresentationProps) {
  const spokenPresentationRef = useRef<string | null>(null)
  useEffect(() => { if (activePresentation && process.env.NODE_ENV !== 'production') console.log('[v0] PRESENTATION_RENDERED', { level: activePresentation.level, visualState: activePresentation.visualState, workspaceOpen, ambientModeVisible }) }, [activePresentation, ambientModeVisible, workspaceOpen])
  useEffect(() => {
    if (!speakEnabled || !activePresentation || activePresentation.level !== 3 || muted) return
    const spokenContent = speechContent ?? activePresentation.content
    const presentationId = `${activePresentation.createdAt}:${activePresentation.level}:${spokenContent}`
    if (spokenPresentationRef.current === presentationId) return
    spokenPresentationRef.current = presentationId
    speakIrisIntervention(spokenContent)
  }, [activePresentation, muted, speechContent, speakEnabled])

  const level = activePresentation?.level ?? 0
  const state = activePresentation?.visualState ?? irisVisualState
  if (!activePresentation || !renderContent) return null
  return <div className={`iris-presentation ${preview ? 'iris-presentation-preview' : ''} ${state} iris-presentation-level-${level}`} data-presentation-level={level} role={level === 1 ? 'status' : undefined} aria-live={level === 3 ? 'assertive' : 'polite'}>
    <div className="iris-presentation-message"><span className="iris-presentation-label">IRIS · {level === 1 ? 'SEÑAL' : `NIVEL ${level}`}</span><p>{activePresentation.content}</p></div>
    {onViewMain && <button type="button" className="secondary-button" onClick={onViewMain}>Ver en Main</button>}
  </div>
}
