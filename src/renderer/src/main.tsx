import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Tailwind entrypoint — must come before assets/main.css so our own
// layer rules (window chrome, header) sit on top of Tailwind preflight.
import './index.css'
import './assets/main.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
