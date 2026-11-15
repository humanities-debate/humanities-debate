import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { DesktopStatus } from './components/DesktopStatus.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopStatus />
    <App />
  </StrictMode>,
)
