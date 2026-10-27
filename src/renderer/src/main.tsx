import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CharacterApp } from './character/CharacterApp'
import { SettingsApp } from './settings/SettingsApp'
import './styles.css'

const route = window.location.hash.replace(/^#\/?/, '')
const [page, tab] = route.split('/')
document.documentElement.dataset.page = page || 'character'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{page === 'settings' ? <SettingsApp initialTab={tab} /> : <CharacterApp />}</StrictMode>
)
