import {
  ArrowRight,
  CalendarDays,
  Dumbbell,
  Plus,
  Ruler,
  Sparkles,
  Target,
  Trophy,
} from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, errorMessage } from '../api'
import { ProgressChart } from '../components/ProgressChart'
import { Button, EmptyState, ErrorNotice, MetricCard, PageHeader } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import type { BodyPart, Exercise, Lift, Measurement } from '../types'

interface MeasurementSeries {
  part: BodyPart
  records: Measurement[]
}

interface LiftSeries {
  exercise: Exercise
  records: Lift[]
}

function timeGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function measurementPath(bodyPartId?: number, newRecord = false) {
  const params = new URLSearchParams()
  if (bodyPartId) params.set('part', String(bodyPartId))
  if (newRecord) params.set('new', 'record')
  return `/measurements${params.size ? `?${params}` : ''}`
}

function liftPath(exerciseId?: number, newRecord = false) {
  const params = new URLSearchParams()
  if (exerciseId) params.set('exercise', String(exerciseId))
  if (newRecord) params.set('new', 'record')
  return `/lifts${params.size ? `?${params}` : ''}`
}

export function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [parts, setParts] = useState<BodyPart[]>([])
  const [exercises, setExercises] = useState<Exercise[]>([])
  const [measurementSeries, setMeasurementSeries] = useState<MeasurementSeries[]>([])
  const [liftSeries, setLiftSeries] = useState<LiftSeries[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [bodyParts, exerciseList] = await Promise.all([api.bodyParts.list(), api.exercises.list()])
      const [measurementLists, liftLists] = await Promise.all([
        Promise.all(bodyParts.map((part) => api.bodyParts.measurements.list(part.id))),
        Promise.all(exerciseList.map((exercise) => api.exercises.lifts.list(exercise.id))),
      ])
      setParts(bodyParts)
      setExercises(exerciseList)
      setMeasurementSeries(bodyParts.map((part, index) => ({ part, records: measurementLists[index] })))
      setLiftSeries(exerciseList.map((exercise, index) => ({ exercise, records: liftLists[index] })))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const featuredMeasurement = useMemo(
    () => measurementSeries
      .filter((series) => series.records.length > 0)
      .sort((a, b) => {
        const aDate = a.records.at(-1)?.recordedAt ?? ''
        const bDate = b.records.at(-1)?.recordedAt ?? ''
        return bDate.localeCompare(aDate)
      })[0],
    [measurementSeries],
  )

  const featuredLift = useMemo(
    () => liftSeries
      .filter((series) => series.records.length > 0)
      .sort((a, b) => {
        const aDate = a.records.at(-1)?.recordedAt ?? ''
        const bDate = b.records.at(-1)?.recordedAt ?? ''
        return bDate.localeCompare(aDate)
      })[0],
    [liftSeries],
  )

  const totalMeasurements = measurementSeries.reduce((sum, series) => sum + series.records.length, 0)
  const totalLifts = liftSeries.reduce((sum, series) => sum + series.records.length, 0)
  const latestLiftBest = featuredLift?.records.reduce((best, record) => Math.max(best, record.weight), 0)

  const recentActivity = useMemo(() => {
    const measurements = measurementSeries.flatMap(({ part, records }) =>
      records.map((record) => ({
        id: `m-${record.id}`,
        type: 'measurement' as const,
        title: part.name,
        value: `${record.value} ${part.unit}`,
        recordedAt: record.recordedAt,
        color: part.color,
        targetId: part.id,
      })),
    )
    const lifts = liftSeries.flatMap(({ exercise, records }) =>
      records.map((record) => ({
        id: `l-${record.id}`,
        type: 'lift' as const,
        title: exercise.name,
        value: `${record.weight} ${exercise.unit} x ${record.reps}`,
        recordedAt: record.recordedAt,
        color: exercise.color,
        targetId: exercise.id,
      })),
    )
    return [...measurements, ...lifts]
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
      .slice(0, 6)
  }, [liftSeries, measurementSeries])

  return (
    <div className="page-stack dashboard-page">
      <PageHeader
        eyebrow="YOUR OVERVIEW"
        title={`${timeGreeting()}, ${user?.username ?? 'athlete'}.`}
        description="A clear look at the work you have put in and where you are heading next."
        actions={(
          <div className="quick-actions">
            <Button variant="secondary" icon={<Ruler size={17} />} onClick={() => navigate(measurementPath(featuredMeasurement?.part.id, true))}>Log measurement</Button>
            <Button icon={<Dumbbell size={17} />} onClick={() => navigate(liftPath(featuredLift?.exercise.id, true))}>Log max lift</Button>
          </div>
        )}
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

      <section className="metric-grid" aria-label="Progress summary">
        <MetricCard label="Measurements" value={loading ? '-' : String(totalMeasurements)} detail={`${parts.length} body parts tracked`} icon={<Ruler size={20} />} />
        <MetricCard label="Strength logs" value={loading ? '-' : String(totalLifts)} detail={`${exercises.length} exercises tracked`} icon={<Dumbbell size={20} />} />
        <MetricCard
          label="Latest best"
          value={loading || !latestLiftBest ? '-' : `${latestLiftBest} ${featuredLift.exercise.unit}`}
          detail={featuredLift ? featuredLift.exercise.name : 'Add your first lift'}
          icon={<Trophy size={20} />}
        />
        <MetricCard
          label="Last check-in"
          value={loading || !featuredMeasurement ? '-' : `${featuredMeasurement.records.at(-1)?.value} ${featuredMeasurement.part.unit}`}
          detail={featuredMeasurement?.part.name ?? 'Add your first measurement'}
          icon={<CalendarDays size={20} />}
        />
      </section>

      <section className="dashboard-grid">
        <article className="panel panel--chart">
          <header className="panel__header">
            <div><span className="eyebrow">BODY PROGRESS</span><h2>{featuredMeasurement?.part.name ?? 'Measurements'}</h2></div>
            <button className="text-link" type="button" onClick={() => navigate(measurementPath(featuredMeasurement?.part.id))}>View all <ArrowRight size={15} /></button>
          </header>
          {featuredMeasurement ? (
            <ProgressChart
              data={featuredMeasurement.records.map((record) => ({ recordedAt: record.recordedAt, value: record.value }))}
              color={featuredMeasurement.part.color}
              unit={featuredMeasurement.part.unit}
            />
          ) : (
            <EmptyState
              compact
              icon={<Ruler size={22} />}
              title="No measurements yet"
              description="Record a baseline now and Forge will reveal the trend over time."
              action={<Button variant="secondary" icon={<Plus size={16} />} onClick={() => navigate(measurementPath(undefined, true))}>Add baseline</Button>}
            />
          )}
        </article>

        <article className="panel panel--chart">
          <header className="panel__header">
            <div><span className="eyebrow">STRENGTH PROGRESS</span><h2>{featuredLift?.exercise.name ?? 'Max lifts'}</h2></div>
            <button className="text-link" type="button" onClick={() => navigate(liftPath(featuredLift?.exercise.id))}>View all <ArrowRight size={15} /></button>
          </header>
          {featuredLift ? (
            <ProgressChart
              data={featuredLift.records.map((record) => ({ recordedAt: record.recordedAt, value: record.weight }))}
              color={featuredLift.exercise.color}
              unit={featuredLift.exercise.unit}
            />
          ) : (
            <EmptyState
              compact
              icon={<Dumbbell size={22} />}
              title="No max lifts yet"
              description="Log your current best so every future gain has a starting point."
              action={<Button variant="secondary" icon={<Plus size={16} />} onClick={() => navigate(liftPath(undefined, true))}>Log a max lift</Button>}
            />
          )}
        </article>
      </section>

      <section className="dashboard-bottom-grid">
        <article className="panel recent-panel">
          <header className="panel__header">
            <div><span className="eyebrow">RECENT ACTIVITY</span><h2>Your latest records</h2></div>
          </header>
          {recentActivity.length ? (
            <div className="activity-list">
              {recentActivity.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="activity-row"
                  onClick={() => navigate(item.type === 'lift'
                    ? liftPath(item.targetId)
                    : measurementPath(item.targetId))}
                >
                  <span className="activity-row__icon" style={{ '--item-color': item.color } as React.CSSProperties}>
                    {item.type === 'lift' ? <Dumbbell size={17} /> : <Ruler size={17} />}
                  </span>
                  <span><strong>{item.title}</strong><small>{formatDistanceToNow(parseISO(item.recordedAt), { addSuffix: true })}</small></span>
                  <b>{item.value}</b>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState compact icon={<Sparkles size={21} />} title="Your timeline starts here" description="New records will collect here as you log them." />
          )}
        </article>

        <article className="momentum-card">
          <span className="momentum-card__icon"><Target size={24} /></span>
          <span className="eyebrow">THE FORGE MINDSET</span>
          <h2>Consistency beats intensity.</h2>
          <p>A small record today gives tomorrow's effort context. Keep the chain moving.</p>
          <div className="momentum-card__rule"><span /></div>
        </article>
      </section>
    </div>
  )
}
