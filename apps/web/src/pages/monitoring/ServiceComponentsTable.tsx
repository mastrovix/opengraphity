/**
 * Tabella dei componenti della mappa. Per tutti è in sola lettura; per gli
 * amministratori (ondata 2) ogni riga si modifica sul posto: «pesa» (sempre /
 * mai / ponderato), peso 1–10 (disabilitato con «mai»: un componente che non
 * pesa non ha peso) e la spunta «critico». Livello, ruolo e «via» restano
 * della mappa: si cambiano da «Aggiorna mappa».
 *
 * Le modifiche stanno in uno stato locale; in cima alla tabella una barra
 * annuncia quanti componenti sono cambiati (`role="status"`) con Salva e
 * Ripristina. Si mandano SOLO i nodi cambiati, con `expectedVersion` = la
 * versione letta: se un altro amministratore ha salvato nel frattempo l'API
 * rifiuta e la riga `role="alert"` invita a ricaricare.
 *
 * Il polling del dettaglio (15 s) e la sincronizzazione automatica cambiano
 * l'insieme dei componenti in continuazione: il riallineamento è PER RIGA
 * (revisione 2, C-2) — le righe il cui valore salvato non è cambiato tengono
 * la modifica in corso, spariscono solo le righe sparite, e una modifica
 * sovrascritta da un valore salvato diverso è detta in una riga `role="alert"`,
 * mai scartata in silenzio. L'errore di salvataggio lo toglie solo l'utente.
 *
 * Sempre per l'admin, ogni riga ha «Escludi dalla mappa» (C-1): senza di essa
 * un componente entrato da solo con la mappa viva non era più escludibile da
 * nessuna parte.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Ban, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/Button'
import { Input, Select } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { APPLY_SERVICE_MAP_PROPOSAL, UPDATE_SERVICE_MAP_NODES } from '@/graphql/mutations'
import { ciPath } from '@/lib/ciPath'
import { colors, palette } from '@/lib/tokens'
import { TINT_WARNING } from '@/lib/eventPalette'
import { ServiceImpactPreviewLine } from './ServiceImpactPreviewLine'
import { NodeHealthBadge, excludedReasonLabel, propagationLabel, roleLabel } from './servicesShared'
import {
  NODE_PROPAGATIONS, NODE_WEIGHT_MAX, NODE_WEIGHT_MIN,
  type NodePropagation, type ServiceMapDetail, type ServiceMapNode, type ServiceMapNodeInput,
} from '@/types/services'

/** Le sole impostazioni modificabili di un componente. */
interface NodeDraft { propagate: string; weight: number; critical: boolean }
type Drafts = Record<string, NodeDraft>

const linkStyle = { color: colors.brand, textDecoration: 'none', fontWeight: 500 } as const
const TH: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: colors.slateLight, fontWeight: 500, fontSize: 'var(--font-size-label)', textTransform: 'uppercase', borderBottom: `1px solid ${colors.border}`, whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '6px 8px', color: colors.slateDark, borderBottom: '1px solid var(--color-border-light)', fontSize: 'var(--font-size-body)', verticalAlign: 'middle' }

const COLUMNS = ['name', 'type', 'level', 'role', 'propagate', 'weight', 'critical', 'health'] as const

const draftOf = (n: ServiceMapNode): NodeDraft => ({ propagate: n.propagate, weight: n.weight, critical: n.critical })

/** Due impostazioni sono «le stesse» se hanno gli stessi valori (le chiavi sono sempre nello stesso ordine). */
const same = (a: NodeDraft | undefined, b: NodeDraft | undefined) => JSON.stringify(a) === JSON.stringify(b)

const sortNodes = (nodes: readonly ServiceMapNode[]) => [...nodes].sort((a, b) => a.level - b.level || a.ci.name.localeCompare(b.ci.name))

/** Un peso fuori scala (o non intero) blocca il salvataggio: l'API lo rifiuterebbe comunque. */
const weightInvalid = (d: NodeDraft) => !Number.isInteger(d.weight) || d.weight < NODE_WEIGHT_MIN || d.weight > NODE_WEIGHT_MAX

