import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSpeechTranscriptionProvider } from './web-speech-provider'

class MockRecognition {
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 0
  onresult: ((event: any) => void) | null = null; onerror: ((event: any) => void) | null = null; onend: (() => void) | null = null
  start = vi.fn(() => undefined); stop = vi.fn(() => { this.onend?.() }); abort = vi.fn()
}

describe('WebSpeechTranscriptionProvider', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  function setup() { vi.stubGlobal('window', { SpeechRecognition: MockRecognition }); return new WebSpeechTranscriptionProvider() }
  it('detecta navegador sin soporte', () => { vi.stubGlobal('window', {}); expect(new WebSpeechTranscriptionProvider().supported).toBe(false) })
  it('configura e inicia con es-CL', () => { const provider = setup(); provider.start(); expect(provider.supported).toBe(true) })
  it('emite interim pero solo emite final y no duplica', () => { const provider = setup(); const interim = vi.fn(); const final = vi.fn(); provider.onInterim(interim).onFinal(final); provider.start(); const recognition = (provider as any).recognition as MockRecognition; recognition.onresult?.({ results: [{ isFinal: false, 0: { transcript: 'hola' } }] }); recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'hola mundo' } }] }); recognition.onresult?.({ results: [{ isFinal: true, 0: { transcript: 'hola mundo' } }] }); expect(interim).toHaveBeenCalledWith('hola'); expect(final).toHaveBeenCalledTimes(1) })
  it('reinicia al terminar mientras escucha y no reinicia después de stop', () => { vi.useFakeTimers(); const provider = setup(); provider.start(); const recognition = (provider as any).recognition as MockRecognition; recognition.onend?.(); vi.advanceTimersByTime(300); expect(recognition.start).toHaveBeenCalledTimes(2); provider.stop(); recognition.onend?.(); vi.advanceTimersByTime(5000); expect(recognition.start).toHaveBeenCalledTimes(2); vi.useRealTimers() })
  it('detiene ante not-allowed y tolera no-speech', () => { const provider = setup(); const errors: string[] = []; provider.onError((code) => errors.push(code)); provider.start(); const recognition = (provider as any).recognition as MockRecognition; recognition.onerror?.({ error: 'no-speech' }); expect(provider.listening).toBe(true); recognition.onerror?.({ error: 'not-allowed' }); expect(provider.listening).toBe(false); expect(errors).toEqual(['no-speech', 'not-allowed']) })
})
