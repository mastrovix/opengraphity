/** Anomalia CMDB (GET_ANOMALIES) — unica definizione (prima 3 copie in pages/anomaly). */
export interface Anomaly {
  id:               string
  ruleKey:          string
  title:            string
  severity:         string
  status:           string
  entityId:         string
  entityType:       string
  entitySubtype:    string
  entityName:       string
  description:      string
  /** Parametri della frase (null su un'anomalia storica non più riscansionata). */
  descriptionParams: Array<{ key: string; value: string }> | null
  detectedAt:       string
  resolvedAt:       string | null
  resolutionStatus: string | null
  resolutionNote:   string | null
  resolvedBy:       string | null
  /** G-ANO-8: il nome di chi l'ha risolta (l'id da solo non si mostra). */
  resolvedByName:   string | null
  /** Perché lo scan l'ha chiusa: `not_detected` o `rule_disabled`. */
  resolvedReason?:  string | null
}

export interface AnomalyStats {
  total:         number
  open:          number
  critical:      number
  high:          number
  medium:        number
  low:           number
  falsePositive: number
  acceptedRisk:  number
}

export interface AnomalyScanStatus {
  lastScanAt: string | null
  totalScans: number
}
