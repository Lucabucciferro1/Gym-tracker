import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Dumbbell,
  Flame,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Target,
  Trash2,
  Trophy,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, errorMessage } from '../api'
import { ProgressChart } from '../components/ProgressChart'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  MetricCard,
  Modal,
  PageHeader,
  RangeSelector,
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import { CHART_COLORS, type DateRange, type Exercise, type Lift } from '../types'
import {
  dateInput,
  estimatedOneRepMax,
  filterByRange,
  formatDate,
  percentChange,
  toIsoDate,
  todayInput,
} from '../utils'

type DeleteTarget =
  | { kind: 'exercise'; item: Exercise }
  | { kind: 'lift'; item: Lift }
  | null

export function LiftsPage() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [exercises, setExercises] = useState<Exercise[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [lifts, setLifts] = useState<Lift[]>([])
  const [range, setRange] = useState<DateRange>('90d')
  const [loadingExercises, setLoadingExercises] = useState(true)
  const [loadingLifts, setLoadingLifts] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [exerciseModalOpen, setExerciseModalOpen] = useState(false)
  const [liftModalOpen, setLiftModalOpen] = useState(false)
  const [editingExercise, setEditingExercise] = useState<Exercise | null>(null)
  const [editingLift, setEditingLift] = useState<Lift | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editingOrder, setEditingOrder] = useState(false)
  const [orderDraft, setOrderDraft] = useState<Exercise[]>([])
  const [draggedExerciseId, setDraggedExerciseId] = useState<number | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)
  const [orderError, setOrderError] = useState('')
  const [orderAnnouncement, setOrderAnnouncement] = useState('')
  const liftRequest = useRef(0)
  const pendingRecordAfterCreate = useRef(false)

  const selectedExercise = exercises.find((exercise) => exercise.id === selectedId) ?? null

  const loadExercises = useCallback(async (preferredId?: number) => {
    setLoadingExercises(true)
    setError('')
    try {
      const nextExercises = await api.exercises.list()
      setExercises(nextExercises)
      setSelectedId((current) => {
        if (preferredId && nextExercises.some((exercise) => exercise.id === preferredId)) return preferredId
        if (current && nextExercises.some((exercise) => exercise.id === current)) return current
        return nextExercises[0]?.id ?? null
      })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoadingExercises(false)
    }
  }, [])

  const loadLifts = useCallback(async (exerciseId: number) => {
    const requestId = ++liftRequest.current
    setLoadingLifts(true)
    setError('')
    try {
      const nextLifts = await api.exercises.lifts.list(exerciseId)
      if (requestId === liftRequest.current) setLifts(nextLifts)
    } catch (caught) {
      if (requestId === liftRequest.current) setError(errorMessage(caught))
    } finally {
      if (requestId === liftRequest.current) setLoadingLifts(false)
    }
  }, [])

  useEffect(() => {
    void loadExercises()
  }, [loadExercises])

  useEffect(() => {
    setLifts([])
    if (selectedId) void loadLifts(selectedId)
    else {
      liftRequest.current += 1
      setLoadingLifts(false)
    }
  }, [loadLifts, selectedId])

  useEffect(() => {
    if (loadingExercises || searchParams.get('new') !== 'record') return
    if (exercises.length) {
      pendingRecordAfterCreate.current = false
      setEditingLift(null)
      setLiftModalOpen(true)
    } else {
      pendingRecordAfterCreate.current = true
      setEditingExercise(null)
      setExerciseModalOpen(true)
    }
    setSearchParams({}, { replace: true })
  }, [exercises.length, loadingExercises, searchParams, setSearchParams])

  const filteredLifts = useMemo(() => filterByRange(lifts, range), [lifts, range])
  const personalBest = lifts.reduce<Lift | null>((best, lift) => (!best || lift.weight > best.weight ? lift : best), null)
  const latest = lifts.at(-1)
  const previous = lifts.at(-2)
  const latestEstimated = latest ? estimatedOneRepMax(latest.weight, latest.reps) : null
  const previousEstimated = previous ? estimatedOneRepMax(previous.weight, previous.reps) : null
  const latestChange = percentChange(latestEstimated, previousEstimated)

  function openNewExercise() {
    setEditingExercise(null)
    setFormError('')
    setExerciseModalOpen(true)
  }

  function openEditExercise() {
    if (!selectedExercise) return
    setEditingExercise(selectedExercise)
    setFormError('')
    setExerciseModalOpen(true)
  }

  function openNewLift() {
    if (!selectedExercise) {
      openNewExercise()
      return
    }
    setEditingLift(null)
    setFormError('')
    setLiftModalOpen(true)
  }

  async function saveExercise(input: { name: string; category: string; unit: string; color: string }) {
    setSaving(true)
    setFormError('')
    try {
      const saved = editingExercise
        ? await api.exercises.update(editingExercise.id, input)
        : await api.exercises.create(input)
      setExerciseModalOpen(false)
      toast(editingExercise ? `${saved.name} updated.` : `${saved.name} added.`)
      await loadExercises(saved.id)
      if (!editingExercise && pendingRecordAfterCreate.current) {
        pendingRecordAfterCreate.current = false
        setEditingLift(null)
        setLiftModalOpen(true)
      }
    } catch (caught) {
      setFormError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  async function saveLift(input: { weight: number; reps: number; recordedAt: string; note?: string | null }) {
    if (!selectedExercise) return
    setSaving(true)
    setFormError('')
    try {
      if (editingLift) {
        await api.exercises.lifts.update(selectedExercise.id, editingLift.id, input)
      } else {
        await api.exercises.lifts.create(selectedExercise.id, input)
      }
      setLiftModalOpen(false)
      toast(editingLift ? 'Lift record updated.' : 'Max lift logged.')
      await Promise.all([loadLifts(selectedExercise.id), loadExercises(selectedExercise.id)])
    } catch (caught) {
      setFormError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.kind === 'exercise') {
        await api.exercises.remove(deleteTarget.item.id)
        toast(`${deleteTarget.item.name} removed.`)
        setDeleteTarget(null)
        liftRequest.current += 1
        setLifts([])
        await loadExercises()
      } else if (selectedExercise) {
        await api.exercises.lifts.remove(selectedExercise.id, deleteTarget.item.id)
        toast('Lift record deleted.')
        setDeleteTarget(null)
        await Promise.all([loadLifts(selectedExercise.id), loadExercises(selectedExercise.id)])
      }
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setDeleting(false)
    }
  }

  function startEditingOrder() {
    setOrderDraft([...exercises])
    setOrderError('')
    setOrderAnnouncement('Reorder mode started.')
    setEditingOrder(true)
  }

  function cancelEditingOrder() {
    setOrderDraft([])
    setDraggedExerciseId(null)
    setOrderError('')
    setOrderAnnouncement('Order changes cancelled.')
    setEditingOrder(false)
  }

  function moveExercise(exerciseId: number, destinationIndex: number) {
    const sourceIndex = orderDraft.findIndex((exercise) => exercise.id === exerciseId)
    if (sourceIndex < 0) return

    const nextIndex = Math.max(0, Math.min(destinationIndex, orderDraft.length - 1))
    if (sourceIndex === nextIndex) return

    const next = [...orderDraft]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(nextIndex, 0, moved)
    setOrderDraft(next)
    setOrderError('')
    setOrderAnnouncement(`${moved.name} moved to position ${nextIndex + 1} of ${next.length}.`)
  }

  function startDraggingExercise(event: DragEvent<HTMLDivElement>, exercise: Exercise) {
    setDraggedExerciseId(exercise.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(exercise.id))
    setOrderAnnouncement(`Moving ${exercise.name}. Drop it on another exercise to change its position.`)
  }

  function dropExercise(event: DragEvent<HTMLDivElement>, targetIndex: number) {
    event.preventDefault()
    const transferredId = Number(event.dataTransfer.getData('text/plain'))
    const sourceId = Number.isFinite(transferredId) && transferredId > 0 ? transferredId : draggedExerciseId
    if (sourceId == null) return

    const fromIndex = orderDraft.findIndex((exercise) => exercise.id === sourceId)
    const itemRect = event.currentTarget.getBoundingClientRect()
    const siblings = Array.from(event.currentTarget.parentElement?.children ?? []) as HTMLElement[]
    const adjacent = siblings[targetIndex + 1] ?? siblings[targetIndex - 1]
    const adjacentRect = adjacent?.getBoundingClientRect()
    const horizontal = adjacentRect
      ? Math.abs(adjacentRect.left - itemRect.left) > Math.abs(adjacentRect.top - itemRect.top)
      : itemRect.width > itemRect.height * 2
    const dropAfter = horizontal
      ? event.clientX >= itemRect.left + itemRect.width / 2
      : event.clientY >= itemRect.top + itemRect.height / 2

    let destinationIndex = targetIndex + (dropAfter ? 1 : 0)
    if (fromIndex < destinationIndex) destinationIndex -= 1
    moveExercise(sourceId, destinationIndex)
    setDraggedExerciseId(null)
  }

  async function saveExerciseOrder() {
    setSavingOrder(true)
    setOrderError('')
    try {
      const reordered = await api.exercises.reorder(orderDraft.map((exercise) => exercise.id))
      setExercises(reordered)
      setOrderDraft([])
      setDraggedExerciseId(null)
      setOrderAnnouncement('Exercise order saved.')
      setEditingOrder(false)
      toast('Exercise order saved.')
    } catch (caught) {
      const message = errorMessage(caught)
      setOrderError(message)
      toast(message, 'error')
    } finally {
      setSavingOrder(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="STRENGTH PROGRESS"
        title="Max lifts"
        description="Keep an honest record of your best sets and let the long-term strength curve do the talking."
        actions={(
          <>
            {!editingOrder && (
              <>
                <Button variant="secondary" icon={<GripVertical size={17} />} onClick={startEditingOrder} disabled={loadingExercises || exercises.length < 2}>Edit order</Button>
                <Button variant="secondary" icon={<Plus size={17} />} onClick={openNewExercise}>Add exercise</Button>
                <Button icon={<Dumbbell size={17} />} onClick={openNewLift}>Log max lift</Button>
              </>
            )}
          </>
        )}
      />

      {error && <ErrorNotice message={error} onRetry={() => {
        void loadExercises(selectedId ?? undefined)
        if (selectedId) {
          setLifts([])
          void loadLifts(selectedId)
        }
      }} />}

      {!loadingExercises && exercises.length === 0 ? (
        <section className="panel panel--empty-page">
          <EmptyState
            icon={<Dumbbell size={28} />}
            title="Start with your main lift"
            description="Add any exercise you care about - barbell, machine, or bodyweight - then log your current best."
            action={<Button icon={<Plus size={17} />} onClick={openNewExercise}>Add your first exercise</Button>}
          />
        </section>
      ) : (
        <div className="tracker-layout">
          <aside className="tracker-selector panel">
            <div className="tracker-selector__heading"><span>EXERCISES</span><small>{exercises.length}</small></div>
            {editingOrder ? (
              <div className="tracker-reorder">
                <p className="tracker-reorder__hint" id="exercise-order-hint">Drag exercises into place, or use the arrow buttons.</p>
                {orderError && <div className="tracker-reorder__feedback form-alert" role="alert">{orderError}</div>}
                <div className="tracker-reorder__list" role="list" aria-label="Exercise order" aria-describedby="exercise-order-hint">
                  {orderDraft.map((exercise, index) => (
                    <div
                      key={exercise.id}
                      className={`tracker-reorder__item${draggedExerciseId === exercise.id ? ' is-dragging' : ''}`}
                      role="listitem"
                      draggable={!savingOrder}
                      onDragStart={(event) => startDraggingExercise(event, exercise)}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(event) => dropExercise(event, index)}
                      onDragEnd={() => setDraggedExerciseId(null)}
                    >
                      <span className="tracker-reorder__grip" aria-hidden="true"><GripVertical size={18} /></span>
                      <span className="series-dot" style={{ backgroundColor: exercise.color }} />
                      <span className="tracker-reorder__content"><strong>{exercise.name}</strong><small>Position {index + 1} of {orderDraft.length}</small></span>
                      <span className="tracker-reorder__controls">
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => moveExercise(exercise.id, index - 1)}
                          disabled={index === 0 || savingOrder}
                          aria-label={`Move ${exercise.name} up`}
                        ><ArrowUp size={15} /></button>
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => moveExercise(exercise.id, index + 1)}
                          disabled={index === orderDraft.length - 1 || savingOrder}
                          aria-label={`Move ${exercise.name} down`}
                        ><ArrowDown size={15} /></button>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="tracker-reorder__actions">
                  <Button variant="secondary" type="button" onClick={cancelEditingOrder} disabled={savingOrder}>Cancel</Button>
                  <Button type="button" onClick={() => void saveExerciseOrder()} busy={savingOrder}>Save order</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="tracker-selector__list">
                  {exercises.map((exercise) => (
                    <button
                      type="button"
                      key={exercise.id}
                      className={exercise.id === selectedId ? 'is-active' : ''}
                      aria-pressed={exercise.id === selectedId}
                      onClick={() => {
                        if (exercise.id === selectedId) return
                        liftRequest.current += 1
                        setLifts([])
                        setError('')
                        setSelectedId(exercise.id)
                      }}
                    >
                      <span className="series-dot" style={{ backgroundColor: exercise.color }} />
                      <span><strong>{exercise.name}</strong><small>{exercise.category}</small></span>
                      <b>{exercise.personalBest == null ? '-' : `${exercise.personalBest} ${exercise.unit}`}</b>
                    </button>
                  ))}
                </div>
                <Button variant="ghost" icon={<Plus size={16} />} onClick={openNewExercise}>Custom exercise</Button>
              </>
            )}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{orderAnnouncement}</span>
          </aside>

          <div className="tracker-main">
            {selectedExercise && (
              <>
                <section className="tracker-title-row">
                  <div>
                    <span className="series-dot series-dot--large" style={{ backgroundColor: selectedExercise.color }} />
                    <div><span className="eyebrow">{selectedExercise.category.toUpperCase()}</span><h2>{selectedExercise.name}</h2></div>
                  </div>
                  <div className="inline-actions">
                    <button className="icon-button" type="button" onClick={openEditExercise} aria-label={`Edit ${selectedExercise.name}`}><Pencil size={17} /></button>
                    <button className="icon-button icon-button--danger" type="button" onClick={() => setDeleteTarget({ kind: 'exercise', item: selectedExercise })} aria-label={`Delete ${selectedExercise.name}`}><Trash2 size={17} /></button>
                  </div>
                </section>

                <section className="metric-grid metric-grid--three">
                  <MetricCard
                    label="Personal best"
                    value={personalBest ? `${personalBest.weight} ${selectedExercise.unit}` : '-'}
                    detail={personalBest ? `${personalBest.reps} ${personalBest.reps === 1 ? 'rep' : 'reps'} on ${formatDate(personalBest.recordedAt)}` : 'No records yet'}
                    icon={<Trophy size={20} />}
                  />
                  <MetricCard
                    label="Estimated 1RM"
                    value={latestEstimated == null ? '-' : `${latestEstimated.toFixed(1)} ${selectedExercise.unit}`}
                    detail={latest ? `Based on latest ${latest.reps}-rep set` : 'Log a set to estimate'}
                    icon={<Target size={20} />}
                    trend={latestChange}
                  />
                  <MetricCard label="Recorded sets" value={String(lifts.length)} detail={filteredLifts.length === lifts.length ? 'All time' : `${filteredLifts.length} in selected range`} icon={<Flame size={20} />} />
                </section>

                <article className="panel panel--chart tracker-chart">
                  <header className="panel__header">
                    <div><span className="eyebrow">PROGRESS OVER TIME</span><h2>Strength curve</h2></div>
                    <div className="chart-controls"><span className="chart-legend"><i /> Weight <i /> Est. 1RM</span><RangeSelector value={range} onChange={setRange} /></div>
                  </header>
                  {loadingLifts ? (
                    <div className="chart-skeleton" />
                  ) : filteredLifts.length ? (
                    <ProgressChart
                      data={filteredLifts.map((lift) => ({ recordedAt: lift.recordedAt, value: lift.weight, secondary: estimatedOneRepMax(lift.weight, lift.reps) }))}
                      color={selectedExercise.color}
                      unit={selectedExercise.unit}
                      secondaryLabel="Estimated 1RM"
                    />
                  ) : (
                    <EmptyState compact icon={<Activity size={22} />} title="No lifts in this range" description="Choose a wider date range or log a new personal best." action={<Button variant="secondary" icon={<Plus size={16} />} onClick={openNewLift}>Log max lift</Button>} />
                  )}
                </article>

                <article className="panel records-panel">
                  <header className="panel__header">
                    <div><span className="eyebrow">HISTORY</span><h2>Lift records</h2></div>
                    <Button variant="secondary" icon={<Plus size={16} />} onClick={openNewLift}>Add record</Button>
                  </header>
                  {lifts.length ? (
                    <div className="responsive-table">
                      <table>
                        <thead><tr><th>Date</th><th>Weight</th><th>Reps</th><th>Est. 1RM</th><th>Note</th><th><span className="sr-only">Actions</span></th></tr></thead>
                        <tbody>
                          {[...lifts].reverse().map((lift) => (
                            <tr key={lift.id}>
                              <td data-label="Date"><strong>{formatDate(lift.recordedAt)}</strong></td>
                              <td data-label="Weight"><span className="value-cell">{lift.weight} <small>{selectedExercise.unit}</small></span></td>
                              <td data-label="Reps"><span className="rep-badge">{lift.reps}</span></td>
                              <td data-label="Est. 1RM">{estimatedOneRepMax(lift.weight, lift.reps).toFixed(1)} {selectedExercise.unit}</td>
                              <td data-label="Note"><span className="note-cell">{lift.note || '-'}</span></td>
                              <td className="table-actions">
                                <button type="button" className="icon-button" onClick={() => { setEditingLift(lift); setFormError(''); setLiftModalOpen(true) }} aria-label="Edit lift"><Pencil size={16} /></button>
                                <button type="button" className="icon-button icon-button--danger" onClick={() => setDeleteTarget({ kind: 'lift', item: lift })} aria-label="Delete lift"><Trash2 size={16} /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState compact icon={<MoreHorizontal size={22} />} title="No sets logged yet" description={`Add your current ${selectedExercise.name.toLowerCase()} best to establish a baseline.`} action={<Button variant="secondary" onClick={openNewLift}>Add baseline</Button>} />
                  )}
                </article>
              </>
            )}
          </div>
        </div>
      )}

      <ExerciseModal
        open={exerciseModalOpen}
        item={editingExercise}
        error={formError}
        busy={saving}
        onClose={() => {
          setExerciseModalOpen(false)
          pendingRecordAfterCreate.current = false
        }}
        onSave={saveExercise}
      />
      <LiftModal
        open={liftModalOpen}
        item={editingLift}
        exercise={selectedExercise}
        error={formError}
        busy={saving}
        onClose={() => setLiftModalOpen(false)}
        onSave={saveLift}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.kind === 'exercise' ? `Remove ${deleteTarget.item.name}?` : 'Delete this lift record?'}
        message={deleteTarget?.kind === 'exercise'
          ? 'This permanently deletes every saved lift. If the exercise is used in your Workout Plan, remove those planned entries first.'
          : 'This record will be permanently removed from the chart and history.'}
        busy={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

function ExerciseModal({
  open,
  item,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  item: Exercise | null
  error: string
  busy: boolean
  onClose: () => void
  onSave: (input: { name: string; category: string; unit: string; color: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('Strength')
  const [unit, setUnit] = useState('kg')
  const [color, setColor] = useState(CHART_COLORS[1])

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? '')
    setCategory(item?.category ?? 'Strength')
    setUnit(item?.unit ?? 'kg')
    setColor(item?.color ?? CHART_COLORS[1])
  }, [item, open])

  function submit(event: FormEvent) {
    event.preventDefault()
    void onSave({ name: name.trim(), category: category.trim(), unit: unit.trim(), color })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="CUSTOM TRACKING"
      title={item ? 'Edit exercise' : 'Add an exercise'}
      footer={<><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" form="exercise-form" busy={busy}>{item ? 'Save changes' : 'Add exercise'}</Button></>}
    >
      <form id="exercise-form" className="form-stack" onSubmit={submit}>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <label className="field"><span>Exercise name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Incline bench press" maxLength={100} required data-modal-autofocus /></label>
        <div className="form-grid">
          <label className="field"><span>Category</span><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Strength" maxLength={40} required /></label>
          <label className="field">
            <span>Unit</span>
            <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="kg" maxLength={16} required disabled={Boolean(item?.recordCount)} />
            {Boolean(item?.recordCount) && <small>Remove this exercise's lift history before changing its unit.</small>}
          </label>
        </div>
        <label className="field"><span>Chart colour</span><span className="color-input"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><b>{color.toUpperCase()}</b></span></label>
        <div className="color-swatches" aria-label="Suggested colours">
          {CHART_COLORS.map((swatch) => <button type="button" key={swatch} className={color === swatch ? 'is-active' : ''} style={{ backgroundColor: swatch }} onClick={() => setColor(swatch)} aria-label={`Use colour ${swatch}`} aria-pressed={color === swatch} />)}
        </div>
      </form>
    </Modal>
  )
}

function LiftModal({
  open,
  item,
  exercise,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  item: Lift | null
  exercise: Exercise | null
  error: string
  busy: boolean
  onClose: () => void
  onSave: (input: { weight: number; reps: number; recordedAt: string; note?: string | null }) => Promise<void>
}) {
  const [weight, setWeight] = useState('')
  const [reps, setReps] = useState('1')
  const [recordedAt, setRecordedAt] = useState(todayInput())
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) return
    setWeight(item ? String(item.weight) : '')
    setReps(item ? String(item.reps) : '1')
    setRecordedAt(item ? dateInput(item.recordedAt) : todayInput())
    setNote(item?.note ?? '')
  }, [item, open])

  function submit(event: FormEvent) {
    event.preventDefault()
    void onSave({ weight: Number(weight), reps: Number(reps), recordedAt: toIsoDate(recordedAt), note: note.trim() || null })
  }

  const estimate = weight && reps ? estimatedOneRepMax(Number(weight), Number(reps)) : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={exercise?.name.toUpperCase()}
      title={item ? 'Edit lift record' : 'Log a max lift'}
      footer={<><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" form="lift-form" busy={busy}>{item ? 'Save changes' : 'Log max lift'}</Button></>}
    >
      <form id="lift-form" className="form-stack" onSubmit={submit}>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <div className="form-grid">
          <label className="field"><span>Weight ({exercise?.unit})</span><input type="number" min="0.01" step="any" value={weight} onChange={(event) => setWeight(event.target.value)} placeholder="0.0" required data-modal-autofocus /></label>
          <label className="field"><span>Reps</span><input type="number" min="1" max="1000" step="1" value={reps} onChange={(event) => setReps(event.target.value)} required /></label>
        </div>
        {estimate != null && Number.isFinite(estimate) && <div className="estimate-preview"><BarChart3 size={18} /><span>Estimated 1RM</span><strong>{estimate.toFixed(1)} {exercise?.unit}</strong></div>}
        <label className="field"><span>Date</span><input type="date" value={recordedAt} max={todayInput()} onChange={(event) => setRecordedAt(event.target.value)} required /></label>
        <label className="field"><span>Note <small>Optional</small></span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="RPE, form cues, equipment, or how the set felt..." maxLength={500} rows={4} /></label>
      </form>
    </Modal>
  )
}
