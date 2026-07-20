import type {
  AdminOverview,
  AuditEvent,
  AuthStatus,
  BodyPart,
  Exercise,
  Lift,
  Measurement,
  Meal,
  MealPlan,
  MealPlanSettings,
  BmrProfile,
  BmrProfileInput,
  MobileNavigationDestination,
  MobileNavigationPreference,
  ProgressShare,
  SharedProgress,
  SharingOverview,
  User,
  WorkoutDay,
  WorkoutDayInput,
  WorkoutPlan,
} from './types'

interface ApiEnvelope<T> {
  data: T
}

interface ApiErrorPayload {
  error?: {
    code?: string
    message?: string
    details?: unknown
  }
  message?: string
}

export const AUTH_EXPIRED_EVENT = 'forge:auth-expired'

export class ApiError extends Error {
  status: number
  code?: string
  details?: unknown

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  })

  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json')
    ? ((await response.json()) as ApiEnvelope<T> & ApiErrorPayload)
    : null

  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
    }
    throw new ApiError(
      payload?.error?.message ?? payload?.message ?? 'Something went wrong. Please try again.',
      response.status,
      payload?.error?.code,
      payload?.error?.details,
    )
  }

  if (!payload || !('data' in payload)) {
    return undefined as T
  }

  return payload.data
}

const json = (body: unknown) => JSON.stringify(body)

