import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts are self-hosted (bundled from npm): no third-party request leaves the ward workstation.
import '@fontsource-variable/atkinson-hyperlegible-next'
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import './index.css'

const root = createRoot(document.getElementById('root')!)

// App is loaded dynamically so a missing Supabase config shows setup help instead of a blank page
// (lib/supabase.ts throws on import when VITE_SUPABASE_* aren't set).
import('./App.tsx')
  .then(({ default: App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
  .catch((e: unknown) =>
    root.render(
      <main className="signin">
        <div className="signin__card">
          <h1>Nurse station isn’t configured</h1>
          <p className="signin__note">{e instanceof Error ? e.message : String(e)}</p>
        </div>
      </main>,
    ),
  )
