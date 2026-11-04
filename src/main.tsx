import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { scheduleWasmPreload } from './audio/wasm/flag'
import { App } from './App'
import './styles.css'
import './ui/remoteFixes.css'
import './ui/arrangeSpace.css'
import './ui/premium.css'
import './ui/pluginStage.css'
import './ui/buttonTiers.css'

scheduleWasmPreload()

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
