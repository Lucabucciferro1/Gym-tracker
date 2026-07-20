import type { Exercise } from './types.js'

export type ExerciseLibrarySort = 'group' | 'custom' | 'name'

export interface ExerciseGroupOption {
  key: string
  label: string
  count: number
}

export interface ExerciseGroup {
  key: string
  label: string
  exercises: Exercise[]
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function normalizedText(value: string): string {
  return value.trim().toLocaleLowerCase('en-GB')
}

function exerciseGroupLabel(category: string): string {
  return category.trim() || 'Ungrouped'
}

export function exerciseGroupKey(category: string): string {
  return normalizedText(exerciseGroupLabel(category))
}

function customOrder(left: Exercise, right: Exercise): number {
  return left.sortOrder - right.sortOrder || left.id - right.id
}

export function exerciseGroupOptions(exercises: readonly Exercise[]): ExerciseGroupOption[] {
  const groups = new Map<string, ExerciseGroupOption>()
  for (const exercise of exercises) {
    const key = exerciseGroupKey(exercise.category)
    const existing = groups.get(key)
    if (existing) existing.count += 1
    else groups.set(key, { key, label: exerciseGroupLabel(exercise.category), count: 1 })
  }
  return [...groups.values()].sort((left, right) => collator.compare(left.label, right.label))
}

export function organizeExerciseLibrary(
  exercises: readonly Exercise[],
  options: { query?: string; group?: string; sort: ExerciseLibrarySort },
): Exercise[] {
  const query = normalizedText(options.query ?? '')
  const group = options.group && options.group !== 'all' ? exerciseGroupKey(options.group) : null
  const visible = exercises.filter((exercise) => {
    if (group && exerciseGroupKey(exercise.category) !== group) return false
    if (!query) return true
    return normalizedText(exercise.name).includes(query)
      || normalizedText(exercise.category).includes(query)
  })

  return [...visible].sort((left, right) => {
    if (options.sort === 'custom') return customOrder(left, right)
    if (options.sort === 'name') {
      return collator.compare(left.name, right.name)
        || collator.compare(left.category, right.category)
        || customOrder(left, right)
    }
    return collator.compare(exerciseGroupLabel(left.category), exerciseGroupLabel(right.category))
      || customOrder(left, right)
      || collator.compare(left.name, right.name)
  })
}

export function groupExercises(exercises: readonly Exercise[]): ExerciseGroup[] {
  const groups = new Map<string, ExerciseGroup>()
  for (const exercise of exercises) {
    const key = exerciseGroupKey(exercise.category)
    const existing = groups.get(key)
    if (existing) existing.exercises.push(exercise)
    else groups.set(key, {
      key,
      label: exerciseGroupLabel(exercise.category),
      exercises: [exercise],
    })
  }
  return [...groups.values()]
}
