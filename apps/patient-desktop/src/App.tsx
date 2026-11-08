import { useEffect, useState } from 'react'
import './App.css'
import { useSpeech } from './useSpeech'
import { playChime, useVoiceInput } from './useVoiceInput'
import type { CompanionMood } from './Companion'

type Msg = { role: 'user' | 'assistant'; content: string; actions?: AiAction[] }

// Short line shown under the assistant's reply for each action it took. Confirmed only if it
// reached the nurses' station; otherwise it points to the call button, like the spoken reply.
const ACTION_LABEL: Record<AiAction['type'], (summary: string) => string> = {
  item_request: (s) => `✓ Requested: ${s}`,
  nurse_call: (s) => `✓ Nurse notified: ${s}`,
  emergency: () => '🚨 Emergency alert sent to staff',
}
const NOT_SENT_LABEL: Record<AiAction['type'], (summary: string) => string> = {
  item_request: (s) => `⚠️ Not sent: ${s}. Please use your call button.`,
  nurse_call: (s) => `⚠️ Nurse not reached: ${s}. Please use your call button.`,
  emergency: () => '⚠️ Emergency alert NOT sent. Press your call button now.',
}

function App() {
  const [count, setCount] = useState(0)
  const [input, setInput] = useState<string>('')
  const [messages, setMessages] = useState<Msg[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [assignment, setAssignment] = useState<Awaited<ReturnType<typeof window.patient.assignment>> | null>(null)
  useEffect(() => {
    void window.patient.assignment().then(setAssignment)
  }, [])
  const [voiceOn, setVoiceOn] = useState(true)
  const { speak, stop, speaking } = useSpeech()
  const voice = useVoiceInput({
    onTranscript: (text) => void send(text),
    onWake: () => {
      stop()
      playChime()
    },
  })

  // What the companion character is doing.
  const mood: CompanionMood =
    voice.status === 'recording' ? 'listening'
    : loading || voice.status === 'transcribing' ? 'thinking'
    : speaking ? 'speaking'
    : 'idle'

  // The companion overlay (its own window in the screen corner) follows this.
  useEffect(() => window.companion.setMood(mood), [mood])

  // Don't listen for the wake word while the app is thinking or talking (it could hear itself).
  const { setPaused } = voice
  useEffect(() => setPaused(speaking || loading), [speaking, loading, setPaused])

  // `spoken` is text from speech-to-text; otherwise send what's typed in the box.
  async function send(spoken?: string) {
    const text = (spoken ?? input).trim()
    if (!text || loading) return
    stop() // don't keep reading the previous reply over the new one
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    if (spoken === undefined) setInput('')
    setLoading(true)
    let reply: string
    let actions: AiAction[] = []
    try {
      // Only role + content go to the model; action chips are just for display.
      ;({ reply, actions } = await window.ai.chat(next.map(({ role, content }) => ({ role, content }))))
    } catch (err) {
      console.error('AI chat failed:', err)
      reply = "Sorry, I can't respond right now. Please press the call button if you need a nurse."
    }
    setMessages([...next, { role: 'assistant', content: reply, actions }])
    setLoading(false)
    if (voiceOn) void speak(reply)
  }
  return (
    <>
      <h1>Vite + React</h1>
      {assignment && (
        <p>
          <small>
            {assignment.patientId === null
              ? `⚠️ No patient assigned: ${assignment.error}`
              : `Patient ${assignment.patientId.slice(0, 8)}${assignment.warning ? ` ⚠️ ${assignment.warning}` : ''}`}
          </small>
        </p>
      )}
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
        {messages.map((m, i) => (
          <div key={i}>
            <p>
              <b>{m.role === 'user' ? 'You' : 'Assistant'}:</b> {m.content}
            </p>
            {m.actions?.map((a) => (
              <p key={a.id}>
                <small>{(a.delivered ? ACTION_LABEL : NOT_SENT_LABEL)[a.type](a.summary)}</small>
              </p>
            ))}
          </div>
        ))}
        {loading && <p>Thinking…</p>}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void send()}
          placeholder="Talk to AI..." 
          disabled={loading}
        />
        <div>
          <label>
            <input
              type="checkbox"
              checked={voiceOn}
              onChange={(e) => {
                setVoiceOn(e.target.checked)
                if (!e.target.checked) stop()
              }}
            />{' '}
            Read replies aloud
          </label>
          {speaking && <button onClick={stop}>Stop speaking</button>}
        </div>
        <div>
          <button
            onClick={() => {
              stop()
              void voice.toggleRecording()
            }}
            disabled={loading || (voice.status !== 'idle' && voice.status !== 'recording')}
          >
            {voice.status === 'recording' ? '⏹ Done talking' : '🎤 Talk'}
          </button>{' '}
          <label>
            <input
              type="checkbox"
              checked={voice.wakeEnabled}
              disabled={voice.status === 'loading' || voice.status === 'error'}
              onChange={(e) => void voice.setWakeEnabled(e.target.checked)}
            />{' '}
            Say “{voice.wakePhrase || '…'}” to talk
          </label>
          <p>
            {voice.status === 'loading' && 'Loading voice models…'}
            {voice.status === 'recording' && 'Listening…'}
            {voice.status === 'transcribing' && 'Understanding…'}
            {voice.status === 'error' && 'Voice input is unavailable.'}
            {voice.micError}
          </p>
        </div>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </>
  )
}

export default App
