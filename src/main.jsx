import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tauri-bridge.js' // Tauri 版补 window.cnc；Electron 下是空操作
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
