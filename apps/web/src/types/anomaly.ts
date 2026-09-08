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
  detectedAt:       string
  resolvedAt:       string | null
  resolutionStatus: string | null
  resolutionNote:   string | null
  resolvedBy:       string | null
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
