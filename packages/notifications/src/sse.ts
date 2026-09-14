import { randomUUID } from 'crypto'
import type { NotificationSeverity } from '@opengraphity/types'

export interface InAppNotification {
  id: string
  type: string
  /** Chiave i18n del titolo (è quella che la regola di notifica configura). */
  title: string
  /**
   * Testo da mostrare quando `title` non è una chiave tradotta: per le
   * notifiche di passo è l'ETICHETTA del passo (B-16). Senza, il pannello
   * mostrava la chiave grezza — `notification.custom.step.title` — a chi
   * aveva aggiunto un passo suo.
   */
  title_fallback?: string
  message: string
  /**
   * Chiave i18n del messaggio e i suoi dati (revisione del 14 set 2026 · CO-2 /
   * F10): il pannello compone la frase nella lingua di chi legge. `message`
   * resta il testo per chi non ha la chiave (e-mail, integrazioni, client vecchi).
   */
  message_key?: string
  message_params?: Record<string, string>
  severity?: NotificationSeverity
  entity_id?: string
  entity_type?: string
  timestamp: string
  read: boolean
}

/**
 * UNA CONSEGNA IN-APP (revisione del 14 set 2026 · F10): a una persona
 * (`userId`) o a tutto il tenant (`userId: null`).
 */
export interface InAppDelivery {
  tenantId: string
  userId: string | null
  notification: InAppNotification
}

/**
 * Come una consegna sopravvive al processo e raggiunge le altre repliche: la si
 * salva (`persist`, così il pannello la ritrova al caricamento) e la si
 * pubblica su un canale condiviso (`publish`), da cui ogni processo che ha
 * client collegati la scrive con `writeLocal`. Lo registra il processo all'avvio
 * (apps/api/src/lib/inAppBus.ts); senza, la consegna resta locale.
 */
export interface InAppTransport {
  persist(delivery: InAppDelivery): Promise<void>
  publish(delivery: InAppDelivery): Promise<void>
}

export interface SseClient {
  id: string
  tenantId: string
  userId: string
  res: { write(data: string): void }
}

class SseManager {
  private readonly clients = new Map<string, SseClient>()

  connect(
    tenantId: string,
    userId: string,
    res: { write(data: string): void },
  ): string {
    const clientId = randomUUID()
    this.clients.set(clientId, { id: clientId, tenantId, userId, res })
    console.log(`[sse] Connected: clientId=${clientId} userId=${userId} tenantId=${tenantId}`)
    return clientId
  }

  disconnect(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    this.clients.delete(clientId)
    console.log(
      `[sse] Disconnected: clientId=${clientId} userId=${client.userId} tenantId=${client.tenantId}`,
    )
  }

  /** write() su una connessione morta lancia: il client viene rimosso e il broadcast prosegue. */
  private safeWrite(client: SseClient, payload: string): boolean {
    try {
      client.res.write(payload)
      return true
    } catch (err) {
      console.error(`[sse] write failed for client ${client.id} (tenant ${client.tenantId}) — removed: ${err instanceof Error ? err.message : String(err)}`)
      this.clients.delete(client.id)
      return false
    }
  }

  private transport: InAppTransport | null = null

  /** Registra (o toglie, con `null`) il trasporto delle consegne. */
  useTransport(transport: InAppTransport | null): void {
    this.transport = transport
  }

  /** Consegna una notifica a una persona. */
  sendToUser(tenantId: string, userId: string, event: InAppNotification): void {
    this.deliver({ tenantId, userId, notification: event })
  }

  /** Consegna una notifica a tutto il tenant. */
  sendToTenant(tenantId: string, event: InAppNotification): void {
    this.deliver({ tenantId, userId: null, notification: event })
  }

  private deliver(delivery: InAppDelivery): void {
    const transport = this.transport
    if (!transport) { this.writeLocal(delivery); return }
    void (async () => {
      try {
        await transport.persist(delivery)
      } catch (err) {
        console.error(`[sse] in-app notification ${delivery.notification.id} NOT persisted (tenant ${delivery.tenantId}): it will not survive a reload — ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        await transport.publish(delivery)
      } catch (err) {
        console.error(`[sse] in-app notification ${delivery.notification.id} not published (tenant ${delivery.tenantId}): only the clients of THIS process receive it now, the others at the next reload — ${err instanceof Error ? err.message : String(err)}`)
        this.writeLocal(delivery)
      }
    })()
  }

  /** Scrive la consegna ai client collegati a QUESTO processo. */
  writeLocal(delivery: InAppDelivery): void {
    const payload = `data: ${JSON.stringify(delivery.notification)}\n\n`
    let sent = 0
    for (const client of this.clients.values()) {
      if (client.tenantId !== delivery.tenantId) continue
      if (delivery.userId !== null && client.userId !== delivery.userId) continue
      if (!this.safeWrite(client, payload)) continue
      sent++
    }
    if (sent > 0 || delivery.userId === null) {
      console.log(`[sse] ${delivery.userId === null ? `Broadcast to tenant ${delivery.tenantId}` : `Sent to user ${delivery.userId}`} (${sent} connection/s): ${delivery.notification.type}`)
    }
  }

  getConnectedCount(tenantId?: string): number {
    if (!tenantId) return this.clients.size
    let count = 0
    for (const client of this.clients.values()) {
      if (client.tenantId === tenantId) count++
    }
    return count
  }
}

export const sseManager = new SseManager()
