/**
 * `EMAIL_SEND_DISABLED` — «questa installazione non manda posta».
 *
 * Nasce da un buco operativo vero (18 set 2026): su uno stack di prova
 * l'unico modo di fermare le e-mail era spegnere a mano ogni regola di
 * notifica di ogni tenant, e un tenant creato il giorno dopo ricominciava
 * (il provisioning semina `digest.daily` attiva). Togliere la chiave non era
 * un modo: in produzione l'API si rifiuta di avviarsi senza.
 *
 * Quello che si pinna qui è soprattutto il RIFIUTO di indovinare: un valore
 * che non è né vero né falso non diventa «manda comunque». Chi scrive
 * `EMAIL_SEND_DISABLED=ture` crede di aver spento la posta, e un ripiego
 * silenzioso gliela farebbe partire.
 */
import { describe, it, expect } from 'vitest'
import { leggiInterruttore } from '../email.js'

describe('leggiInterruttore', () => {
  it('assente o vuoto = acceso (si manda), che è il comportamento di sempre', () => {
    expect(leggiInterruttore(undefined)).toBe(false)
    expect(leggiInterruttore('')).toBe(false)
    expect(leggiInterruttore('   ')).toBe(false)
  })

  it('le forme del «sì», anche scritte come capita', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
      expect(leggiInterruttore(v), v).toBe(true)
    }
  })

  it('le forme del «no»', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(leggiInterruttore(v), v).toBe(false)
    }
  })

  it('un valore che non si capisce è un ERRORE, non un «manda comunque»', () => {
    for (const v of ['ture', 'si', 'maybe', '2', 'disabled']) {
      expect(() => leggiInterruttore(v), v).toThrow(/must be true or false/)
    }
  })

  it('l\'errore dice il valore trovato: senza, non si sa quale riga correggere', () => {
    expect(() => leggiInterruttore('ture')).toThrow(/"ture"/)
  })
})
