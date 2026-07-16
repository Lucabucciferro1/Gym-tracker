import {
  Activity,
  CalendarDays,
  Check,
  Dumbbell,
  Eye,
  LoaderCircle,
  Plus,
  Ruler,
  Share2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Utensils,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
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
} from '../components/ui'
import { useToast } from '../context/ToastContext'
import type {
  ProgressShare,
  SharePermissions,
  SharedLiftSeries,
  SharedMeasurementSeries,
  SharedProgress,
  ShareUser,
  SharingOverview,
} from '../types'
import { estimatedOneRepMax, formatDate } from '../utils'
import '../sharing.css'

type PermissionKey = keyof SharePermissions
type SharedSection = 'measurements' | 'lifts' | 'workout' | 'meals'

interface PermissionDefinition {
  key: PermissionKey
  section: SharedSection
  label: string
  description: string
  icon: ReactNode
}

const PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'shareMeasurements',
    section: 'measurements',
    label: 'Measurements',
    description: 'Body-part trends and history; personal notes stay private',
    icon: <Ruler size={17} />,
  },
  {
    key: 'shareLifts',
    section: 'lifts',
    label: 'Lifts',
    description: 'Exercises, personal bests, and history; notes stay private',
    icon: <Dumbbell size={17} />,
  },
  {
    key: 'shareWorkout',
    section: 'workout',
    label: 'Workout',
    description: 'Weekly sessions and exercises; personal notes stay private',
    icon: <CalendarDays size={17} />,
  },
  {
    key: 'shareMeals',
    section: 'meals',
    label: 'Meals',
    description: 'Meal names and nutrition you display; descriptions stay private',
    icon: <Utensils size={17} />,
  },
]

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function enabledPermissions(share: SharePermissions): PermissionDefinition[] {
  return PERMISSIONS.filter((permission) => share[permission.key])
}

function permissionInput(share: SharePermissions): SharePermissions {
  return {
    shareMeasurements: share.shareMeasurements,
    shareLifts: share.shareLifts,
    shareWorkout: share.shareWorkout,
    shareMeals: share.shareMeals,
  }
}

function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? `Day ${dayOfWeek + 1}`
}

