import { describe, expect, it } from 'vitest'

import {
  exerciseGroupOptions,
  groupExercises,
  organizeExerciseLibrary,
} from '../src/exerciseLibrary.js'
import type { Exercise } from '../src/types.js'

function exercise(
  id: number,
  name: string,
  category: string,
  sortOrder: number,
): Exercise {
  return {
    id,
    name,
    category,
    sortOrder,
    unit: 'kg',
    color: '#f97316',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    recordCount: 0,
    personalBest: null,
    latestWeight: null,
    latestReps: null,
    latestRecordedAt: null,
  }
}

const library = [
  exercise(1, 'Bench Press', 'Push', 2),
  exercise(2, 'Barbell Row', 'Pull', 0),
  exercise(3, 'Incline Press', 'push', 1),
  exercise(4, 'Back Squat', 'Legs 10', 3),
  exercise(5, 'Front Squat', 'Legs 2', 4),
]

describe('exercise library grouping', () => {
  it('searches exercise names and groups without changing case sensitivity', () => {
    expect(organizeExerciseLibrary(library, { query: 'PRESS', sort: 'custom' }).map((item) => item.id))
      .toEqual([3, 1])
    expect(organizeExerciseLibrary(library, { query: 'pull', sort: 'custom' }).map((item) => item.id))
      .toEqual([2])
  })

  it('filters equivalent group casing and returns unique sorted group options', () => {
    expect(organizeExerciseLibrary(library, { group: 'PUSH', sort: 'custom' }).map((item) => item.id))
      .toEqual([3, 1])
    expect(exerciseGroupOptions(library)).toEqual([
      { key: 'legs 2', label: 'Legs 2', count: 1 },
      { key: 'legs 10', label: 'Legs 10', count: 1 },
      { key: 'pull', label: 'Pull', count: 1 },
      { key: 'push', label: 'Push', count: 2 },
    ])
  })

  it('sorts by group with saved custom order inside each group', () => {
    const sorted = organizeExerciseLibrary(library, { sort: 'group' })
    expect(sorted.map((item) => item.id)).toEqual([5, 4, 2, 3, 1])
    expect(groupExercises(sorted).map((group) => ({
      key: group.key,
      ids: group.exercises.map((item) => item.id),
    }))).toEqual([
      { key: 'legs 2', ids: [5] },
      { key: 'legs 10', ids: [4] },
      { key: 'pull', ids: [2] },
      { key: 'push', ids: [3, 1] },
    ])
  })

  it('supports custom and name sorting without mutating the source array', () => {
    const originalIds = library.map((item) => item.id)
    expect(organizeExerciseLibrary(library, { sort: 'custom' }).map((item) => item.id))
      .toEqual([2, 3, 1, 4, 5])
    expect(organizeExerciseLibrary(library, { sort: 'name' }).map((item) => item.name))
      .toEqual(['Back Squat', 'Barbell Row', 'Bench Press', 'Front Squat', 'Incline Press'])
    expect(library.map((item) => item.id)).toEqual(originalIds)
  })

  it('returns an empty result for unmatched filters', () => {
    expect(organizeExerciseLibrary(library, { query: 'deadlift', group: 'Push', sort: 'group' }))
      .toEqual([])
  })
})
