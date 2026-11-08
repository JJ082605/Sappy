// Visible confirmation for actions that change shared state ("I'm on it"), with Undo for a mis-tap.
import { useEffect } from 'react'

export interface ToastMessage {
  id: number
  text: string
  error?: boolean
  undo?: () => void
}

const SHOW_FOR_MS = 10_000

export function Toast({ toast, onClose }: { toast?: ToastMessage; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(onClose, SHOW_FOR_MS)
    return () => clearTimeout(id)
  }, [toast, onClose])

  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div key={toast.id} className={`toast ${toast.error ? 'toast--error' : ''}`}>
          <span>{toast.text}</span>
          {toast.undo && (
            <button className="toast__btn" onClick={toast.undo}>
              Undo
            </button>
          )}
          <button className="toast__btn toast__btn--close" aria-label="Dismiss" onClick={onClose}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
