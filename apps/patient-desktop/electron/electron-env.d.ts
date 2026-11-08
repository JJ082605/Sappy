/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, exposed in `preload.ts`
interface Window {
  companion: {
    /** Chat window: tell the overlay what the assistant is doing. */
    setMood(mood: CompanionMood): void
    /** Overlay: current mood (in case it changed before the overlay loaded). */
    getMood(): Promise<CompanionMood>
    /** Overlay: called whenever the mood changes. Returns an unsubscribe function. */
    onMood(cb: (mood: CompanionMood) => void): () => void
  }
  patient: {
    /** Which patient this device is assigned to (PATIENT_ID), or why it isn't. */
    assignment(): Promise<{ patientId: string; warning?: string } | { patientId: null; error: string }>
  }
  ai: {
    /** Send the conversation; returns the assistant's reply and any actions it took (item requests, nurse calls, emergencies). */
    chat(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<{ reply: string; actions: AiAction[] }>
  }
  tts: {
    /** Start speaking `text`. Resolves with an id used to match audio chunks. */
    speak(text: string): Promise<number>
    /** Stop generating audio for an utterance. */
    cancel(id: number): Promise<void>
    /** Called once per sentence of generated audio. Returns an unsubscribe function. */
    onChunk(cb: (chunk: { id: number; samples: Float32Array; sampleRate: number }) => void): () => void
    /** Called when an utterance has finished generating. Returns an unsubscribe function. */
    onDone(cb: (done: { id: number }) => void): () => void
  }
  voice: {
    /** Start receiving voice events; resolves with whether the models are loaded yet and the wake phrase. */
    connect(): Promise<{ status: 'loading' | 'ready' | 'error'; wakePhrase: string }>
    /** Ask for microphone permission (macOS shows a prompt the first time). */
    requestMicAccess(): Promise<boolean>
    /** Send 80 ms (1280 samples) of 16 kHz mono audio in [-1, 1]. */
    pushFrame(samples: Float32Array): void
    /** Start recording now (mic button). */
    start(): void
    /** Stop recording and transcribe. */
    stop(): void
    /** Discard the current recording. */
    cancel(): void
    /** Listen for the wake word. */
    setWakeEnabled(enabled: boolean): void
    /** Ignore the wake word, e.g. while the app is speaking. */
    setPaused(paused: boolean): void
    onEvent(cb: (event: VoiceEvent) => void): () => void
  }
}

type CompanionMood = 'idle' | 'listening' | 'thinking' | 'speaking'

type AiAction = {
  id: string
  type: 'item_request' | 'nurse_call' | 'emergency'
  priority: 'routine' | 'soon' | 'urgent' | 'emergency'
  summary: string
  /** False if it didn't reach the nurses' station (the reply then sends the patient to the call button). */
  delivered: boolean
}

type VoiceEvent =
  | { type: 'ready' }
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'state'; state: 'idle' | 'recording' | 'transcribing' }
  | { type: 'wake'; score: number }
  | { type: 'transcript'; text: string }
  | { type: 'no-speech' }

