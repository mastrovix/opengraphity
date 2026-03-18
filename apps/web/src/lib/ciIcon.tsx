import {
  Box, Database, Server, Shield,
  HardDrive, Cloud, Globe, Cpu, Network,
  Monitor, Lock,
} from 'lucide-react'

const iconMap: Record<string, React.ComponentType<{ size?: number; color?: string; style?: React.CSSProperties }>> = {
  box:          Box,
  database:     Database,
  server:       Server,
  shield:       Shield,
  'hard-drive': HardDrive,
  cloud:        Cloud,
  globe:        Globe,
  cpu:          Cpu,
  network:      Network,
  monitor:      Monitor,
  lock:         Lock,
}

export function CIIcon({
  icon,
  size = 20,
  color,
  style,
}: {
  icon: string
  size?: number
  color?: string
  style?: React.CSSProperties
}) {
  const Icon = iconMap[icon] ?? Box
  return <Icon size={size} color={color} style={style} />
}
