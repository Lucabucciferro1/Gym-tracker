import {
  BedDouble,
  CalendarDays,
  Dumbbell,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { api, errorMessage } from '../api'
import { Button, EmptyState, ErrorNotice, Modal, PageHeader } from '../components/ui'
import { useToast } from '../context/ToastContext'
import type { WorkoutDay, WorkoutExercise } from '../types'
import '../plans.css'

const DAYS = [
  { value: 0, label: 'Monday', short: 'Mon' },
  { value: 1, label: 'Tuesday', short: 'Tue' },
  { value: 2, label: 'Wednesday', short: 'Wed' },
  { value: 3, label: 'Thursday', short: 'Thu' },
  { value: 4, label: 'Friday', short: 'Fri' },
  { value: 5, label: 'Saturday', short: 'Sat' },
  { value: 6, label: 'Sunday', short: 'Sun' },
] as const

interface ExerciseDraft {
  key: string
  name: string
  sets: string
  reps: string
  notes: string
}

function draftKey() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function blankExercise(): ExerciseDraft {
  return { key: draftKey(), name: '', sets: '3', reps: '8', notes: '' }
}

function toDraft(exercise: WorkoutExercise): ExerciseDraft {
  return {
    key: draftKey(),
    name: exercise.name,
    sets: String(exercise.sets),
    reps: String(exercise.reps),
    notes: exercise.notes ?? '',
  }
}

function dayLabel(dayOfWeek: number) {
  return DAYS.find((day) => day.value === dayOfWeek)?.label ?? 'Training day'
}

export function WorkoutPlanPage() {
  const toast = useToast()
  const [days, setDays] = useState<WorkoutDay[]>([])
  const [selectedDay, setSelectedDay] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')
    try {
      const nextPlan = await api.workoutPlan.get()
      const nextDays = nextPlan.days
      setDays(nextDays)
      setSelectedDay((current) => nextDays.some((day) => day.dayOfWeek === current)
        ? current
        : nextDays[0]?.dayOfWeek ?? 0)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const activeDay = days.find((day) => day.dayOfWeek === selectedDay) ?? null
  const trainingDays = days.filter((day) => !day.isRest).length
  const totalExercises = days.reduce((total, day) => total + day.exercises.length, 0)
  const averageExercises = trainingDays ? totalExercises / trainingDays : 0

  const orderedDays = useMemo(
    () => DAYS.map((definition) => ({
      ...definition,
      plan: days.find((day) => day.dayOfWeek === definition.value) ?? null,
    })),
    [days],
  )

  function selectDay(dayOfWeek: number, focus = false) {
    setSelectedDay(dayOfWeek)
    if (focus) {
      window.requestAnimationFrame(() => document.getElementById(`workout-day-tab-${dayOfWeek}`)?.focus())
    }
  }

  function handleDayKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % DAYS.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + DAYS.length) % DAYS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = DAYS.length - 1
    if (nextIndex == null) return
    event.preventDefault()
    selectDay(DAYS[nextIndex].value, true)
  }

  async function saveDay(input: {
    name: string
    isRest: boolean
    notes: string | null
    exercises: Array<{ name: string; sets: number; reps: string; notes: string | null }>
  }) {
    if (!activeDay) return
    setSaving(true)
    setFormError('')
    try {
      await api.workoutPlan.updateDay(activeDay.dayOfWeek, input)
      setEditorOpen(false)
      toast(`${dayLabel(activeDay.dayOfWeek)} plan updated.`)
      await load(false)
    } catch (caught) {
      setFormError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page-stack plan-page workout-plan-page">
      <PageHeader
        eyebrow="WEEKLY ROUTINE"
        title="Workout plan"
        description="Shape a repeatable week, keep every session focused, and make recovery part of the plan."
        actions={(
          <Button
            icon={<Pencil size={17} />}
            disabled={!activeDay || loading}
            onClick={() => { setFormError(''); setEditorOpen(true) }}
          >
            Edit {activeDay ? dayLabel(activeDay.dayOfWeek) : 'day'}
          </Button>
        )}
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

      <section className="plan-summary panel" aria-label="Weekly workout summary">
        <div className="plan-summary__intro">
          <span className="plan-summary__icon"><CalendarDays size={22} /></span>
          <div>
            <span className="eyebrow">THIS WEEK, BY DESIGN</span>
            <h2>{loading ? 'Building your week...' : `${trainingDays} training days, ${days.length - trainingDays} recovery days`}</h2>
            <p>A clear plan removes the guesswork when it is time to train.</p>
          </div>
        </div>
        <div className="plan-summary__stats">
          <span><strong>{loading ? '-' : totalExercises}</strong><small>Exercises</small></span>
          <span><strong>{loading ? '-' : averageExercises.toFixed(1)}</strong><small>Per session</small></span>
          <span><strong>{loading ? '-' : trainingDays}</strong><small>Training days</small></span>
        </div>
      </section>

      <section className="plan-day-tabs" role="tablist" aria-label="Choose workout day">
        {orderedDays.map(({ value, label, short, plan }, index) => {
          const selected = selectedDay === value
          const exerciseCount = plan?.exercises.length ?? 0
          return (
            <button
              id={`workout-day-tab-${value}`}
              type="button"
              role="tab"
              key={value}
              aria-selected={selected}
              aria-controls="workout-day-panel"
              tabIndex={selected ? 0 : -1}
              className={`plan-day-tab ${selected ? 'is-active' : ''} ${plan?.isRest ? 'is-rest' : ''}`}
              onClick={() => selectDay(value)}
              onKeyDown={(event) => handleDayKeyDown(event, index)}
            >
              <span className="plan-day-tab__short">{short}</span>
              <strong>{label}</strong>
              {loading ? (
                <span className="plan-day-tab__loading" />
              ) : plan?.isRest ? (
                <span className="plan-day-tab__meta"><BedDouble size={13} /> Rest</span>
              ) : (
                <span className="plan-day-tab__meta"><Dumbbell size={13} /> {exerciseCount} {exerciseCount === 1 ? 'exercise' : 'exercises'}</span>
              )}
            </button>
          )
        })}
      </section>

      <section
        id="workout-day-panel"
        className="panel plan-detail-panel"
        role="tabpanel"
        aria-labelledby={`workout-day-tab-${selectedDay}`}
        tabIndex={0}
      >
        {loading ? (
          <PlanLoading />
        ) : activeDay ? (
          <>
            <header className="plan-detail-panel__header">
              <div>
                <span className="eyebrow">{dayLabel(activeDay.dayOfWeek).toUpperCase()} / {activeDay.isRest ? 'RECOVER & ADAPT' : 'TRAINING SESSION'}</span>
                <h2>{activeDay.name}</h2>
                <p>{activeDay.notes || (activeDay.isRest ? 'Give your body space to rebuild.' : 'No session notes yet.')}</p>
              </div>
              <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => { setFormError(''); setEditorOpen(true) }}>Edit day</Button>
            </header>

            {activeDay.isRest ? (
              <div className="rest-day-state">
                <span><BedDouble size={30} /></span>
                <div><h3>Rest is productive.</h3><p>Recovery is where training turns into progress. Sleep well, eat well, and come back ready.</p></div>
                <Sparkles size={22} aria-hidden="true" />
              </div>
            ) : activeDay.exercises.length ? (
              <ol className="workout-exercise-list">
                {activeDay.exercises.map((exercise, index) => (
                  <li className="workout-exercise-card" key={exercise.id ?? `${exercise.name}-${index}`}>
                    <span className="workout-exercise-card__number">{String(index + 1).padStart(2, '0')}</span>
                    <div className="workout-exercise-card__body">
                      <h3>{exercise.name}</h3>
                      {exercise.notes && <p>{exercise.notes}</p>}
                    </div>
                    <div className="workout-exercise-card__prescription" aria-label={`${exercise.sets} sets of ${exercise.reps} repetitions`}>
                      <strong>{exercise.sets}</strong><small>SETS</small><i aria-hidden="true">x</i><strong>{exercise.reps}</strong><small>REPS</small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState
                compact
                icon={<Dumbbell size={23} />}
                title="No exercises planned"
                description="Add the movements, sets, and reps that will make this session count."
                action={<Button variant="secondary" icon={<Plus size={16} />} onClick={() => setEditorOpen(true)}>Build this session</Button>}
              />
            )}
          </>
        ) : (
          <EmptyState compact icon={<RotateCcw size={23} />} title="Day unavailable" description="Refresh the plan to load this day." action={<Button variant="secondary" onClick={() => void load()}>Refresh plan</Button>} />
        )}
      </section>

      <WorkoutDayModal
        open={editorOpen}
        day={activeDay}
        busy={saving}
        error={formError}
        onClose={() => { if (!saving) setEditorOpen(false) }}
        onSave={saveDay}
      />
    </div>
  )
}

function PlanLoading() {
  return (
    <div className="plan-loading" role="status">
      <span className="plan-loading__title" />
      <span className="plan-loading__row" />
      <span className="plan-loading__row" />
      <span className="plan-loading__row" />
      <span className="sr-only">Loading workout plan...</span>
    </div>
  )
}

function WorkoutDayModal({
  open,
  day,
  busy,
  error,
  onClose,
  onSave,
}: {
  open: boolean
  day: WorkoutDay | null
  busy: boolean
  error: string
  onClose: () => void
  onSave: (input: {
    name: string
    isRest: boolean
    notes: string | null
    exercises: Array<{ name: string; sets: number; reps: string; notes: string | null }>
  }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [isRest, setIsRest] = useState(false)
  const [notes, setNotes] = useState('')
  const [exercises, setExercises] = useState<ExerciseDraft[]>([])
  const [localError, setLocalError] = useState('')
  const existingExerciseCount = day?.exercises.length ?? 0

  useEffect(() => {
    if (!open || !day) return
    setName(day.name)
    setIsRest(day.isRest)
    setNotes(day.notes ?? '')
    setExercises(day.exercises.length ? day.exercises.map(toDraft) : [blankExercise()])
    setLocalError('')
  }, [day, open])

  function updateExercise(key: string, field: keyof Omit<ExerciseDraft, 'key'>, value: string) {
    setExercises((current) => current.map((exercise) => exercise.key === key ? { ...exercise, [field]: value } : exercise))
  }

  function removeExercise(key: string) {
    setExercises((current) => current.filter((exercise) => exercise.key !== key))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    setLocalError('')
    if (!name.trim()) {
      setLocalError('Give this day a session name.')
      return
    }
    const normalized = exercises.map((exercise) => ({
      name: exercise.name.trim(),
      sets: Number(exercise.sets),
      reps: exercise.reps.trim(),
      notes: exercise.notes.trim() || null,
    }))
    if (!isRest && !normalized.length) {
      setLocalError('Add at least one exercise or mark this as a rest day.')
      return
    }
    if (!isRest && normalized.some((exercise) => !exercise.name || exercise.sets < 1 || !exercise.reps)) {
      setLocalError('Every exercise needs a name, at least one set, and at least one rep.')
      return
    }
    void onSave({ name: name.trim(), isRest, notes: notes.trim() || null, exercises: isRest ? [] : normalized })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="WEEKLY ROUTINE"
      title={`Edit ${day ? dayLabel(day.dayOfWeek) : 'day'}`}
      size="large"
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" form="workout-day-form" busy={busy}>Save day</Button>
        </>
      )}
    >
      <form id="workout-day-form" className="form-stack plan-form" onSubmit={submit}>
        {(localError || error) && <div className="form-alert" role="alert">{localError || error}</div>}

        <label className="plan-switch-row">
          <span className="plan-switch-row__icon"><BedDouble size={19} /></span>
          <span><strong>Rest day</strong><small>Keep the day clear for recovery.</small></span>
          <input type="checkbox" role="switch" checked={isRest} onChange={(event) => setIsRest(event.target.checked)} />
        </label>

        {isRest && existingExerciseCount > 0 && (
          <div className="form-alert" role="alert">
            <TriangleAlert size={17} /> Saving this as a rest day will permanently remove its {existingExerciseCount} planned {existingExerciseCount === 1 ? 'exercise' : 'exercises'}.
          </div>
        )}

        <label className="field"><span>Session name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={isRest ? 'e.g. Full recovery' : 'e.g. Push day'} maxLength={80} required data-modal-autofocus /></label>

        {!isRest && (
          <section className="plan-form-section" aria-labelledby="exercise-list-heading">
            <header><div><span className="eyebrow">SESSION CONTENT</span><h3 id="exercise-list-heading">Exercises</h3></div><span>{exercises.length} {exercises.length === 1 ? 'movement' : 'movements'}</span></header>
            <div className="exercise-editor-list">
              {exercises.map((exercise, index) => (
                <fieldset className="exercise-editor" key={exercise.key}>
                  <legend>Exercise {index + 1}</legend>
                  <button type="button" className="icon-button icon-button--danger exercise-editor__remove" onClick={() => removeExercise(exercise.key)} aria-label={`Remove exercise ${index + 1}`}><Trash2 size={16} /></button>
                  <label className="field exercise-editor__name"><span>Exercise name</span><input value={exercise.name} onChange={(event) => updateExercise(exercise.key, 'name', event.target.value)} placeholder="e.g. Incline dumbbell press" maxLength={80} required /></label>
                  <div className="form-grid exercise-editor__numbers">
                    <label className="field"><span>Sets</span><input type="number" min="1" max="100" step="1" value={exercise.sets} onChange={(event) => updateExercise(exercise.key, 'sets', event.target.value)} required /></label>
                    <label className="field"><span>Reps</span><input value={exercise.reps} onChange={(event) => updateExercise(exercise.key, 'reps', event.target.value)} placeholder="e.g. 8-10" maxLength={30} required /></label>
                  </div>
                  <label className="field exercise-editor__notes"><span>Exercise notes <small>Optional</small></span><input value={exercise.notes} onChange={(event) => updateExercise(exercise.key, 'notes', event.target.value)} placeholder="Tempo, rest time, form cue..." maxLength={300} /></label>
                </fieldset>
              ))}
            </div>
            <Button type="button" variant="ghost" icon={<Plus size={16} />} onClick={() => setExercises((current) => [...current, blankExercise()])}>Add another exercise</Button>
          </section>
        )}

        <label className="field"><span>Day notes <small>Optional</small></span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder={isRest ? 'Recovery focus, mobility, or a reminder...' : 'Session focus or reminders...'} maxLength={500} /></label>
      </form>
    </Modal>
  )
}
