export type UserRole = 'admin' | 'user'

export type MobileNavigationDestination =
  | 'dashboard'
  | 'measurements'
  | 'lifts'
  | 'workout'
  | 'meals'
  | 'sharing'
  | 'admin'

export interface MobileNavigationPreference {
  items: MobileNavigationDestination[]
}

export interface User {
  id: number
  username: string
  role: UserRole
  active?: boolean
  isActive?: boolean
  createdAt: string
  updatedAt?: string
  lastLoginAt?: string | null
  bodyPartCount?: number
  measurementCount?: number
  exerciseCount?: number
  liftCount?: number
  requiresPasswordSetup?: boolean
}

export interface AuthStatus {
  setupRequired: boolean
  authenticated: boolean
  user: User | null
}

export interface BodyPart {
  id: number
  name: string
  unit: string
  color: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  recordCount: number
  latestValue: number | null
  latestRecordedAt: string | null
}

export interface Measurement {
  id: number
  bodyPartId: number
  value: number
  recordedAt: string
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface Exercise {
  id: number
  name: string
  category: string
  unit: string
  color: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  recordCount: number
  personalBest: number | null
  latestWeight: number | null
  latestReps: number | null
  latestRecordedAt: string | null
}

export interface Lift {
  id: number
  exerciseId: number
  weight: number
  reps: number
  recordedAt: string
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminOverview {
  users: {
    total: number
    active: number
    pending: number
    disabled: number
    admins: number
  }
  records: {
    bodyParts: number
    measurements: number
    exercises: number
    lifts: number
  }
  activeSessions: number
  recentAudit: AuditEvent[]
}

export interface AuditEvent {
  id: number
  action: string
  actorUsername?: string | null
  actorUserId?: number | null
  targetType?: string | null
  targetId?: string | null
  metadata?: Record<string, unknown> | null
  ipAddress?: string | null
  createdAt: string
}

export interface WorkoutExercise {
  id?: number
  name: string
  sets: number
  reps: string
  notes: string | null
}

export interface WorkoutDay {
  dayOfWeek: number
  name: string
  isRest: boolean
  notes: string | null
  exercises: WorkoutExercise[]
}

export interface WorkoutPlan {
  days: WorkoutDay[]
}

export interface MealPlanSettings {
  showCalories: boolean
  showMacros: boolean
  calorieTarget: number | null
  proteinTarget: number | null
  carbsTarget: number | null
  fatTarget: number | null
}

export interface Meal {
  id: number
  dayOfWeek: number
  name: string
  description: string | null
  calories: number | null
  protein: number | null
  carbs: number | null
  fat: number | null
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface MealPlanDay {
  dayOfWeek: number
  meals: Meal[]
  totals: {
    calories: number
    protein: number
    carbs: number
    fat: number
  }
}

export interface MealPlan {
  settings: MealPlanSettings
  days: MealPlanDay[]
}

export type BmrFormulaSex = 'female' | 'male'

export type BmrWeightUnit = 'kg' | 'lb' | 'st'

export type BmrWeightSource = 'manual' | 'measurement'

interface BmrProfileInputBase {
  age: number
  sex: BmrFormulaSex
  heightFeet: number
  heightInches: number
}

export type BmrProfileInput = BmrProfileInputBase & (
  | {
      weightSource: 'manual'
      weightValue: number
      weightUnit: BmrWeightUnit
    }
  | {
      weightSource: 'measurement'
      bodyPartId: number
      measurementId: number
    }
)

export interface BmrProfile extends BmrProfileInputBase {
  weightSource: BmrWeightSource
  weightValue: number
  weightUnit: BmrWeightUnit
  bodyPartId: number | null
  measurementId: number | null
  sourceName: string | null
  sourceRecordedAt: string | null
  estimatedBmr: number
  createdAt: string
  updatedAt: string
}

export interface ShareUser {
  id: number
  username: string
}

export interface SharePermissions {
  shareMeasurements: boolean
  shareLifts: boolean
  shareWorkout: boolean
  shareMeals: boolean
}

export interface ProgressShare extends SharePermissions {
  id: number
  owner: ShareUser
  viewer: ShareUser
  createdAt: string
  updatedAt: string
}

export interface SharingOverview {
  availableUsers: ShareUser[]
  outgoingShares: ProgressShare[]
  incomingShares: ProgressShare[]
}

export interface SharedMeasurementSeries {
  bodyPart: BodyPart
  records: Measurement[]
}

export interface SharedLiftSeries {
  exercise: Exercise
  records: Lift[]
}

export interface SharedProgress {
  owner: ShareUser
  permissions: SharePermissions
  measurements?: SharedMeasurementSeries[]
  lifts?: SharedLiftSeries[]
  workoutPlan?: WorkoutPlan
  mealPlan?: MealPlan
}

export type DateRange = '30d' | '90d' | '1y' | 'all'

export const CHART_COLORS = [
  '#4e7a5c',
  '#5377db',
  '#c07a3f',
  '#8b68bc',
  '#2f8b88',
  '#bd5f6d',
]
