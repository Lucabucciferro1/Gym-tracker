import {
  CalendarRange,
  Dumbbell,
  Ellipsis,
  LayoutDashboard,
  Ruler,
  ShieldCheck,
  UsersRound,
  Utensils,
  type LucideIcon,
} from 'lucide-react'
import type { MobileNavigationDestination, UserRole } from './types.js'

export interface MobileNavigationDefinition {
  key: MobileNavigationDestination
  to: string
  label: string
  shortLabel: string
  description: string
  icon: LucideIcon
  adminOnly?: boolean
  tone: string
}

export const DEFAULT_MOBILE_NAVIGATION: MobileNavigationDestination[] = [
  'dashboard',
  'measurements',
  'lifts',
  'workout',
]

export const MOBILE_NAVIGATION_CATALOG: Record<MobileNavigationDestination, MobileNavigationDefinition> = {
  dashboard: {
    key: 'dashboard',
    to: '/',
    label: 'Dashboard',
    shortLabel: 'Dashboard',
    description: 'See your latest progress, records, and quick actions.',
    icon: LayoutDashboard,
    tone: 'dashboard',
  },
  measurements: {
    key: 'measurements',
    to: '/measurements',
    label: 'Measurements',
    shortLabel: 'Measure',
    description: 'Log body measurements and review their trends.',
    icon: Ruler,
    tone: 'measurements',
  },
  lifts: {
    key: 'lifts',
    to: '/lifts',
    label: 'Max lifts',
    shortLabel: 'Lifts',
    description: 'Record personal bests and strength progress.',
    icon: Dumbbell,
    tone: 'lifts',
  },
  workout: {
    key: 'workout',
    to: '/workout',
    label: 'Workout plan',
    shortLabel: 'Workout',
    description: 'Edit your training week, exercises, and rest days.',
    icon: CalendarRange,
    tone: 'workout',
  },
  meals: {
    key: 'meals',
    to: '/meals',
    label: 'Meal plan',
    shortLabel: 'Meals',
    description: 'Plan meals and optionally track calories and macros.',
    icon: Utensils,
    tone: 'meal',
  },
  sharing: {
    key: 'sharing',
    to: '/sharing',
    label: 'Sharing',
    shortLabel: 'Sharing',
    description: 'Choose which friends can see each part of your progress.',
    icon: UsersRound,
    tone: 'share',
  },
  admin: {
    key: 'admin',
    to: '/admin',
    label: 'Admin panel',
    shortLabel: 'Admin',
    description: 'Invite friends and manage account access.',
    icon: ShieldCheck,
    adminOnly: true,
    tone: 'admin',
  },
}

export const MOBILE_NAVIGATION_MORE = {
  to: '/more',
  label: 'More',
  shortLabel: 'More',
  icon: Ellipsis,
}

export function availableMobileNavigation(role: UserRole): MobileNavigationDefinition[] {
  return Object.values(MOBILE_NAVIGATION_CATALOG).filter(
    (destination) => !destination.adminOnly || role === 'admin',
  )
}

export function normalizeMobileNavigation(
  items: readonly MobileNavigationDestination[] | null | undefined,
  role: UserRole,
): MobileNavigationDestination[] {
  const eligible = availableMobileNavigation(role).map((destination) => destination.key)
  const eligibleSet = new Set(eligible)
  const normalized: MobileNavigationDestination[] = []

  for (const item of items ?? []) {
    if (eligibleSet.has(item) && !normalized.includes(item)) normalized.push(item)
  }
  for (const item of [...DEFAULT_MOBILE_NAVIGATION, ...eligible]) {
    if (normalized.length === 4) break
    if (eligibleSet.has(item) && !normalized.includes(item)) normalized.push(item)
  }
  return normalized.slice(0, 4)
}

export function navigationPathMatches(pathname: string, destinationPath: string): boolean {
  const normalizePath = (path: string) => path === '/' ? path : path.replace(/\/+$/, '')
  return normalizePath(pathname) === normalizePath(destinationPath)
}

export interface MobileNavigationOutletContext {
  mobileNavigationItems: MobileNavigationDestination[]
  mobileNavigationLoading: boolean
  mobileNavigationError: string
  saveMobileNavigation: (
    items: MobileNavigationDestination[],
  ) => Promise<MobileNavigationDestination[]>
  retryMobileNavigation: () => Promise<void>
}