interface Props {
  map: ServiceMapDetail
  /** Solo gli amministratori vedono i controlli di riga e la barra. */
  canEdit: boolean
  ciTypeLabel: (type: string) => string
  /** Rilegge la mappa dopo un conflitto di versione. */
  onReload: () => void
}

export function ServiceComponentsTable({ map, canEdit, ciTypeLabel, onReload }: Props) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [update, { loading: saving }] = useMutation<{ updateServiceMapNodes: ServiceMapDetail }>(UPDATE_SERVICE_MAP_NODES)
  const [excludeCI, { loading: excluding }] = useMutation<{ applyServiceMapProposal: ServiceMapDetail }>(APPLY_SERVICE_MAP_PROPOSAL)
  /** Messaggio già composto: il salvataggio e l'esclusione falliscono per motivi diversi. */
  const [actionError, setActionError] = useState<string | null>(null)
  /** Id dei componenti la cui modifica in corso è stata sovrascritta da un valore salvato diverso. */
  const [overwritten, setOverwritten] = useState<string[]>([])

  const nodes = useMemo(() => sortNodes(map.nodes), [map.nodes])
  const nameOf = (ciId: string) => nodes.find((n) => n.ci.id === ciId)?.ci.name ?? ciId

  // Chiave stabile delle impostazioni salvate: cambia solo quando cambia un
  // valore salvato (o l'insieme delle righe), non a ogni oggetto nuovo del polling.
  const baselineKey = JSON.stringify(Object.fromEntries(nodes.map((n) => [n.ci.id, draftOf(n)])))
  const baseline = useMemo(() => JSON.parse(baselineKey) as Drafts, [baselineKey])
  const [drafts, setDrafts] = useState<Drafts>(baseline)
  const previousBaseline = useRef<Drafts>(baseline)

  /**
   * Riallineamento PER RIGA: le righe il cui valore salvato non è cambiato
   * tengono la modifica in corso; le righe sparite se ne vanno; una modifica
   * sovrascritta da un valore salvato DIVERSO viene detta (non è «scartata in
   * silenzio»). Il proprio salvataggio non conta come sovrascrittura: il
   * valore che torna è quello appena mandato.
   */
  useEffect(() => {
    const previous = previousBaseline.current
    if (previous === baseline) return
    previousBaseline.current = baseline
    const lost: string[] = []
    const next: Drafts = {}
    for (const [ciId, saved] of Object.entries(baseline)) {
      const before = previous[ciId]
      const draft = drafts[ciId]
      if (same(before, saved) && draft !== undefined) { next[ciId] = draft; continue }
      if (draft !== undefined && before !== undefined && !same(draft, before) && !same(draft, saved)) lost.push(ciId)
      next[ciId] = saved
    }
    setDrafts(next)
    if (lost.length > 0) setOverwritten((o) => [...new Set([...o, ...lost])])
  }, [baseline, drafts])

  /** Ogni azione dell'utente sulle righe chiude gli avvisi precedenti: li toglie lui, mai il polling. */
  const clearNotices = () => { setActionError(null); setOverwritten([]) }

  const setDraft = (ciId: string, patch: Partial<NodeDraft>) => {
    clearNotices()
    setDrafts((d) => {
      const current = d[ciId]
      if (!current) return d
      return { ...d, [ciId]: { ...current, ...patch } }
    })
  }

  /** Solo i componenti davvero cambiati: sono anche i soli che si mandano all'API. */
  const changed: ServiceMapNodeInput[] = nodes
    .filter((n) => {
      const d = drafts[n.ci.id]
      return d !== undefined && JSON.stringify(d) !== JSON.stringify(baseline[n.ci.id])
    })
    .map((n) => {
      const d = drafts[n.ci.id]!
      return { ciId: n.ci.id, propagate: d.propagate as NodePropagation, weight: d.weight, critical: d.critical }
    })

  const invalid = changed.some((c) => weightInvalid({ propagate: c.propagate, weight: c.weight, critical: c.critical }))
  const busy = saving || excluding

  async function save() {
    if (changed.length === 0 || invalid) return
    clearNotices()
    try {
      const res = await update({ variables: { id: map.id, expectedVersion: map.version, nodes: changed } })
      if (!res.data?.updateServiceMapNodes) throw new Error(t('monitoring.services.detail.noResult', { operation: 'updateServiceMapNodes' }))
    } catch (e) {
      setActionError(t('monitoring.services.componentsEdit.saveFailed', { error: errorMessage(e) }))
    }
  }

  /**
   * «Escludi dalla mappa» (C-1): il componente esce dalla mappa e non verrà
   * più riproposto dalla sincronizzazione. È l'unica strada per un componente
   * che la mappa viva ha già accettato — nel dialogo del diff non compare né
   * fra i nuovi né fra gli spariti.
   */
  async function onExclude(n: ServiceMapNode) {
    const ok = await confirm({
      title: t('monitoring.services.componentsEdit.excludeTitle', { name: n.ci.name }),
      body: t('monitoring.services.componentsEdit.excludeBody'),
      confirmLabel: t('monitoring.services.componentsEdit.excludeConfirm'),
      danger: true,
    })
    if (!ok) return
    clearNotices()
    try {
      const res = await excludeCI({ variables: { id: map.id, expectedVersion: map.version, add: [], exclude: [n.ci.id], remove: [] } })
      if (!res.data?.applyServiceMapProposal) throw new Error(t('monitoring.services.detail.noResult', { operation: 'applyServiceMapProposal' }))
      toast.success(t('toast.services.componentExcluded', { name: n.ci.name }))
    } catch (e) {
      setActionError(t('monitoring.services.componentsEdit.excludeFailed', { name: n.ci.name, error: errorMessage(e) }))
    }
  }

  if (nodes.length === 0) {
    return <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('monitoring.services.detail.componentsEmpty')}</p>
  }

  return (
    <div>
      {canEdit && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <span role="status" data-testid="components-dirty" style={{ marginRight: 'auto', fontSize: 'var(--font-size-body)', color: invalid ? colors.danger : changed.length > 0 ? palette.warning.text : colors.slateLight }}>
            {invalid
              ? t('monitoring.services.componentsEdit.blocked', { min: NODE_WEIGHT_MIN, max: NODE_WEIGHT_MAX })
              : changed.length > 0
                ? t('monitoring.services.componentsEdit.changed', { count: changed.length })
                : t('monitoring.services.componentsEdit.noChanges')}
          </span>
          <Button variant="secondary" size="xs" disabled={busy || changed.length === 0} icon={<RotateCcw size={13} aria-hidden="true" />} onClick={() => { clearNotices(); setDrafts(baseline) }}>
            {t('common.reset')}
          </Button>
          <Button size="xs" disabled={busy || invalid || changed.length === 0} icon={saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : undefined} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      )}

      {actionError && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.text, fontSize: 'var(--font-size-body)' }}>
          <span>{actionError}</span>
          <Button variant="secondary" size="xs" onClick={onReload}>{t('monitoring.services.rulesEdit.reload')}</Button>
        </div>
      )}

      {/* Una modifica in corso sovrascritta da un altro amministratore (o dalla sincronizzazione) si dice: mai un silenzio. */}
      {overwritten.length > 0 && (
        <div role="alert" data-testid="components-overwritten" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10, padding: '8px 12px', borderRadius: 8, background: palette.warning.bg, border: `1px solid ${palette.warning.border}`, color: palette.warning.text, fontSize: 'var(--font-size-body)' }}>
          <span>{t('monitoring.services.componentsEdit.overwritten', { count: overwritten.length, names: overwritten.map(nameOf).join(', ') })}</span>
          <Button variant="secondary" size="xs" onClick={() => setOverwritten([])}>{t('common.close')}</Button>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table aria-label={t('monitoring.services.detail.components')} style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {COLUMNS.map((k) => <th key={k} scope="col" style={TH}>{t(`monitoring.services.columns.${k}`)}</th>)}
              {canEdit && <th scope="col" style={TH}>{t('monitoring.services.columns.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const d = drafts[n.ci.id] ?? draftOf(n)
              const badWeight = canEdit && weightInvalid(d)
              return (
                <tr key={n.ci.id} data-testid="component-row" data-ci-id={n.ci.id}>
                  <td style={TD}><Link to={ciPath(n.ci)} style={linkStyle}>{n.ci.name}</Link></td>
                  <td style={TD}>{ciTypeLabel(n.ci.type)}</td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{n.level}</td>
                  <td style={TD}>{roleLabel(t, n.role)}</td>
                  <td style={TD}>
                    {canEdit
                      ? (
                        <Select
                          aria-label={t('monitoring.services.componentsEdit.propagateLabel', { name: n.ci.name })}
                          value={d.propagate} disabled={busy} style={{ minWidth: 120 }}
                          onChange={(e) => setDraft(n.ci.id, { propagate: e.target.value })}
                        >
                          {/* Un valore salvato fuori vocabolario resta scelto: non lo si corregge di nascosto. */}
                          {(NODE_PROPAGATIONS as readonly string[]).includes(d.propagate) ? null : <option value={d.propagate}>{propagationLabel(t, d.propagate)}</option>}
                          {NODE_PROPAGATIONS.map((p) => <option key={p} value={p}>{propagationLabel(t, p)}</option>)}
                        </Select>
                      )
                      : propagationLabel(t, n.propagate)}
                    {/* R1: perché il componente non ha contato nell'ultima valutazione (le due manutenzioni sono distinte). */}
                    {n.excludedReason !== null && (
                      <div data-testid="excluded-reason" data-reason={n.excludedReason} style={{ marginTop: 3, fontSize: 'var(--font-size-label)', color: colors.slateLight }}>
                        {excludedReasonLabel(t, n.excludedReason)}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>
                    {canEdit
                      ? (
                        <Input
                          type="number" step={1} min={NODE_WEIGHT_MIN} max={NODE_WEIGHT_MAX} style={{ width: 72 }}
                          aria-label={t('monitoring.services.componentsEdit.weightLabel', { name: n.ci.name })}
                          aria-invalid={badWeight ? true : undefined}
                          value={Number.isNaN(d.weight) ? '' : String(d.weight)}
                          disabled={busy || d.propagate === 'never'}
                          title={d.propagate === 'never' ? t('monitoring.services.componentsEdit.weightDisabled') : undefined}
                          onChange={(e) => setDraft(n.ci.id, { weight: e.target.value.trim() === '' ? Number.NaN : Number(e.target.value) })}
                        />
                      )
                      : n.weight}
                  </td>
                  <td style={TD}>
                    {canEdit
                      ? (
                        <input
                          type="checkbox" checked={d.critical} disabled={busy}
                          aria-label={t('monitoring.services.componentsEdit.criticalLabel', { name: n.ci.name })}
                          onChange={(e) => setDraft(n.ci.id, { critical: e.target.checked })}
                        />
                      )
                      : n.critical
                        ? <Pill bg={TINT_WARNING.bg} color={TINT_WARNING.color} style={{ fontSize: 'var(--font-size-label)' }}>{t('monitoring.services.why.critical')}</Pill>
                        : <span style={{ color: colors.slateLight }}>{t('common.no')}</span>}
                  </td>
                  <td style={TD}>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <NodeHealthBadge health={n.health} />
                      {n.inMaintenance && <Pill bg={palette.purple.bg} color={palette.purple.text} style={{ fontSize: 'var(--font-size-label)' }}>{t('monitoring.services.health.maintenance')}</Pill>}
                    </span>
                  </td>
                  {canEdit && (
                    <td style={TD}>
                      <Button
                        variant="secondary" size="xs" disabled={busy}
                        icon={<Ban size={13} aria-hidden="true" />}
                        aria-label={t('monitoring.services.componentsEdit.excludeLabel', { name: n.ci.name })}
                        onClick={() => void onExclude(n)}
                      >
                        {t('monitoring.services.componentsEdit.exclude')}
                      </Button>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Anteprima con i componenti in corso di modifica: nessuna scrittura. */}
      {canEdit && !invalid && (
        <ServiceImpactPreviewLine mapId={map.id} nodes={changed.length > 0 ? changed : null} testId="components-preview" />
      )}
    </div>
  )
}
