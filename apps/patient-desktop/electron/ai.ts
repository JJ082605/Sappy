import { ipcMain } from 'electron'
import aiConfig from '../ai.config.json'
import { dispatchAction, type PatientAction } from './actions'
import { runAgent, type ChatMessage } from './agent'
import { getPatientAssignment } from './patient'

const MAX_MESSAGES = 20
const MAX_CHARS = 8_000

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  let recent = messages.slice(-MAX_MESSAGES)
  while (recent.length > 1 && recent.reduce((sum, m) => sum + m.content.length, 0) > MAX_CHARS) {
    recent = recent.slice(1)
  }
  while (recent.length > 1 && recent[0].role === 'assistant') recent = recent.slice(1)
  return recent
}

// Only accept well-formed user/assistant messages from the renderer,
// so the page can't inject its own system prompt.
function sanitize(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) throw new Error('messages must be an array')
  return messages.map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      throw new Error('invalid message')
    }
    return { role: m.role, content: m.content }
  })
}

/** What the page gets back: the spoken reply plus a short summary of any actions taken, and
 *  whether each one reached the nurses' station. */
export type ChatResponse = {
  reply: string
  actions: { id: string; type: PatientAction['type']; priority: PatientAction['priority']; summary: string; delivered: boolean }[]
}

export function registerAiHandlers() {
  ipcMain.handle('ai:chat', async (_event, messages: unknown): Promise<ChatResponse> => {
    const { reply, actions } = await runAgent(trimHistory(sanitize(messages)), {
      ollamaHost: aiConfig.ollamaHost,
      model: aiConfig.model,
      patientId: getPatientAssignment().patientId,
      onAction: dispatchAction,
    })
    // `label` is a fixed, non-free-text label (e.g. "water", "help to the bathroom").
    return {
      reply,
      actions: actions.map(({ id, type, priority, label, delivery }) => ({
        id, type, priority, summary: label, delivered: delivery === 'sent',
      })),
    }
  })

  // The page shows which patient this device is assigned to (or why it isn't).
  ipcMain.handle('patient:assignment', () => getPatientAssignment())
}