export function SharingPage() {
  const toast = useToast()
  const [overview, setOverview] = useState<SharingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createError, setCreateError] = useState('')
  const [creating, setCreating] = useState(false)
  const [updatingShareId, setUpdatingShareId] = useState<number | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ProgressShare | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [selectedOwnerId, setSelectedOwnerId] = useState<number | null>(null)
  const [sharedProgress, setSharedProgress] = useState<SharedProgress | null>(null)
  const [loadingProgress, setLoadingProgress] = useState(false)
  const [progressError, setProgressError] = useState('')

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')
    try {
      const next = await api.sharing.get()
      setOverview(next)
      setSelectedOwnerId((current) => {
        if (current && next.incomingShares.some((share) => share.owner.id === current)) return current
        return next.incomingShares[0]?.owner.id ?? null
      })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedOwnerId) {
      setSharedProgress(null)
      setProgressError('')
      return
    }

    let ignore = false
    setLoadingProgress(true)
    setProgressError('')
    setSharedProgress(null)
    void api.sharing.getSharedProgress(selectedOwnerId)
      .then((progress) => {
        if (!ignore) setSharedProgress(progress)
      })
      .catch((caught) => {
        if (!ignore) setProgressError(errorMessage(caught))
      })
      .finally(() => {
        if (!ignore) setLoadingProgress(false)
      })

    return () => {
      ignore = true
    }
  }, [selectedOwnerId])

  const outgoingShares = overview?.outgoingShares ?? []
  const incomingShares = overview?.incomingShares ?? []
  const availableUsers = overview?.availableUsers ?? []
  const totalGrantedAreas = outgoingShares.reduce(
    (total, share) => total + enabledPermissions(share).length,
    0,
  )

  async function createShare(viewerUserId: number, permissions: SharePermissions) {
    setCreating(true)
    setCreateError('')
    try {
      const share = await api.sharing.create({ viewerUserId, ...permissions })
      setCreateOpen(false)
      toast(`You are now sharing progress with ${share.viewer.username}.`)
      await load(false)
    } catch (caught) {
      setCreateError(errorMessage(caught))
    } finally {
      setCreating(false)
    }
  }

  async function togglePermission(share: ProgressShare, key: PermissionKey) {
    const nextPermissions = permissionInput(share)
    nextPermissions[key] = !nextPermissions[key]
    if (enabledPermissions(nextPermissions).length === 0) {
      toast('Keep at least one area enabled, or revoke the share instead.', 'error')
      return
    }

    setUpdatingShareId(share.id)
    try {
      const updated = await api.sharing.update(share.id, { [key]: nextPermissions[key] })
      setOverview((current) => current ? {
        ...current,
        outgoingShares: current.outgoingShares.map((item) => item.id === updated.id ? updated : item),
      } : current)
      toast(`${updated.viewer.username}'s permissions were updated.`)
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setUpdatingShareId(null)
    }
  }

  async function revokeShare() {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await api.sharing.remove(revokeTarget.id)
      const username = revokeTarget.viewer.username
      setRevokeTarget(null)
      toast(`Sharing with ${username} was revoked.`)
      await load(false)
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div className="page-stack sharing-page">
      <PageHeader
        eyebrow="FRIENDS & PRIVACY"
        title="Sharing"
        description="Choose exactly which parts of your progress each friend can see. Shared views are read-only and can be revoked at any time."
        actions={(
          <Button
            icon={<UserPlus size={17} />}
            disabled={loading || availableUsers.length === 0}
            title={availableUsers.length ? 'Share with a friend' : 'No additional users are available'}
            onClick={() => { setCreateError(''); setCreateOpen(true) }}
          >
            Share with a friend
          </Button>
        )}
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

      <section className="metric-grid metric-grid--three" aria-label="Sharing overview">
        <MetricCard
          label="Friends you share with"
          value={loading ? '-' : String(outgoingShares.length)}
          detail="You control every permission"
          icon={<Share2 size={20} />}
        />
        <MetricCard
          label="Shared with you"
          value={loading ? '-' : String(incomingShares.length)}
          detail="Read-only friend progress"
          icon={<Eye size={20} />}
        />
        <MetricCard
          label="Areas shared"
          value={loading ? '-' : String(totalGrantedAreas)}
          detail="Across all outgoing shares"
          icon={<ShieldCheck size={20} />}
        />
      </section>

      <section className="sharing-management-grid">
        <article className="panel sharing-panel">
          <header className="panel__header">
            <div><span className="eyebrow">YOU ARE SHARING</span><h2>Friend permissions</h2></div>
            <span className="sharing-count">{outgoingShares.length}</span>
          </header>
          {loading ? (
            <div className="panel-loading" role="status"><LoaderCircle className="spin" size={22} /> Loading shares...</div>
          ) : outgoingShares.length ? (
            <div className="outgoing-share-list">
              {outgoingShares.map((share) => (
                <article className="outgoing-share-card" key={share.id}>
                  <header>
                    <span className="friend-avatar" aria-hidden="true">{share.viewer.username.charAt(0).toUpperCase()}</span>
                    <div><strong>{share.viewer.username}</strong><small>{enabledPermissions(share).length} of 4 areas visible</small></div>
                    <button
                      className="icon-button icon-button--danger"
                      type="button"
                      disabled={updatingShareId !== null || revoking}
                      onClick={() => setRevokeTarget(share)}
                      aria-label={`Revoke sharing with ${share.viewer.username}`}
                      title="Revoke all access"
                    >
                      <Trash2 size={16} />
                    </button>
                  </header>
                  <div className="share-permission-grid" aria-label={`Permissions for ${share.viewer.username}`}>
                    {PERMISSIONS.map((permission) => (
                      <label className="share-permission-toggle" key={permission.key}>
                        <input
                          type="checkbox"
                          checked={share[permission.key]}
                          disabled={updatingShareId !== null || revoking}
                          onChange={() => void togglePermission(share, permission.key)}
                        />
                        <span className="share-permission-toggle__icon">{permission.icon}</span>
                        <span><strong>{permission.label}</strong><small>{share[permission.key] ? 'Visible' : 'Private'}</small></span>
                        {updatingShareId === share.id && <LoaderCircle className="spin share-permission-toggle__busy" size={14} />}
                      </label>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon={<Share2 size={23} />}
              title="Your progress is private"
              description="Add a friend when you are ready, then choose exactly what they can see."
              action={availableUsers.length ? <Button variant="secondary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>Add friend</Button> : undefined}
            />
          )}
        </article>

        <article className="panel sharing-panel incoming-panel">
          <header className="panel__header">
            <div><span className="eyebrow">SHARED WITH YOU</span><h2>Friend progress</h2></div>
            <span className="sharing-count">{incomingShares.length}</span>
          </header>
          {loading ? (
            <div className="panel-loading" role="status"><LoaderCircle className="spin" size={22} /> Loading friends...</div>
          ) : incomingShares.length ? (
            <div className="incoming-share-list">
              {incomingShares.map((share) => (
                <button
                  type="button"
                  className={selectedOwnerId === share.owner.id ? 'is-active' : ''}
                  key={share.id}
                  aria-pressed={selectedOwnerId === share.owner.id}
                  onClick={() => setSelectedOwnerId(share.owner.id)}
                >
                  <span className="friend-avatar" aria-hidden="true">{share.owner.username.charAt(0).toUpperCase()}</span>
                  <span><strong>{share.owner.username}</strong><small>{enabledPermissions(share).map((item) => item.label).join(', ')}</small></span>
                  <Eye size={17} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState compact icon={<Users size={23} />} title="Nothing shared with you yet" description="When a friend gives you access, their read-only progress will appear here." />
          )}
        </article>
      </section>

      {incomingShares.length > 0 && (
        <article className="panel shared-progress-panel">
          {loadingProgress ? (
            <div className="shared-progress-loading" role="status"><LoaderCircle className="spin" size={24} /> Loading your friend's progress...</div>
          ) : progressError ? (
            <ErrorNotice message={progressError} onRetry={() => {
              const ownerId = selectedOwnerId
              setSelectedOwnerId(null)
              window.setTimeout(() => setSelectedOwnerId(ownerId), 0)
            }} />
          ) : sharedProgress ? (
            <SharedProgressView progress={sharedProgress} />
          ) : null}
        </article>
      )}

      <CreateShareModal
        open={createOpen}
        users={availableUsers}
        error={createError}
        busy={creating}
        onClose={() => { if (!creating) setCreateOpen(false) }}
        onSave={createShare}
      />
      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title={`Stop sharing with ${revokeTarget?.viewer.username ?? 'this friend'}?`}
        message="They will immediately lose access to every part of your progress. You can create a new share later."
        confirmLabel="Revoke access"
        busy={revoking}
        onClose={() => { if (!revoking) setRevokeTarget(null) }}
        onConfirm={() => void revokeShare()}
      />
    </div>
  )
}

function CreateShareModal({
  open,
  users,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  users: ShareUser[]
  error: string
  busy: boolean
  onClose: () => void
  onSave: (viewerUserId: number, permissions: SharePermissions) => Promise<void>
}) {
  const [viewerUserId, setViewerUserId] = useState<number | null>(null)
  const [permissions, setPermissions] = useState<SharePermissions>({
    shareMeasurements: true,
    shareLifts: true,
    shareWorkout: false,
    shareMeals: false,
  })
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    if (!open) return
    setViewerUserId(users[0]?.id ?? null)
    setPermissions({ shareMeasurements: true, shareLifts: true, shareWorkout: false, shareMeals: false })
    setLocalError('')
  }, [open, users])

  function submit(event: FormEvent) {
    event.preventDefault()
    setLocalError('')
    if (!viewerUserId) return setLocalError('Choose a friend to share with.')
    if (enabledPermissions(permissions).length === 0) return setLocalError('Choose at least one area to share.')
    void onSave(viewerUserId, permissions)
  }

  function setPermission(key: PermissionKey, value: boolean) {
    setPermissions((current) => ({ ...current, [key]: value }))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="PRIVATE SHARING"
      title="Share with a friend"
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" form="create-share-form" busy={busy} icon={<Share2 size={16} />}>Start sharing</Button>
        </>
      )}
    >
      <form id="create-share-form" className="form-stack" onSubmit={submit}>
        {(localError || error) && <div className="form-alert" role="alert">{localError || error}</div>}
        <label className="field">
          <span>Friend</span>
          <select value={viewerUserId ?? ''} onChange={(event) => setViewerUserId(Number(event.target.value))} required data-modal-autofocus>
            {users.map((user) => <option value={user.id} key={user.id}>{user.username}</option>)}
          </select>
        </label>
        <fieldset className="share-permission-fieldset">
          <legend>Choose what they can see</legend>
          {PERMISSIONS.map((permission) => (
            <label className="share-permission-choice" key={permission.key}>
              <input
                type="checkbox"
                checked={permissions[permission.key]}
                onChange={(event) => setPermission(permission.key, event.target.checked)}
              />
              <span className="share-permission-choice__icon">{permission.icon}</span>
              <span><strong>{permission.label}</strong><small>{permission.description}</small></span>
              <span className="share-permission-choice__check"><Check size={15} /></span>
            </label>
          ))}
        </fieldset>
        <div className="sharing-privacy-note"><ShieldCheck size={18} /><p>Friends receive read-only access. They cannot edit, copy into their account, or share your data onward through Forge.</p></div>
      </form>
    </Modal>
  )
}

function SharedProgressView({ progress }: { progress: SharedProgress }) {
  const allowedSections = useMemo(
    () => PERMISSIONS.filter((permission) => progress.permissions[permission.key]),
    [progress.permissions],
  )
  const [section, setSection] = useState<SharedSection>(allowedSections[0]?.section ?? 'measurements')

  useEffect(() => {
    setSection((current) => allowedSections.some((item) => item.section === current)
      ? current
      : allowedSections[0]?.section ?? 'measurements')
  }, [allowedSections])

  return (
    <div className="shared-progress-view">
      <header className="shared-progress-header">
        <div className="shared-progress-person">
          <span className="friend-avatar friend-avatar--large" aria-hidden="true">{progress.owner.username.charAt(0).toUpperCase()}</span>
          <div><span className="eyebrow">READ-ONLY PROGRESS</span><h2>{progress.owner.username}'s Forge</h2></div>
        </div>
        <span className="read-only-badge"><Eye size={14} /> Read only</span>
      </header>

      <div className="shared-section-tabs" role="tablist" aria-label={`${progress.owner.username}'s shared areas`}>
        {allowedSections.map((permission) => (
          <button
            type="button"
            role="tab"
            key={permission.section}
            aria-selected={section === permission.section}
            className={section === permission.section ? 'is-active' : ''}
            onClick={() => setSection(permission.section)}
          >
            {permission.icon}{permission.label}
          </button>
        ))}
      </div>

      <div className="shared-section-content" role="tabpanel">
        {section === 'measurements' && <SharedMeasurements series={progress.measurements ?? []} />}
        {section === 'lifts' && <SharedLifts series={progress.lifts ?? []} />}
        {section === 'workout' && <SharedWorkout progress={progress} />}
        {section === 'meals' && <SharedMeals progress={progress} />}
      </div>
    </div>
  )
}

function SharedMeasurements({ series }: { series: SharedMeasurementSeries[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    setSelectedId((current) => series.some((item) => item.bodyPart.id === current)
      ? current
      : series[0]?.bodyPart.id ?? null)
  }, [series])

  const selected = series.find((item) => item.bodyPart.id === selectedId) ?? series[0]
  const totalRecords = series.reduce((total, item) => total + item.records.length, 0)

  if (!series.length) {
    return <EmptyState compact icon={<Ruler size={23} />} title="No shared measurements" description="This friend has allowed measurements, but has not logged any series yet." />
  }

  return (
    <div className="shared-data-stack">
      <div className="shared-mini-summary">
        <span><strong>{series.length}</strong><small>Body parts</small></span>
        <span><strong>{totalRecords}</strong><small>Check-ins</small></span>
        <span><strong>{selected?.bodyPart.latestValue ?? '-'}</strong><small>{selected ? `Latest ${selected.bodyPart.unit}` : 'Latest'}</small></span>
      </div>
      <div className="shared-series-layout">
        <div className="shared-series-picker" role="group" aria-label="Shared measurement series">
          {series.map((item) => (
            <button
              type="button"
              key={item.bodyPart.id}
              className={item.bodyPart.id === selected?.bodyPart.id ? 'is-active' : ''}
              aria-pressed={item.bodyPart.id === selected?.bodyPart.id}
              onClick={() => setSelectedId(item.bodyPart.id)}
            >
              <span className="series-dot" style={{ backgroundColor: item.bodyPart.color }} />
              <span><strong>{item.bodyPart.name}</strong><small>{item.records.length} records</small></span>
              <b>{item.bodyPart.latestValue == null ? '-' : `${item.bodyPart.latestValue} ${item.bodyPart.unit}`}</b>
            </button>
          ))}
        </div>
        <div className="shared-series-main">
          <header><div><span className="eyebrow">MEASUREMENT TREND</span><h3>{selected?.bodyPart.name}</h3></div><span className="read-only-badge">View only</span></header>
          {selected?.records.length ? (
            <ProgressChart
              data={selected.records.map((record) => ({ recordedAt: record.recordedAt, value: record.value }))}
              color={selected.bodyPart.color}
              unit={selected.bodyPart.unit}
            />
          ) : (
            <EmptyState compact icon={<Activity size={21} />} title="No check-ins yet" description="There is no history in this shared series." />
          )}
          {selected?.records.length ? (
            <div className="shared-record-list" aria-label={`Recent ${selected.bodyPart.name} measurements`}>
              {[...selected.records].reverse().slice(0, 6).map((record) => (
                <div key={record.id}><time dateTime={record.recordedAt}>{formatDate(record.recordedAt)}</time><strong>{record.value} {selected.bodyPart.unit}</strong><span>Notes stay private</span></div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SharedLifts({ series }: { series: SharedLiftSeries[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    setSelectedId((current) => series.some((item) => item.exercise.id === current)
      ? current
      : series[0]?.exercise.id ?? null)
  }, [series])

  const selected = series.find((item) => item.exercise.id === selectedId) ?? series[0]
  const totalRecords = series.reduce((total, item) => total + item.records.length, 0)
  const best = selected?.records.reduce((highest, record) => Math.max(highest, record.weight), 0) ?? 0

  if (!series.length) {
    return <EmptyState compact icon={<Dumbbell size={23} />} title="No shared lifts" description="This friend has allowed lifts, but has not logged an exercise yet." />
  }

  return (
    <div className="shared-data-stack">
      <div className="shared-mini-summary">
        <span><strong>{series.length}</strong><small>Exercises</small></span>
        <span><strong>{totalRecords}</strong><small>Lift records</small></span>
        <span><strong>{best || '-'}</strong><small>{selected ? `Best ${selected.exercise.unit}` : 'Best'}</small></span>
      </div>
      <div className="shared-series-layout">
        <div className="shared-series-picker" role="group" aria-label="Shared exercise series">
          {series.map((item) => (
            <button
              type="button"
              key={item.exercise.id}
              className={item.exercise.id === selected?.exercise.id ? 'is-active' : ''}
              aria-pressed={item.exercise.id === selected?.exercise.id}
              onClick={() => setSelectedId(item.exercise.id)}
            >
              <span className="series-dot" style={{ backgroundColor: item.exercise.color }} />
              <span><strong>{item.exercise.name}</strong><small>{item.exercise.category}</small></span>
              <b>{item.exercise.personalBest == null ? '-' : `${item.exercise.personalBest} ${item.exercise.unit}`}</b>
            </button>
          ))}
        </div>
        <div className="shared-series-main">
          <header><div><span className="eyebrow">STRENGTH TREND</span><h3>{selected?.exercise.name}</h3></div><span className="read-only-badge">View only</span></header>
          {selected?.records.length ? (
            <ProgressChart
              data={selected.records.map((record) => ({ recordedAt: record.recordedAt, value: record.weight, secondary: estimatedOneRepMax(record.weight, record.reps) }))}
              color={selected.exercise.color}
              unit={selected.exercise.unit}
              secondaryLabel="Estimated 1RM"
            />
          ) : (
            <EmptyState compact icon={<Activity size={21} />} title="No lifts yet" description="There is no history in this shared exercise." />
          )}
          {selected?.records.length ? (
            <div className="shared-record-list" aria-label={`Recent ${selected.exercise.name} lifts`}>
              {[...selected.records].reverse().slice(0, 6).map((record) => (
                <div key={record.id}><time dateTime={record.recordedAt}>{formatDate(record.recordedAt)}</time><strong>{record.weight} {selected.exercise.unit} x {record.reps}</strong><span>{record.note || `Est. 1RM ${estimatedOneRepMax(record.weight, record.reps).toFixed(1)} ${selected.exercise.unit}`}</span></div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SharedWorkout({ progress }: { progress: SharedProgress }) {
  const days = progress.workoutPlan?.days ?? []
  const exerciseCount = days.reduce((total, day) => total + day.exercises.length, 0)

  if (!days.length) {
    return <EmptyState compact icon={<CalendarDays size={23} />} title="No shared workout plan" description="This friend has allowed workout access, but has not built their weekly plan yet." />
  }

  return (
    <div className="shared-data-stack">
      <div className="shared-mini-summary">
        <span><strong>{days.filter((day) => !day.isRest).length}</strong><small>Training days</small></span>
        <span><strong>{days.filter((day) => day.isRest).length}</strong><small>Rest days</small></span>
        <span><strong>{exerciseCount}</strong><small>Exercises</small></span>
      </div>
      <div className="shared-week-grid">
        {days.map((day) => (
          <article className={`shared-day-card ${day.isRest ? 'shared-day-card--rest' : ''}`} key={day.dayOfWeek}>
            <header><div><span>{dayName(day.dayOfWeek)}</span><h3>{day.name}</h3></div><span>{day.isRest ? 'Rest' : `${day.exercises.length} exercises`}</span></header>
            {day.notes && <p>{day.notes}</p>}
            {day.exercises.length ? (
              <ul>{day.exercises.map((exercise, index) => <li key={`${exercise.name}-${index}`}><span><strong>{exercise.name}</strong>{exercise.notes && <small>{exercise.notes}</small>}</span><b>{exercise.sets} x {exercise.reps}</b></li>)}</ul>
            ) : <small className="shared-day-card__empty">Recovery day</small>}
          </article>
        ))}
      </div>
    </div>
  )
}

function SharedMeals({ progress }: { progress: SharedProgress }) {
  const plan = progress.mealPlan
  const days = plan?.days ?? []
  const mealCount = days.reduce((total, day) => total + day.meals.length, 0)

  if (!plan || !days.length) {
    return <EmptyState compact icon={<Utensils size={23} />} title="No shared meal plan" description="This friend has allowed meal access, but has not built their plan yet." />
  }

  return (
    <div className="shared-data-stack">
      <div className="shared-mini-summary">
        <span><strong>{mealCount}</strong><small>Planned meals</small></span>
        <span><strong>{plan.settings.showCalories ? plan.settings.calorieTarget ?? '-' : 'Private'}</strong><small>Daily calories</small></span>
        <span><strong>{plan.settings.showMacros ? plan.settings.proteinTarget ?? '-' : 'Private'}</strong><small>Protein target (g)</small></span>
      </div>
      <div className="shared-week-grid shared-week-grid--meals">
        {days.map((day) => (
          <article className="shared-day-card shared-meal-day" key={day.dayOfWeek}>
            <header>
              <div><span>MEAL PLAN</span><h3>{dayName(day.dayOfWeek)}</h3></div>
              {plan.settings.showCalories && <span>{day.totals.calories} kcal</span>}
            </header>
            {day.meals.length ? (
              <ul>{day.meals.map((meal) => (
                <li key={meal.id}>
                  <span><strong>{meal.name}</strong>{meal.description && <small>{meal.description}</small>}</span>
                  <b>{plan.settings.showCalories && meal.calories != null ? `${meal.calories} kcal` : ''}</b>
                  {plan.settings.showMacros && <small className="meal-macros">P {meal.protein ?? '-'} / C {meal.carbs ?? '-'} / F {meal.fat ?? '-'}</small>}
                </li>
              ))}</ul>
            ) : <small className="shared-day-card__empty">No meals planned</small>}
            {plan.settings.showMacros && day.meals.length > 0 && <footer>P {day.totals.protein}g · C {day.totals.carbs}g · F {day.totals.fat}g</footer>}
          </article>
        ))}
      </div>
    </div>
  )
}