export const api = {
  auth: {
    status: () => request<AuthStatus>('/api/auth/status'),
    me: () => request<{ user: User }>('/api/auth/me'),
    setup: (username: string, password: string) =>
      request<{ user: User }>('/api/auth/setup', {
        method: 'POST',
        body: json({ username, password }),
      }),
    login: (username: string, password: string) =>
      request<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: json({ username, password }),
      }),
    activate: (username: string, inviteCode: string, newPassword: string) =>
      request<{ user: User }>('/api/auth/activate', {
        method: 'POST',
        body: json({ username, inviteCode, newPassword }),
      }),
    logout: () =>
      request<{ success: boolean }>('/api/auth/logout', { method: 'POST' }),
    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ success: boolean }>('/api/auth/change-password', {
        method: 'POST',
        body: json({ currentPassword, newPassword }),
      }),
    updateProfile: (username: string) =>
      request<{ user: User }>('/api/auth/profile', {
        method: 'PATCH',
        body: json({ username }),
      }),
  },
  preferences: {
    getMobileNavigation: () =>
      request<MobileNavigationPreference>('/api/preferences/mobile-navigation'),
    updateMobileNavigation: (items: MobileNavigationDestination[]) =>
      request<MobileNavigationPreference>('/api/preferences/mobile-navigation', {
        method: 'PUT',
        body: json({ items }),
      }),
    resetMobileNavigation: () =>
      request<MobileNavigationPreference>('/api/preferences/mobile-navigation/reset', {
        method: 'POST',
      }),
  },
  bodyParts: {
    list: async () => (await request<{ bodyParts: BodyPart[] }>('/api/body-parts')).bodyParts,
    reorder: async (ids: number[]) => (
      await request<{ bodyParts: BodyPart[] }>('/api/body-parts/order', {
        method: 'PUT',
        body: json({ ids }),
      })
    ).bodyParts,
    create: (input: Pick<BodyPart, 'name' | 'unit' | 'color'>) =>
      request<{ bodyPart: BodyPart }>('/api/body-parts', { method: 'POST', body: json(input) })
        .then((result) => result.bodyPart),
    update: (id: number, input: Partial<Pick<BodyPart, 'name' | 'unit' | 'color'>>) =>
      request<{ bodyPart: BodyPart }>(`/api/body-parts/${id}`, { method: 'PATCH', body: json(input) })
        .then((result) => result.bodyPart),
    remove: (id: number) =>
      request<{ success: boolean }>(`/api/body-parts/${id}`, { method: 'DELETE' }),
    measurements: {
      list: async (bodyPartId: number) =>
        (await request<{ measurements: Measurement[] }>(`/api/body-parts/${bodyPartId}/measurements`)).measurements,
      create: (
        bodyPartId: number,
        input: Pick<Measurement, 'value' | 'recordedAt'> & { note?: string | null },
      ) =>
        request<{ measurement: Measurement }>(`/api/body-parts/${bodyPartId}/measurements`, {
          method: 'POST',
          body: json(input),
        }).then((result) => result.measurement),
      update: (
        bodyPartId: number,
        id: number,
        input: Partial<Pick<Measurement, 'value' | 'recordedAt' | 'note'>>,
      ) =>
        request<{ measurement: Measurement }>(`/api/body-parts/${bodyPartId}/measurements/${id}`, {
          method: 'PATCH',
          body: json(input),
        }).then((result) => result.measurement),
      remove: (bodyPartId: number, id: number) =>
        request<{ success: boolean }>(`/api/body-parts/${bodyPartId}/measurements/${id}`, {
          method: 'DELETE',
        }),
    },
  },
  exercises: {
    list: async () => (await request<{ exercises: Exercise[] }>('/api/exercises')).exercises,
    reorder: async (ids: number[]) => (
      await request<{ exercises: Exercise[] }>('/api/exercises/order', {
        method: 'PUT',
        body: json({ ids }),
      })
    ).exercises,
    create: (input: Pick<Exercise, 'name' | 'category' | 'unit' | 'color'>) =>
      request<{ exercise: Exercise }>('/api/exercises', { method: 'POST', body: json(input) })
        .then((result) => result.exercise),
    update: (
      id: number,
      input: Partial<Pick<Exercise, 'name' | 'category' | 'unit' | 'color'>>,
    ) => request<{ exercise: Exercise }>(`/api/exercises/${id}`, { method: 'PATCH', body: json(input) })
      .then((result) => result.exercise),
    remove: (id: number) =>
      request<{ success: boolean }>(`/api/exercises/${id}`, { method: 'DELETE' }),
    lifts: {
      list: async (exerciseId: number) =>
        (await request<{ lifts: Lift[] }>(`/api/exercises/${exerciseId}/lifts`)).lifts,
      create: (
        exerciseId: number,
        input: Pick<Lift, 'weight' | 'reps' | 'recordedAt'> & { note?: string | null },
      ) =>
        request<{ lift: Lift }>(`/api/exercises/${exerciseId}/lifts`, {
          method: 'POST',
          body: json(input),
        }).then((result) => result.lift),
      update: (
        exerciseId: number,
        id: number,
        input: Partial<Pick<Lift, 'weight' | 'reps' | 'recordedAt' | 'note'>>,
      ) =>
        request<{ lift: Lift }>(`/api/exercises/${exerciseId}/lifts/${id}`, {
          method: 'PATCH',
          body: json(input),
        }).then((result) => result.lift),
      remove: (exerciseId: number, id: number) =>
        request<{ success: boolean }>(`/api/exercises/${exerciseId}/lifts/${id}`, {
          method: 'DELETE',
        }),
    },
  },
  admin: {
    overview: () => request<AdminOverview>('/api/admin/overview'),
    users: async () => (await request<{ users: User[] }>('/api/admin/users')).users,
    audit: async () =>
      (await request<{ auditEntries: AuditEvent[] }>('/api/admin/audit?limit=100')).auditEntries,
    createUser: (input: { username: string }) =>
      request<{ user: User; inviteCode: string }>('/api/admin/users', {
        method: 'POST',
        body: json({ ...input, role: 'user' }),
      }),
    setUserStatus: (id: number, isActive: boolean) =>
      request<{ user: User }>(`/api/admin/users/${id}/status`, {
        method: 'PATCH',
        body: json({ isActive }),
      }).then((result) => result.user),
    resetInvite: (id: number) =>
      request<{ user: User; inviteCode: string }>(`/api/admin/users/${id}/reset-invite`, {
        method: 'POST',
      }),
    removeUser: (id: number) =>
      request<{ success: boolean }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
  },
  workoutPlan: {
    get: () => request<WorkoutPlan>('/api/workout-plan'),
    updateDay: (
      dayOfWeek: number,
      input: WorkoutDayInput,
    ) => request<{ day: WorkoutDay }>(`/api/workout-plan/${dayOfWeek}`, {
      method: 'PUT',
      body: json(input),
    }).then((result) => result.day),
  },
  mealPlan: {
    get: () => request<MealPlan>('/api/meal-plan'),
    getBmr: () => request<{ bmr: BmrProfile | null }>('/api/meal-plan/bmr')
      .then((result) => result.bmr),
    saveBmr: (input: BmrProfileInput) =>
      request<{ bmr: BmrProfile }>('/api/meal-plan/bmr', {
        method: 'PUT',
        body: json(input),
      }).then((result) => result.bmr),
    updateSettings: (input: Partial<MealPlanSettings>) =>
      request<{ settings: MealPlanSettings }>('/api/meal-plan/settings', {
        method: 'PUT',
        body: json(input),
      }).then((result) => result.settings),
    createMeal: (input: Omit<Meal, 'id' | 'createdAt' | 'updatedAt'>) =>
      request<{ meal: Meal }>('/api/meal-plan/meals', {
        method: 'POST',
        body: json(input),
      }).then((result) => result.meal),
    updateMeal: (
      id: number,
      input: Partial<Omit<Meal, 'id' | 'createdAt' | 'updatedAt'>>,
    ) => request<{ meal: Meal }>(`/api/meal-plan/meals/${id}`, {
      method: 'PATCH',
      body: json(input),
    }).then((result) => result.meal),
    removeMeal: (id: number) =>
      request<{ success: boolean }>(`/api/meal-plan/meals/${id}`, { method: 'DELETE' }),
  },
  sharing: {
    get: () => request<SharingOverview>('/api/sharing'),
    create: (input: { viewerUserId: number } & Partial<{
      shareMeasurements: boolean
      shareLifts: boolean
      shareWorkout: boolean
      shareMeals: boolean
    }>) => request<{ share: ProgressShare }>('/api/sharing', {
      method: 'POST',
      body: json(input),
    }).then((result) => result.share),
    update: (id: number, input: Partial<{
      shareMeasurements: boolean
      shareLifts: boolean
      shareWorkout: boolean
      shareMeals: boolean
    }>) => request<{ share: ProgressShare }>(`/api/sharing/${id}`, {
      method: 'PATCH',
      body: json(input),
    }).then((result) => result.share),
    remove: (id: number) =>
      request<{ success: boolean }>(`/api/sharing/${id}`, { method: 'DELETE' }),
    getSharedProgress: (ownerUserId: number) =>
      request<SharedProgress>(`/api/shared/${ownerUserId}`),
  },
  async exportData() {
    const response = await fetch('/api/export', { credentials: 'include' })
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
      throw new ApiError('Could not export your data.', response.status)
    }
    return response.blob()
  },
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
