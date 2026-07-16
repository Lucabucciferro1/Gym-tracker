import {
  Activity,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Ruler,
  Scale,
  Trash2,
  TrendingDown,
  TrendingUp,
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
import { CHART_COLORS, type BodyPart, type DateRange, type Measurement } from '../types'
import { dateInput, filterByRange, formatDate, percentChange, toIsoDate, todayInput } from '../utils'

type DeleteTarget =
  | { kind: 'part'; item: BodyPart }
  | { kind: 'record'; item: Measurement }
  | null

export function MeasurementsPage() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const [parts, setParts] = useState<BodyPart[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [records, setRecords] = useState<Measurement[]>([])
  const [range, setRange] = useState<DateRange>('90d')
  const [loadingParts, setLoadingParts] = useState(true)
  const [loadingRecords, setLoadingRecords] = useState(false)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [partModalOpen, setPartModalOpen] = useState(false)
  const [recordModalOpen, setRecordModalOpen] = useState(false)
  const [editingPart, setEditingPart] = useState<BodyPart | null>(null)
  const [editingRecord, setEditingRecord] = useState<Measurement | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [isReordering, setIsReordering] = useState(false)
  const [draftParts, setDraftParts] = useState<BodyPart[]>([])
  const [draggedPartId, setDraggedPartId] = useState<number | null>(null)
  const [savingOrder, setSavingOrder] = useState(false)
  const [orderError, setOrderError] = useState('')
  const [orderStatus, setOrderStatus] = useState('')
  const recordRequest = useRef(0)
  const pendingRecordAfterCreate = useRef(false)

  const selectedPart = parts.find((part) => part.id === selectedId) ?? null

  const loadParts = useCallback(async (preferredId?: number) => {
    setLoadingParts(true)
    setError('')
    try {
      const nextParts = await api.bodyParts.list()
      setParts(nextParts)
      setSelectedId((current) => {
        if (preferredId && nextParts.some((part) => part.id === preferredId)) return preferredId
        if (current && nextParts.some((part) => part.id === current)) return current
        return nextParts[0]?.id ?? null
      })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoadingParts(false)
    }
  }, [])

  const loadRecords = useCallback(async (bodyPartId: number) => {
    const requestId = ++recordRequest.current
    setLoadingRecords(true)
    setError('')
    try {
      const nextRecords = await api.bodyParts.measurements.list(bodyPartId)
      if (requestId === recordRequest.current) setRecords(nextRecords)
    } catch (caught) {
      if (requestId === recordRequest.current) setError(errorMessage(caught))
    } finally {
      if (requestId === recordRequest.current) setLoadingRecords(false)
    }
  }, [])

  useEffect(() => {
    void loadParts()
  }, [loadParts])

  useEffect(() => {
    setRecords([])
    if (selectedId) void loadRecords(selectedId)
    else {
      recordRequest.current += 1
      setLoadingRecords(false)
    }
  }, [loadRecords, selectedId])

  useEffect(() => {
    if (loadingParts || searchParams.get('new') !== 'record') return
    if (parts.length) {
      pendingRecordAfterCreate.current = false
      setEditingRecord(null)
      setRecordModalOpen(true)
    } else {
      pendingRecordAfterCreate.current = true
      setEditingPart(null)
      setPartModalOpen(true)
    }
    setSearchParams({}, { replace: true })
  }, [loadingParts, parts.length, searchParams, setSearchParams])

  const filteredRecords = useMemo(() => filterByRange(records, range), [range, records])
  const latest = records.at(-1)
  const previous = records.at(-2)
  const change = latest && previous ? latest.value - previous.value : null
  const changePercent = percentChange(latest?.value, previous?.value)

  function openNewPart() {
    setEditingPart(null)
    setFormError('')
    setPartModalOpen(true)
  }

  function openEditPart() {
    if (!selectedPart) return
    setEditingPart(selectedPart)
    setFormError('')
    setPartModalOpen(true)
  }

  function openNewRecord() {
    if (!selectedPart) {
      openNewPart()
      return
    }
    setEditingRecord(null)
    setFormError('')
    setRecordModalOpen(true)
  }

  async function savePart(input: { name: string; unit: string; color: string }) {
    setSaving(true)
    setFormError('')
    try {
      const saved = editingPart
        ? await api.bodyParts.update(editingPart.id, input)
        : await api.bodyParts.create(input)
      setPartModalOpen(false)
      toast(editingPart ? `${saved.name} updated.` : `${saved.name} added.`)
      await loadParts(saved.id)
      if (!editingPart && pendingRecordAfterCreate.current) {
        pendingRecordAfterCreate.current = false
        setEditingRecord(null)
        setRecordModalOpen(true)
      }
    } catch (caught) {
      setFormError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  async function saveRecord(input: { value: number; recordedAt: string; note?: string | null }) {
    if (!selectedPart) return
    setSaving(true)
    setFormError('')
    try {
      if (editingRecord) {
        await api.bodyParts.measurements.update(selectedPart.id, editingRecord.id, input)
      } else {
        await api.bodyParts.measurements.create(selectedPart.id, input)
      }
      setRecordModalOpen(false)
      toast(editingRecord ? 'Measurement updated.' : 'Measurement logged.')
      await Promise.all([loadRecords(selectedPart.id), loadParts(selectedPart.id)])
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
      if (deleteTarget.kind === 'part') {
        await api.bodyParts.remove(deleteTarget.item.id)
        toast(`${deleteTarget.item.name} removed.`)
        setDeleteTarget(null)
        recordRequest.current += 1
        setRecords([])
        await loadParts()
      } else if (selectedPart) {
        await api.bodyParts.measurements.remove(selectedPart.id, deleteTarget.item.id)
        toast('Measurement deleted.')
        setDeleteTarget(null)
        await Promise.all([loadRecords(selectedPart.id), loadParts(selectedPart.id)])
      }
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setDeleting(false)
    }
  }

  function startReordering() {
    setDraftParts(parts)
    setDraggedPartId(null)
    setOrderError('')
    setOrderStatus('Reorder mode started. Drag items or use the move buttons, then save your changes.')
    setIsReordering(true)
  }

  function cancelReordering() {
    setDraftParts([])
    setDraggedPartId(null)
    setOrderError('')
    setOrderStatus('Order changes cancelled.')
    setIsReordering(false)
  }

  function moveDraftPart(partId: number, destinationIndex: number) {
    const sourceIndex = draftParts.findIndex((part) => part.id === partId)
    if (sourceIndex < 0) return

    const nextIndex = Math.max(0, Math.min(destinationIndex, draftParts.length - 1))
    if (sourceIndex === nextIndex) return

    const next = [...draftParts]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(nextIndex, 0, moved)
    setDraftParts(next)
    setOrderStatus(`${moved.name} moved to position ${nextIndex + 1} of ${next.length}.`)
    setOrderError('')
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, part: BodyPart) {
    setDraggedPartId(part.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(part.id))
    setOrderStatus(`Moving ${part.name}. Drop it on another body part to change its position.`)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, targetIndex: number) {
    event.preventDefault()
    const transferredId = Number(event.dataTransfer.getData('text/plain'))
    const partId = Number.isFinite(transferredId) && transferredId > 0 ? transferredId : draggedPartId
    if (partId != null) {
      const sourceIndex = draftParts.findIndex((part) => part.id === partId)
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
      if (sourceIndex < destinationIndex) destinationIndex -= 1
      moveDraftPart(partId, destinationIndex)
    }
    setDraggedPartId(null)
  }

  async function saveOrder() {
    setSavingOrder(true)
    setOrderError('')
    try {
      const reordered = await api.bodyParts.reorder(draftParts.map((part) => part.id))
      setParts(reordered)
      setIsReordering(false)
      setDraftParts([])
      setDraggedPartId(null)
      setOrderStatus('Body part order saved.')
      toast('Measurement order saved.')
    } catch (caught) {
      const message = errorMessage(caught)
      setOrderError(message)
      setOrderStatus(`Could not save order: ${message}`)
    } finally {
      setSavingOrder(false)
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="BODY PROGRESS"
        title="Measurements"
        description="Track the numbers that matter to you and watch the trend, not the daily noise."
        actions={(
          <>
            {!isReordering && (
              <>
                <Button variant="secondary" icon={<GripVertical size={17} />} onClick={startReordering} disabled={loadingParts || parts.length < 2}>Edit order</Button>
                <Button variant="secondary" icon={<Plus size={17} />} onClick={openNewPart}>Add body part</Button>
                <Button icon={<Ruler size={17} />} onClick={openNewRecord}>Log measurement</Button>
              </>
            )}
          </>
        )}
      />

      {error && <ErrorNotice message={error} onRetry={() => {
        void loadParts(selectedId ?? undefined)
        if (selectedId) {
          setRecords([])
          void loadRecords(selectedId)
        }
      }} />}

      {!loadingParts && parts.length === 0 ? (
        <section className="panel panel--empty-page">
          <EmptyState
            icon={<Ruler size={28} />}
            title="Choose what you want to measure"
            description="Add waist, chest, arms, weight, or any custom body part. You decide the name, unit, and chart colour."
            action={<Button icon={<Plus size={17} />} onClick={openNewPart}>Add your first body part</Button>}
          />
        </section>
      ) : (
        <div className="tracker-layout">
          <aside className="tracker-selector panel">
            <div className="tracker-selector__heading"><span>BODY PARTS</span><small>{parts.length}</small></div>
            {isReordering ? (
              <div className="tracker-reorder">
                <p className="tracker-reorder__hint">Drag body parts into place, or use the arrow buttons.</p>
                {orderError && <div className="tracker-reorder__feedback form-alert" role="alert">{orderError}</div>}
                <div className="tracker-reorder__list" role="list" aria-label="Body part order">
                  {draftParts.map((part, index) => (
                    <div
                      key={part.id}
                      className={`tracker-reorder__item${draggedPartId === part.id ? ' is-dragging' : ''}`}
                      role="listitem"
                      draggable={!savingOrder}
                      onDragStart={(event) => handleDragStart(event, part)}
                      onDragOver={(event) => {
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(event) => handleDrop(event, index)}
                      onDragEnd={() => setDraggedPartId(null)}
                    >
                      <span className="tracker-reorder__grip" aria-hidden="true"><GripVertical size={18} /></span>
                      <span className="series-dot" style={{ backgroundColor: part.color }} />
                      <span className="tracker-reorder__content">
                        <strong>{part.name}</strong>
                        <small>Position {index + 1} of {draftParts.length}</small>
                      </span>
                      <span className="tracker-reorder__controls">
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => moveDraftPart(part.id, index - 1)}
                          disabled={savingOrder || index === 0}
                          aria-label={`Move ${part.name} up`}
                        >
                          <ArrowUp size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => moveDraftPart(part.id, index + 1)}
                          disabled={savingOrder || index === draftParts.length - 1}
                          aria-label={`Move ${part.name} down`}
                        >
                          <ArrowDown size={16} />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="tracker-reorder__actions">
                  <Button variant="secondary" onClick={cancelReordering} disabled={savingOrder}>Cancel</Button>
                  <Button onClick={() => void saveOrder()} busy={savingOrder}>Save order</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="tracker-selector__list">
                  {parts.map((part) => (
                    <button
                      type="button"
                      key={part.id}
                      className={part.id === selectedId ? 'is-active' : ''}
                      aria-pressed={part.id === selectedId}
                      onClick={() => {
                        if (part.id === selectedId) return
                        recordRequest.current += 1
                        setRecords([])
                        setError('')
                        setSelectedId(part.id)
                      }}
                    >
                      <span className="series-dot" style={{ backgroundColor: part.color }} />
                      <span><strong>{part.name}</strong><small>{part.recordCount} {part.recordCount === 1 ? 'record' : 'records'}</small></span>
                      <b>{part.latestValue == null ? '-' : `${part.latestValue} ${part.unit}`}</b>
                    </button>
                  ))}
                </div>
                <Button variant="ghost" icon={<Plus size={16} />} onClick={openNewPart}>Custom body part</Button>
              </>
            )}
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{orderStatus}</span>
          </aside>

          <div className="tracker-main">
            {selectedPart && (
              <>
                <section className="tracker-title-row">
                  <div>
                    <span className="series-dot series-dot--large" style={{ backgroundColor: selectedPart.color }} />
                    <div><span className="eyebrow">CURRENT SERIES</span><h2>{selectedPart.name}</h2></div>
                  </div>
                  <div className="inline-actions">
                    <button className="icon-button" type="button" onClick={openEditPart} disabled={isReordering} aria-label={`Edit ${selectedPart.name}`}><Pencil size={17} /></button>
                    <button className="icon-button icon-button--danger" type="button" onClick={() => setDeleteTarget({ kind: 'part', item: selectedPart })} disabled={isReordering} aria-label={`Delete ${selectedPart.name}`}><Trash2 size={17} /></button>
                  </div>
                </section>

                <section className="metric-grid metric-grid--three">
                  <MetricCard label="Latest" value={latest ? `${latest.value} ${selectedPart.unit}` : '-'} detail={latest ? formatDate(latest.recordedAt) : 'No records yet'} icon={<Scale size={20} />} />
                  <MetricCard
                    label="Last change"
                    value={change == null ? '-' : `${change > 0 ? '+' : ''}${change.toFixed(1)} ${selectedPart.unit}`}
                    detail={previous ? `From ${previous.value} ${selectedPart.unit}` : 'Add two records to compare'}
                    icon={change != null && change < 0 ? <TrendingDown size={20} /> : <TrendingUp size={20} />}
                    trend={changePercent}
                  />
                  <MetricCard label="Check-ins" value={String(records.length)} detail={filteredRecords.length === records.length ? 'All time' : `${filteredRecords.length} in selected range`} icon={<CalendarDays size={20} />} />
                </section>

                <article className="panel panel--chart tracker-chart">
                  <header className="panel__header">
                    <div><span className="eyebrow">PROGRESS OVER TIME</span><h2>{selectedPart.name} trend</h2></div>
                    <RangeSelector value={range} onChange={setRange} />
                  </header>
                  {loadingRecords ? (
                    <div className="chart-skeleton" />
                  ) : filteredRecords.length ? (
                    <ProgressChart
                      data={filteredRecords.map((record) => ({ recordedAt: record.recordedAt, value: record.value }))}
                      color={selectedPart.color}
                      unit={selectedPart.unit}
                    />
                  ) : (
                    <EmptyState compact icon={<Activity size={22} />} title="No records in this range" description="Choose a wider date range or add a new check-in." action={<Button variant="secondary" icon={<Plus size={16} />} onClick={openNewRecord} disabled={isReordering}>Log measurement</Button>} />
                  )}
                </article>

                <article className="panel records-panel">
                  <header className="panel__header">
                    <div><span className="eyebrow">HISTORY</span><h2>Measurement records</h2></div>
                    <Button variant="secondary" icon={<Plus size={16} />} onClick={openNewRecord} disabled={isReordering}>Add record</Button>
                  </header>
                  {records.length ? (
                    <div className="responsive-table">
                      <table>
                        <thead><tr><th>Date</th><th>Measurement</th><th>Note</th><th><span className="sr-only">Actions</span></th></tr></thead>
                        <tbody>
                          {[...records].reverse().map((record) => (
                            <tr key={record.id}>
                              <td data-label="Date"><strong>{formatDate(record.recordedAt)}</strong></td>
                              <td data-label="Measurement"><span className="value-cell">{record.value} <small>{selectedPart.unit}</small></span></td>
                              <td data-label="Note"><span className="note-cell">{record.note || '-'}</span></td>
                              <td className="table-actions">
                                <button type="button" className="icon-button" onClick={() => { setEditingRecord(record); setFormError(''); setRecordModalOpen(true) }} disabled={isReordering} aria-label="Edit measurement"><Pencil size={16} /></button>
                                <button type="button" className="icon-button icon-button--danger" onClick={() => setDeleteTarget({ kind: 'record', item: record })} disabled={isReordering} aria-label="Delete measurement"><Trash2 size={16} /></button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <EmptyState compact icon={<MoreHorizontal size={22} />} title="No check-ins yet" description={`Add your first ${selectedPart.name.toLowerCase()} measurement to establish a baseline.`} action={<Button variant="secondary" onClick={openNewRecord} disabled={isReordering}>Add baseline</Button>} />
                  )}
                </article>
              </>
            )}
          </div>
        </div>
      )}

      <BodyPartModal
        open={partModalOpen}
        item={editingPart}
        error={formError}
        busy={saving}
        onClose={() => {
          setPartModalOpen(false)
          pendingRecordAfterCreate.current = false
        }}
        onSave={savePart}
      />
      <MeasurementModal
        open={recordModalOpen}
        item={editingRecord}
        part={selectedPart}
        error={formError}
        busy={saving}
        onClose={() => setRecordModalOpen(false)}
        onSave={saveRecord}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.kind === 'part' ? `Remove ${deleteTarget.item.name}?` : 'Delete this measurement?'}
        message={deleteTarget?.kind === 'part'
          ? 'This also permanently deletes every measurement saved for this body part.'
          : 'This record will be permanently removed from the chart and history.'}
        busy={deleting}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

function BodyPartModal({
  open,
  item,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  item: BodyPart | null
  error: string
  busy: boolean
  onClose: () => void
  onSave: (input: { name: string; unit: string; color: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [unit, setUnit] = useState('cm')
  const [color, setColor] = useState(CHART_COLORS[0])

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? '')
    setUnit(item?.unit ?? 'cm')
    setColor(item?.color ?? CHART_COLORS[0])
  }, [item, open])

  function submit(event: FormEvent) {
    event.preventDefault()
    void onSave({ name: name.trim(), unit: unit.trim(), color })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="CUSTOM TRACKING"
      title={item ? 'Edit body part' : 'Add a body part'}
      footer={<><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" form="body-part-form" busy={busy}>{item ? 'Save changes' : 'Add body part'}</Button></>}
    >
      <form id="body-part-form" className="form-stack" onSubmit={submit}>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Forearms" maxLength={60} required data-modal-autofocus /></label>
        <div className="form-grid">
          <label className="field">
            <span>Unit</span>
            <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="cm" maxLength={16} required disabled={Boolean(item?.recordCount)} />
            {Boolean(item?.recordCount) && <small>Remove this body part's history before changing its unit.</small>}
          </label>
          <label className="field"><span>Chart colour</span><span className="color-input"><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /><b>{color.toUpperCase()}</b></span></label>
        </div>
        <div className="color-swatches" aria-label="Suggested colours">
          {CHART_COLORS.map((swatch) => <button type="button" key={swatch} className={color === swatch ? 'is-active' : ''} style={{ backgroundColor: swatch }} onClick={() => setColor(swatch)} aria-label={`Use colour ${swatch}`} aria-pressed={color === swatch} />)}
        </div>
      </form>
    </Modal>
  )
}

function MeasurementModal({
  open,
  item,
  part,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  item: Measurement | null
  part: BodyPart | null
  error: string
  busy: boolean
  onClose: () => void
  onSave: (input: { value: number; recordedAt: string; note?: string | null }) => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [recordedAt, setRecordedAt] = useState(todayInput())
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) return
    setValue(item ? String(item.value) : '')
    setRecordedAt(item ? dateInput(item.recordedAt) : todayInput())
    setNote(item?.note ?? '')
  }, [item, open])

  function submit(event: FormEvent) {
    event.preventDefault()
    void onSave({ value: Number(value), recordedAt: toIsoDate(recordedAt), note: note.trim() || null })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={part?.name.toUpperCase()}
      title={item ? 'Edit measurement' : 'Log measurement'}
      footer={<><Button variant="secondary" type="button" onClick={onClose}>Cancel</Button><Button type="submit" form="measurement-form" busy={busy}>{item ? 'Save changes' : 'Log measurement'}</Button></>}
    >
      <form id="measurement-form" className="form-stack" onSubmit={submit}>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <div className="form-grid">
          <label className="field"><span>Value ({part?.unit})</span><input type="number" min="0.01" step="any" value={value} onChange={(event) => setValue(event.target.value)} placeholder="0.0" required data-modal-autofocus /></label>
          <label className="field"><span>Date</span><input type="date" value={recordedAt} max={todayInput()} onChange={(event) => setRecordedAt(event.target.value)} required /></label>
        </div>
        <label className="field"><span>Note <small>Optional</small></span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="How you measured, time of day, or anything useful..." maxLength={500} rows={4} /></label>
      </form>
    </Modal>
  )
}
