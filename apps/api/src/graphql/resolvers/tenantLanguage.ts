/**
 * In che lingua si legge questo cliente — la porta dall'interfaccia.
 *
 * Era una costante nel codice (`LINGUA_PREDEFINITA = 'it'`), quindi cambiare la
 * lingua di un'installazione voleva dire ricompilarla: nessun admin poteva
 * farlo, e per i clienti non italiani metà delle etichette si leggeva in
 * italiano. Il motivo per cui sta qui, e non in un file di configurazione del
 * server, è che è una decisione del CLIENTE e si prende dove il cliente ha già
 * tutte le altre: nell'interfaccia, senza script e senza codice.
 */
import type { GraphQLContext } from '../../context.js'
import { requireRole } from '../../lib/requireRole.js'
import { audit } from '../../lib/audit.js'
import { LINGUE } from '../../lib/enumValueLabels.js'
import { tenantDefaultLanguage, setTenantDefaultLanguage, LINGUA_DI_ULTIMA_ISTANZA } from '../../lib/tenantLanguage.js'
import { invalidateSchema } from '../../lib/schemaInvalidator.js'

async function impostazioni(tenantId: string) {
  return {
    available:       [...LINGUE],
    defaultLanguage: await tenantDefaultLanguage(tenantId),
    fallback:        LINGUA_DI_ULTIMA_ISTANZA,
  }
}

/**
 * Aperta a ogni ruolo: il client la chiede all'avvio per sapere in che lingua
 * mostrarsi a chi non ha ancora scelto. Non dice niente di riservato — quali
 * lingue esistono e quale è la predefinita dell'azienda.
 */
async function tenantLanguageSettings(_: unknown, __: unknown, ctx: GraphQLContext) {
  return impostazioni(ctx.tenantId)
}

async function setTenantDefaultLanguageMutation(
  _: unknown, args: { language: string }, ctx: GraphQLContext,
) {
  requireRole(ctx, 'admin')
  const lingua = await setTenantDefaultLanguage(ctx.tenantId, args.language)
  /*
    LA LEVA DEL METAMODELLO. La lingua predefinita è il ripiego con cui si
    risolvono le ETICHETTE dei vocabolari (`labelFor`), e quelle arrivano al
    client dentro lo schema per tenant: senza invalidare, il Dizionario e ogni
    tendina continuerebbero a leggersi nella lingua di prima finché la cache
    non scade da sé.
  */
  invalidateSchema(ctx.tenantId)
  void audit(ctx, 'tenant.default_language.updated', 'Tenant', ctx.tenantId, { language: lingua })
  return impostazioni(ctx.tenantId)
}

export const tenantLanguageResolvers = {
  Query:    { tenantLanguageSettings },
  Mutation: { setTenantDefaultLanguage: setTenantDefaultLanguageMutation },
}
