import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { maybeBootWasmDsp } from './audio/wasm/flag'
import { App } from './App'
import './styles.css'
import './ui/remoteFixes.css'
import './ui/arrangeSpace.css'
import './ui/premium.css'

maybeBootWasmDsp()

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js')
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
