/**
 * The drawing of each icon a dictionary value can have (G40): the list is the
 * product's (`VALUE_ICONS`), this is only how the web draws it — typed on
 * the list, so a name added there without a drawing here does not compile.
 */
import {
  AppWindow, Box, Briefcase, Building2, Calendar, Cloud, Code, Database, Globe, HelpCircle, Key, Laptop, Lock, Mail,
  Monitor, Network, Phone, Printer, Server, ShieldAlert, Tag, User, Users, Wifi, Wrench, type LucideIcon,
} from 'lucide-react'
import type { ValueIcon } from '@opengraphity/types'

export const VALUE_ICON_DRAWINGS: Readonly<Record<ValueIcon, LucideIcon>> = {
  monitor: Monitor, laptop: Laptop, server: Server, database: Database, cloud: Cloud, wifi: Wifi, network: Network,
  code: Code, app: AppWindow, key: Key, lock: Lock, shield: ShieldAlert, user: User, users: Users, building: Building2,
  briefcase: Briefcase, phone: Phone, printer: Printer, mail: Mail, calendar: Calendar, wrench: Wrench, box: Box,
  globe: Globe, help: HelpCircle, tag: Tag,
}
