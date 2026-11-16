'use client'

import { useEffect, useRef } from 'react'

export type PresentationLevel = 1 | 2 | 3
export type IrisPresentationData = { source: 'ai' | 'manual' | 'simulation' | 'direct'; level: PresentationLevel; content: string; type: string; createdAt: string; visualState: string }

type IrisPresentationProps = { activePresentation: IrisPresentationData | null; irisVisualState: string; muted: boolean; speechContent?: string; renderContent?: boolean; preview?: boolean; workspaceOpen?: boolean; ambientModeVisible?: boolean; session?: string; onPause?: () => void; onMute?: () => void; onFinish?: () => void; speakEnabled?: boolean }
type IrisSpeechCallbacks = { onStart?: () => void; onError?: (error: string) => void }

function createIrisUtterance(content: string, synthesis: SpeechSynthesis) {
  const spokenContent = content
    .replace(/[`*_#]/g, '')
    .replace(/\s*[:;]\s*/g, ', ')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
  const utterance = new SpeechSynthesisUtterance(spokenContent)
  const voices = synthesis.getVoices()
  const spanishVoices = voices.filter((voice) => /^es[-_]/i.test(voice.lang))
  const naturalVoice = spanishVoices.find((voice) => /natural|neural|premium|enhanced/i.test(voice.name))
  const chileVoice = spanishVoices.find((voice) => /es[-_]CL/i.test(voice.lang))
  const fallbackSpanishVoice = spanishVoices[0]
  const defaultVoice = voices[0]
  const selectedVoice = naturalVoice ?? chileVoice ?? fallbackSpanishVoice ?? defaultVoice
  if (selectedVoice) utterance.voice = selectedVoice
  utterance.lang = selectedVoice?.lang ?? 'es-CL'
  utterance.rate = 0.94
  utterance.pitch = 1.02
  utterance.volume = 1
  return utterance
}

export function queueIrisSpeechChunk(content: string, callbacks: IrisSpeechCallbacks = {}) {
  if (typeof window === 'undefined' || !content.trim() || !window.speechSynthesis) return false
  const synthesis = window.speechSynthesis
  const utterance = createIrisUtterance(content, synthesis)
  utterance.onstart = () => callbacks.onStart?.()
  utterance.onerror = (event) => {
    if (event.error !== 'canceled' && event.error !== 'interrupted') callbacks.onError?.(event.error || 'speech_error')
  }
  try {
    synthesis.resume()
    synthesis.speak(utterance)
  } catch (error) {
    callbacks.onError?.(error instanceof Error ? error.message : 'speech_unavailable')
    return false
  }
  return true
}

export function speakIrisIntervention(content: string) {
  if (typeof window === 'undefined' || !content.trim() || !window.speechSynthesis) return false
  window.speechSynthesis.cancel()
  return queueIrisSpeechChunk(content)
}

export function IrisPresentation({ activePresentation, irisVisualState, muted, speechContent, renderContent = true, preview = false, workspaceOpen = false, ambientModeVisible = true, session, onPause, onMute, onFinish, speakEnabled = true }: IrisPresentationProps) {
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
  </div>
}
