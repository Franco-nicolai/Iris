export type SpeechRecognitionResultLike = { isFinal: boolean; 0: { transcript: string } }
export type SpeechRecognitionEventLike = { results: ArrayLike<SpeechRecognitionResultLike> }
export type SpeechRecognitionErrorCode = 'not-allowed' | 'service-not-allowed' | 'audio-capture' | 'network' | 'no-speech' | 'aborted' | string

type RecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: SpeechRecognitionErrorCode; message?: string; type?: string } | Event) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type RecognitionConstructor = new () => RecognitionLike

export function getSpeechRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const browserWindow = window as typeof window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null
}

export class WebSpeechTranscriptionProvider {
  private recognition: RecognitionLike | null = null
  private shouldBeListening = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempts = 0
  private lastFinalKey: string | null = null
  private onInterimCallback: (text: string) => void = () => undefined
  private onFinalCallback: (text: string) => void = () => undefined
  private onErrorCallback: (code: SpeechRecognitionErrorCode) => void = () => undefined
  private onStateCallback: (state: 'started' | 'ended') => void = () => undefined

  constructor(private readonly language = 'es-CL') {}

  get supported() { return getSpeechRecognitionConstructor() !== null }
  get listening() { return this.shouldBeListening }

  onInterim(callback: (text: string) => void) { this.onInterimCallback = callback; return this }
  onFinal(callback: (text: string) => void) { this.onFinalCallback = callback; return this }
  onError(callback: (code: SpeechRecognitionErrorCode) => void) { this.onErrorCallback = callback; return this }
  onState(callback: (state: 'started' | 'ended') => void) { this.onStateCallback = callback; return this }

  start() {
    const Constructor = getSpeechRecognitionConstructor()
    if (!Constructor) throw new Error('El reconocimiento de voz requiere un navegador compatible, recomendado Chrome.')
    if (this.shouldBeListening) return
    this.shouldBeListening = true
    this.restartAttempts = 0
    this.recognition = new Constructor()
    this.recognition.lang = this.language
    this.recognition.continuous = true
    this.recognition.interimResults = true
    this.recognition.maxAlternatives = 1
    this.recognition.onresult = (event) => {
      let interim = ''
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        const text = result[0]?.transcript.trim()
        if (!text) continue
        if (result.isFinal) {
          const key = text.toLocaleLowerCase().replace(/\s+/g, ' ')
          if (this.lastFinalKey !== key) { this.lastFinalKey = key; this.onFinalCallback(text) }
        } else interim += `${text} `
      }
      this.onInterimCallback(interim.trim())
    }
    this.recognition.onerror = (event) => {
      const speechEvent = event as { error?: SpeechRecognitionErrorCode; message?: string; type?: string }
      const code = typeof speechEvent.error === 'string' && speechEvent.error.trim() ? speechEvent.error : 'unknown'
      this.onErrorCallback(code)
      if (code === 'not-allowed' || code === 'service-not-allowed') this.shouldBeListening = false
      if (code === 'aborted') this.restartAttempts = 0
    }
    this.recognition.onend = () => {
      this.onStateCallback('ended')
      if (!this.shouldBeListening) return
      const delay = Math.min(4000, 300 + this.restartAttempts * 500)
      this.restartAttempts += 1
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = setTimeout(() => {
        if (!this.shouldBeListening || !this.recognition) return
        try { this.recognition.start(); this.onStateCallback('started') } catch { this.restartAttempts += 1 }
      }, delay)
    }
    try { this.recognition.start(); this.onStateCallback('started') } catch (error) { this.shouldBeListening = false; throw error }
  }

  stop() {
    this.shouldBeListening = false
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    this.recognition?.stop()
    this.recognition = null
    this.onInterimCallback('')
  }

  dispose() { this.stop(); this.lastFinalKey = null }
}
