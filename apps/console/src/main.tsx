/**
 * L'AVVIO DELLA CONSOLE.
 *
 * Più severo di quello di web e portale, di proposito: qui non si riprova e non
 * si ripiega. Se Keycloak non risponde o la configurazione manca, si scrive
 * perché e si resta fermi — una console che si apre «in qualche modo» su una
 * configurazione sbagliata è peggio di una che non si apre.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initKeycloak, keycloak } from './keycloak'
import { startTokenRefreshLoop } from './tokenRefresh'
import { TenantsPage } from './TenantsPage'
import './index.css'

const root = document.getElementById('root')!

function fermati(messaggio: string): void {
  root.innerHTML = ''
  const box = document.createElement('div')
  box.className = 'wrap'
  // La pagina d'errore non ha l'intestazione fissa: senza questo margine il
  // titolo finirebbe sotto il bordo superiore della finestra.
  box.style.marginTop = '40px'
  const titolo = document.createElement('h1')
  titolo.textContent = 'The platform console cannot start'
  const p = document.createElement('div')
  p.className = 'errore'
  // `textContent` e non `innerHTML`: il messaggio può contenere testo che non
  // controlliamo, e una console che interpreta HTML è una console che si buca.
  p.textContent = messaggio
  box.append(titolo, p)
  root.append(box)
}

initKeycloak()
  .then((autenticato) => {
    if (!autenticato) {
      void keycloak.login()
      return
    }
    /*
     * Il token si tiene fresco per tutta la sessione: mancava, e la console
     * funzionava solo nei primi minuti dopo il login — poi «Unauthorized» a
     * ogni azione (`jwt expired` nei log dell'API).
     */
    startTokenRefreshLoop()

    createRoot(root).render(
      <StrictMode>
        <TenantsPage />
      </StrictMode>,
    )
  })
  .catch((err: unknown) => {
    fermati(err instanceof Error ? err.message : String(err))
  })
