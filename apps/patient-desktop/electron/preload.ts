import { ipcRenderer, contextBridge, type IpcRendererEvent } from 'electron'

// Only expose specific, narrow functions to the page — never the raw ipcRenderer.
// The companion overlay widget: the chat window sets the mood, the widget follows it.
contextBridge.exposeInMainWorld('companion', {
  setMood: (mood: string) => ipcRenderer.send('companion:set-mood', mood),
  getMood: () => ipcRenderer.invoke('companion:get-mood') as Promise<string>,
  onMood: (cb: (mood: string) => void) => listen('companion:mood', cb),
})

contextBridge.exposeInMainWorld('patient', {
  assignment: () =>
    ipcRenderer.invoke('patient:assignment') as Promise<
      { patientId: string; warning?: string } | { patientId: null; error: string }
    >,
})

contextBridge.exposeInMainWorld('ai', {
  chat: (messages: { role: string; content: string }[]) =>
    ipcRenderer.invoke('ai:chat', messages) as Promise<{
      reply: string
      actions: { id: string; type: string; priority: string; summary: string; delivered: boolean }[]
    }>,
})

type TtsChunk = { id: number; samples: Float32Array; sampleRate: number }

// Subscribe to a channel and return an unsubscribe function.
function listen<T>(channel: string, cb: (payload: T) => void) {
  const handler = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.off(channel, handler)
  }
}

contextBridge.exposeInMainWorld('tts', {
  speak: (text: string) => ipcRenderer.invoke('tts:speak', text) as Promise<number>,
  cancel: (id: number) => ipcRenderer.invoke('tts:cancel', id) as Promise<void>,
  onChunk: (cb: (chunk: TtsChunk) => void) => listen('tts:chunk', cb),
  onDone: (cb: (done: { id: number }) => void) => listen('tts:done', cb),
})

contextBridge.exposeInMainWorld('voice', {
  connect: () =>
    ipcRenderer.invoke('voice:connect') as Promise<{ status: 'loading' | 'ready' | 'error'; wakePhrase: string }>,
  requestMicAccess: () => ipcRenderer.invoke('voice:request-mic') as Promise<boolean>,
  pushFrame: (samples: Float32Array) => ipcRenderer.send('voice:frame', samples),
  start: () => ipcRenderer.send('voice:start'),
  stop: () => ipcRenderer.send('voice:stop'),
  cancel: () => ipcRenderer.send('voice:cancel'),
  setWakeEnabled: (enabled: boolean) => ipcRenderer.send('voice:wake-enabled', enabled),
  setPaused: (paused: boolean) => ipcRenderer.send('voice:paused', paused),
  onEvent: (cb: (event: unknown) => void) => listen('voice:event', cb),
})
