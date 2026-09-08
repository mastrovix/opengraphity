import { randomUUID } from 'crypto'

export interface InAppNotification {
  id: string
  type: string
  title: string
  message: string
  severity?: 'info' | 'warning' | 'error' | 'success'
  entity_id?: string
  entity_type?: string
  timestamp: string
  read: boolean
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

  sendToUser(tenantId: string, userId: string, event: InAppNotification): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    let sent = 0
    for (const client of this.clients.values()) {
      if (client.tenantId === tenantId && client.userId === userId) {
        if (!this.safeWrite(client, payload)) continue
        sent++
      }
    }
    if (sent > 0) {
      console.log(`[sse] Sent to user ${userId} (${sent} connection/s): ${event.type}`)
    }
  }

  sendToTenant(tenantId: string, event: InAppNotification): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`
    let sent = 0
    for (const client of this.clients.values()) {
      if (client.tenantId === tenantId) {
        if (!this.safeWrite(client, payload)) continue
        sent++
      }
    }
    console.log(`[sse] Broadcast to tenant ${tenantId} (${sent} connection/s): ${event.type}`)
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
