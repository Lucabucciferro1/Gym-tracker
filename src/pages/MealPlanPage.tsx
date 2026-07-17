import {
  Apple,
  Beef,
  Calculator,
  Carrot,
  Flame,
  Gauge,
  Info,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Scale,
  Settings2,
  Trash2,
  Utensils,
  Wheat,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { api, errorMessage } from '../api'
import { calculateBmr, heightToCentimeters, normalizeWeightUnit, weightToKilograms, type BmrFormulaSex, type WeightUnit } from '../bmr'
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Modal, PageHeader } from '../components/ui'
import { useToast } from '../context/ToastContext'
import type { BmrProfile, BmrProfileInput, BodyPart, Meal, MealPlan, MealPlanSettings, Measurement } from '../types'
import { formatDate } from '../utils'
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

function dayLabel(dayOfWeek: number) {
  return DAYS.find((day) => day.value === dayOfWeek)?.label ?? 'Meal day'
}

function formatAmount(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function MealPlanPage() {
  const toast = useToast()
  const bmrEditButtonRef = useRef<HTMLButtonElement>(null)
  const restoreBmrEditFocus = useRef(false)
  const [plan, setPlan] = useState<MealPlan | null>(null)
  const [bmrProfile, setBmrProfile] = useState<BmrProfile | null>(null)
  const [bmrLoading, setBmrLoading] = useState(true)
  const [bmrError, setBmrError] = useState('')
  const [bmrEditorOpen, setBmrEditorOpen] = useState(false)
  const [selectedDay, setSelectedDay] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mealModalOpen, setMealModalOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingMeal, setEditingMeal] = useState<Meal | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Meal | null>(null)
  const [mealFormError, setMealFormError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [savingMeal, setSavingMeal] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')
    try {
      const nextPlan = await api.mealPlan.get()
      setPlan(nextPlan)
      setSelectedDay((current) => nextPlan.days.some((day) => day.dayOfWeek === current)
        ? current
        : nextPlan.days[0]?.dayOfWeek ?? 0)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  const loadBmr = useCallback(async () => {
    setBmrLoading(true)
    setBmrError('')
    try {
      const nextProfile = await api.mealPlan.getBmr()
      setBmrProfile(nextProfile)
      setBmrEditorOpen(nextProfile == null)
    } catch (caught) {
      setBmrError(errorMessage(caught))
    } finally {
      setBmrLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadBmr()
  }, [load, loadBmr])

  useEffect(() => {
    if (!restoreBmrEditFocus.current || bmrEditorOpen || !bmrProfile) return
    restoreBmrEditFocus.current = false
    bmrEditButtonRef.current?.focus()
  }, [bmrEditorOpen, bmrProfile])

  const activeDay = plan?.days.find((day) => day.dayOfWeek === selectedDay) ?? null
  const settings = plan?.settings ?? null
  const weeklyMealCount = plan?.days.reduce((total, day) => total + day.meals.length, 0) ?? 0
  const averageMeals = plan?.days.length ? weeklyMealCount / plan.days.length : 0

  const orderedDays = useMemo(
    () => DAYS.map((definition) => ({
      ...definition,
      plan: plan?.days.find((day) => day.dayOfWeek === definition.value) ?? null,
    })),
    [plan],
  )

  function selectDay(dayOfWeek: number, focus = false) {
    setSelectedDay(dayOfWeek)
    if (focus) {
      window.requestAnimationFrame(() => document.getElementById(`meal-day-tab-${dayOfWeek}`)?.focus())
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

  function openNewMeal() {
    setEditingMeal(null)
    setMealFormError('')
    setMealModalOpen(true)
  }

  function openEditMeal(meal: Meal) {
    setEditingMeal(meal)
    setMealFormError('')
    setMealModalOpen(true)
  }

  async function saveMeal(input: Omit<Meal, 'id' | 'createdAt' | 'updatedAt'>) {
    setSavingMeal(true)
    setMealFormError('')
    try {
      if (editingMeal) await api.mealPlan.updateMeal(editingMeal.id, input)
      else await api.mealPlan.createMeal(input)
      setMealModalOpen(false)
      toast(editingMeal ? `${input.name} updated.` : `${input.name} added to ${dayLabel(input.dayOfWeek)}.`)
      await load(false)
    } catch (caught) {
      setMealFormError(errorMessage(caught))
    } finally {
      setSavingMeal(false)
    }
  }

  async function saveSettings(input: MealPlanSettings) {
    setSavingSettings(true)
    setSettingsError('')
    try {
      await api.mealPlan.updateSettings(input)
      setSettingsOpen(false)
      toast('Nutrition display settings updated.')
      await load(false)
    } catch (caught) {
      setSettingsError(errorMessage(caught))
    } finally {
      setSavingSettings(false)
    }
  }

  async function removeMeal() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const name = deleteTarget.name
      await api.mealPlan.removeMeal(deleteTarget.id)
      setDeleteTarget(null)
      toast(`${name} removed.`)
      await load(false)
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setDeleting(false)
    }
  }

  function closeBmrEditor(nextProfile?: BmrProfile) {
    if (nextProfile) setBmrProfile(nextProfile)
    restoreBmrEditFocus.current = true
    setBmrEditorOpen(false)
  }

  return (
    <div className="page-stack plan-page meal-plan-page">
      <PageHeader
        eyebrow="WEEKLY NUTRITION"
        title="Meal plan"
        description="Plan the meals that support your training, with as much or as little nutrition detail as you want."
        actions={(
          <>
            <Button variant="secondary" icon={<Settings2 size={17} />} disabled={!settings || loading} onClick={() => { setSettingsError(''); setSettingsOpen(true) }}>Display settings</Button>
            <Button icon={<Plus size={17} />} disabled={!activeDay || loading} onClick={openNewMeal}>Add meal</Button>
          </>
        )}
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

      <section className="plan-summary plan-summary--meals panel" aria-label="Weekly meal summary">
        <div className="plan-summary__intro">
          <span className="plan-summary__icon"><Apple size={22} /></span>
          <div>
            <span className="eyebrow">FUEL THE WORK</span>
            <h2>{loading ? 'Preparing your week...' : `${weeklyMealCount} meals planned across the week`}</h2>
            <p>Simple enough to follow, detailed enough to keep you moving toward your goal.</p>
          </div>
        </div>
        <div className="plan-summary__stats">
          <span><strong>{loading ? '-' : weeklyMealCount}</strong><small>Planned meals</small></span>
          <span><strong>{loading ? '-' : averageMeals.toFixed(1)}</strong><small>Daily average</small></span>
          <span><strong>{loading ? '-' : settings?.showCalories ? 'ON' : 'OFF'}</strong><small>Calories</small></span>
          <span><strong>{loading ? '-' : settings?.showMacros ? 'ON' : 'OFF'}</strong><small>Macros</small></span>
          <span className="plan-summary__bmr-stat">
            <strong>{bmrLoading ? '-' : bmrProfile ? bmrProfile.estimatedBmr.toLocaleString() : '-'}</strong>
            <small>BMR kcal/day</small>
            {bmrProfile && !bmrEditorOpen && (
              <button ref={bmrEditButtonRef} type="button" className="plan-summary__stat-action" onClick={() => setBmrEditorOpen(true)} aria-label="Edit saved BMR"><Pencil size={11} /> Edit</button>
            )}
          </span>
        </div>
      </section>

      <BmrCalculator
        profile={bmrProfile}
        loading={bmrLoading}
        error={bmrError}
        editing={bmrEditorOpen}
        onRetry={loadBmr}
        onSaved={(saved) => closeBmrEditor(saved)}
        onCancel={() => closeBmrEditor()}
      />

      <section className="plan-day-tabs" role="tablist" aria-label="Choose meal plan day">
        {orderedDays.map(({ value, label, short, plan: day }, index) => {
          const selected = selectedDay === value
          return (
            <button
              id={`meal-day-tab-${value}`}
              type="button"
              role="tab"
              key={value}
              aria-selected={selected}
              aria-controls="meal-day-panel"
              tabIndex={selected ? 0 : -1}
              className={`plan-day-tab plan-day-tab--meal ${selected ? 'is-active' : ''}`}
              onClick={() => selectDay(value)}
              onKeyDown={(event) => handleDayKeyDown(event, index)}
            >
              <span className="plan-day-tab__short">{short}</span>
              <strong>{label}</strong>
              {loading ? (
                <span className="plan-day-tab__loading" />
              ) : settings?.showCalories && day ? (
                <span className="plan-day-tab__meta"><Flame size={13} /> {formatAmount(day.totals.calories)} kcal</span>
              ) : settings?.showMacros && day ? (
                <span className="plan-day-tab__meta"><Beef size={13} /> {formatAmount(day.totals.protein)}g protein</span>
              ) : (
                <span className="plan-day-tab__meta"><Utensils size={13} /> {day?.meals.length ?? 0} meals</span>
              )}
            </button>
          )
        })}
      </section>

      <section
        id="meal-day-panel"
        className="panel plan-detail-panel meal-detail-panel"
        role="tabpanel"
        aria-labelledby={`meal-day-tab-${selectedDay}`}
        tabIndex={0}
      >
        {loading ? (
          <PlanLoading />
        ) : activeDay && settings ? (
          <>
            <header className="plan-detail-panel__header">
              <div>
                <span className="eyebrow">DAILY PLAN</span>
                <h2>{dayLabel(activeDay.dayOfWeek)}</h2>
                <p>{activeDay.meals.length ? `${activeDay.meals.length} ${activeDay.meals.length === 1 ? 'meal' : 'meals'} ready for the day.` : 'Plan your meals before hunger makes the decisions.'}</p>
              </div>
              <Button icon={<Plus size={16} />} onClick={openNewMeal}>Add meal</Button>
            </header>

            {(settings.showCalories || settings.showMacros) ? (
              <section className="nutrition-total-grid" aria-label={`${dayLabel(activeDay.dayOfWeek)} nutrition totals`}>
                {settings.showCalories && (
                  <NutritionMetric label="Calories" value={activeDay.totals.calories} unit="kcal" target={settings.calorieTarget} icon={<Flame size={18} />} tone="calories" />
                )}
                {settings.showMacros && (
                  <>
                    <NutritionMetric label="Protein" value={activeDay.totals.protein} unit="g" target={settings.proteinTarget} icon={<Beef size={18} />} tone="protein" />
                    <NutritionMetric label="Carbs" value={activeDay.totals.carbs} unit="g" target={settings.carbsTarget} icon={<Wheat size={18} />} tone="carbs" />
                    <NutritionMetric label="Fat" value={activeDay.totals.fat} unit="g" target={settings.fatTarget} icon={<Gauge size={18} />} tone="fat" />
                  </>
                )}
              </section>
            ) : (
              <div className="nutrition-simple-mode"><Carrot size={19} /><span><strong>Simple planning mode</strong><small>Calories and macros are hidden. Turn them on in Display settings whenever they become useful.</small></span><Button variant="ghost" onClick={() => setSettingsOpen(true)}>Change</Button></div>
            )}

            {activeDay.meals.length ? (
              <ol className="meal-card-list">
                {[...activeDay.meals].sort((a, b) => a.sortOrder - b.sortOrder).map((meal, index) => (
                  <li className="meal-card" key={meal.id}>
                    <span className="meal-card__number">{String(index + 1).padStart(2, '0')}</span>
                    <div className="meal-card__body"><h3>{meal.name}</h3>{meal.description && <p>{meal.description}</p>}</div>
                    {(settings.showCalories || settings.showMacros) && (
                      <div className="meal-card__nutrition" aria-label={`Nutrition for ${meal.name}`}>
                        {settings.showCalories && <span><strong>{meal.calories == null ? '-' : formatAmount(meal.calories)}</strong><small>kcal</small></span>}
                        {settings.showMacros && <span><strong>{meal.protein == null ? '-' : `${formatAmount(meal.protein)}g`}</strong><small>protein</small></span>}
                        {settings.showMacros && <span><strong>{meal.carbs == null ? '-' : `${formatAmount(meal.carbs)}g`}</strong><small>carbs</small></span>}
                        {settings.showMacros && <span><strong>{meal.fat == null ? '-' : `${formatAmount(meal.fat)}g`}</strong><small>fat</small></span>}
                      </div>
                    )}
                    <div className="meal-card__actions">
                      <button type="button" className="icon-button" onClick={() => openEditMeal(meal)} aria-label={`Edit ${meal.name}`}><Pencil size={16} /></button>
                      <button type="button" className="icon-button icon-button--danger" onClick={() => setDeleteTarget(meal)} aria-label={`Delete ${meal.name}`}><Trash2 size={16} /></button>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState
                compact
                icon={<Utensils size={23} />}
                title="No meals planned"
                description={`Add breakfast, lunch, dinner, snacks, or anything else that belongs in your ${dayLabel(activeDay.dayOfWeek)}.`}
                action={<Button variant="secondary" icon={<Plus size={16} />} onClick={openNewMeal}>Add first meal</Button>}
              />
            )}
          </>
        ) : (
          <EmptyState compact icon={<RotateCcw size={23} />} title="Day unavailable" description="Refresh the plan to load this day." action={<Button variant="secondary" onClick={() => void load()}>Refresh plan</Button>} />
        )}
      </section>

      <MealModal
        open={mealModalOpen}
        item={editingMeal}
        dayOfWeek={selectedDay}
        nextSortOrder={activeDay ? Math.max(-1, ...activeDay.meals.map((meal) => meal.sortOrder)) + 1 : 0}
        settings={settings}
        error={mealFormError}
        busy={savingMeal}
        onClose={() => { if (!savingMeal) setMealModalOpen(false) }}
        onSave={saveMeal}
      />
      <MealSettingsModal
        open={settingsOpen}
        settings={settings}
        error={settingsError}
        busy={savingSettings}
        onClose={() => { if (!savingSettings) setSettingsOpen(false) }}
        onSave={saveSettings}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Remove ${deleteTarget?.name ?? 'this meal'}?`}
        message="This meal will be permanently removed from the weekly plan."
        confirmLabel="Remove meal"
        busy={deleting}
        onClose={() => { if (!deleting) setDeleteTarget(null) }}
        onConfirm={() => void removeMeal()}
      />
    </div>
  )
}

type WeightSourceMode = 'manual' | 'tracker'

function BmrCalculator({
  profile,
  loading,
  error,
  editing,
  onRetry,
  onSaved,
  onCancel,
}: {
  profile: BmrProfile | null
  loading: boolean
  error: string
  editing: boolean
  onRetry: () => Promise<void>
  onSaved: (profile: BmrProfile) => void
  onCancel: () => void
}) {
  const toast = useToast()
  const firstFieldRef = useRef<HTMLSelectElement>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [bodyParts, setBodyParts] = useState<BodyPart[]>([])
  const [weightSourcesLoading, setWeightSourcesLoading] = useState(false)
  const [weightSourcesLoaded, setWeightSourcesLoaded] = useState(false)
  const [weightSourceError, setWeightSourceError] = useState('')
  const [weightSourceMode, setWeightSourceMode] = useState<WeightSourceMode>('manual')
  const [selectedSourceId, setSelectedSourceId] = useState('')
  const [measurementRecords, setMeasurementRecords] = useState<Measurement[]>([])
  const [measurementRecordsLoading, setMeasurementRecordsLoading] = useState(false)
  const [measurementRecordsError, setMeasurementRecordsError] = useState('')
  const [selectedMeasurementId, setSelectedMeasurementId] = useState('')
  const [sourceFallbackMessage, setSourceFallbackMessage] = useState('')
  const [manualWeight, setManualWeight] = useState('')
  const [manualWeightUnit, setManualWeightUnit] = useState<WeightUnit>('kg')
  const [age, setAge] = useState('')
  const [heightFeet, setHeightFeet] = useState('')
  const [heightInches, setHeightInches] = useState('')
  const [formulaSex, setFormulaSex] = useState<BmrFormulaSex | ''>('')

  useEffect(() => {
    if (!profile || !editing) return
    populateForm(profile)
    window.requestAnimationFrame(() => firstFieldRef.current?.focus())
  }, [editing, profile])

  const formOpen = !profile || editing

  useEffect(() => {
    if (loading || error || !formOpen) return
    let cancelled = false
    setWeightSourcesLoading(true)
    setWeightSourcesLoaded(false)
    setWeightSourceError('')

    void api.bodyParts.list()
      .then((parts) => {
        if (!cancelled) setBodyParts(parts)
      })
      .catch((caught) => {
        if (!cancelled) setWeightSourceError(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) {
          setWeightSourcesLoading(false)
          setWeightSourcesLoaded(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [error, formOpen, loading])

  const weightSources = useMemo(
    () => bodyParts.filter((part) => (
      part.latestValue != null
      && part.latestValue > 0
      && normalizeWeightUnit(part.unit) != null
    )),
    [bodyParts],
  )

  useEffect(() => {
    if (!formOpen || !weightSourcesLoaded || weightSourcesLoading || weightSourceError) return
    if (!weightSources.length) {
      setSelectedSourceId('')
      if (weightSourceMode === 'tracker') fallBackToSavedWeight()
      return
    }

    if (weightSources.some((part) => String(part.id) === selectedSourceId)) return
    if (profile?.weightSource === 'measurement' && editing) {
      setSelectedSourceId('')
      fallBackToSavedWeight()
      return
    }
    const preferred = weightSources.find((part) => part.name.toLowerCase().includes('weight'))
    setSelectedSourceId(String((preferred ?? weightSources[0]).id))
  }, [editing, formOpen, profile, selectedSourceId, weightSourceError, weightSourceMode, weightSources, weightSourcesLoaded, weightSourcesLoading])

  const selectedSource = weightSources.find((part) => String(part.id) === selectedSourceId) ?? null

  useEffect(() => {
    let cancelled = false
    setMeasurementRecords([])
    setSelectedMeasurementId('')
    setMeasurementRecordsError('')

    if (!formOpen || weightSourceMode !== 'tracker' || !selectedSource) {
      setMeasurementRecordsLoading(false)
      return () => {
        cancelled = true
      }
    }

    setMeasurementRecordsLoading(true)
    void api.bodyParts.measurements.list(selectedSource.id)
      .then((records) => {
        if (cancelled) return
        const newestFirst = [...records].sort((a, b) => (
          b.recordedAt.localeCompare(a.recordedAt) || b.id - a.id
        ))
        setMeasurementRecords(newestFirst)
        const savedMeasurementExists = newestFirst.some((record) => String(record.id) === selectedMeasurementId)
        if (savedMeasurementExists) {
          setSelectedMeasurementId(selectedMeasurementId)
        } else if (
          profile?.weightSource === 'measurement'
          && editing
          && profile.bodyPartId === selectedSource.id
          && profile.measurementId != null
        ) {
          fallBackToSavedWeight()
        } else {
          setSelectedMeasurementId(String(newestFirst[0]?.id ?? ''))
        }
      })
      .catch((caught) => {
        if (!cancelled) setMeasurementRecordsError(errorMessage(caught))
      })
      .finally(() => {
        if (!cancelled) setMeasurementRecordsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [editing, formOpen, profile, selectedSource, weightSourceMode])

  const selectedMeasurement = measurementRecords.find((record) => (
    record.bodyPartId === selectedSource?.id && String(record.id) === selectedMeasurementId
  )) ?? null
  const selectedSourceUnit = selectedSource ? normalizeWeightUnit(selectedSource.unit) : null
  const trackerWeightKg = selectedMeasurement && selectedSourceUnit
    ? weightToKilograms(selectedMeasurement.value, selectedSourceUnit)
    : Number.NaN
  const manualWeightValue = manualWeight.trim() ? Number(manualWeight) : Number.NaN
  const manualWeightKg = weightToKilograms(manualWeightValue, manualWeightUnit)
  const weightKg = weightSourceMode === 'tracker' ? trackerWeightKg : manualWeightKg
  const heightCm = heightToCentimeters(
    heightFeet.trim() ? Number(heightFeet) : Number.NaN,
    heightInches.trim() ? Number(heightInches) : Number.NaN,
  )
  const estimate = formulaSex
    ? calculateBmr({
        age: age.trim() ? Number(age) : Number.NaN,
        heightCm: heightCm ?? Number.NaN,
        sex: formulaSex,
        weightKg,
      })
    : null
  const hasAllInputs = Boolean(
    formulaSex
    && age.trim()
    && heightFeet.trim()
    && heightInches.trim()
    && (weightSourceMode === 'tracker' ? selectedMeasurement : manualWeight.trim()),
  )

  function populateForm(nextProfile: BmrProfile) {
    setAge(String(nextProfile.age))
    setFormulaSex(nextProfile.sex)
    setHeightFeet(String(nextProfile.heightFeet))
    setHeightInches(String(nextProfile.heightInches))
    setManualWeight(String(nextProfile.weightValue))
    setManualWeightUnit(nextProfile.weightUnit)
    setWeightSourceMode(nextProfile.weightSource === 'measurement' ? 'tracker' : 'manual')
    setSelectedSourceId(nextProfile.bodyPartId == null ? '' : String(nextProfile.bodyPartId))
    setSelectedMeasurementId(nextProfile.measurementId == null ? '' : String(nextProfile.measurementId))
    setSourceFallbackMessage('')
    setSaveError('')
  }

  function fallBackToSavedWeight() {
    if (!profile) {
      setWeightSourceMode('manual')
      return
    }
    setWeightSourceMode('manual')
    setManualWeight(String(profile.weightValue))
    setManualWeightUnit(profile.weightUnit)
    setSourceFallbackMessage('The original saved check-in is no longer available. Its saved weight has been kept as a manual entry.')
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    if (!formulaSex || estimate == null) return

    const base = {
      age: Number(age),
      sex: formulaSex,
      heightFeet: Number(heightFeet),
      heightInches: Number(heightInches),
    }
    let input: BmrProfileInput
    if (weightSourceMode === 'tracker') {
      if (!selectedSource || !selectedMeasurement) return
      input = {
        ...base,
        weightSource: 'measurement',
        bodyPartId: selectedSource.id,
        measurementId: selectedMeasurement.id,
      }
    } else {
      input = {
        ...base,
        weightSource: 'manual',
        weightValue: Number(manualWeight),
        weightUnit: manualWeightUnit,
      }
    }

    setSaving(true)
    setSaveError('')
    try {
      const saved = await api.mealPlan.saveBmr(input)
      onSaved(saved)
      toast(profile ? 'BMR updated.' : 'BMR saved.')
    } catch (caught) {
      setSaveError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  if (profile && !editing && !loading && !error) return null

  return (
    <section className="panel bmr-calculator" aria-labelledby="bmr-calculator-title">
      <header className="bmr-calculator__header">
        <span className="bmr-calculator__icon"><Calculator size={22} /></span>
        <div>
          <span className="eyebrow">CALORIE BASELINE</span>
          <h2 id="bmr-calculator-title">{profile ? 'Edit BMR' : 'BMR calculator'}</h2>
          <p>Estimate how much energy your body uses each day while at rest.</p>
        </div>
      </header>

      {loading ? (
        <div className="bmr-profile-state" role="status"><LoaderCircle className="spin" size={21} /><span>Loading saved BMR...</span></div>
      ) : error ? (
        <div className="bmr-profile-state"><ErrorNotice message={error} onRetry={() => void onRetry()} /></div>
      ) : (
        <form className="bmr-calculator__form" onSubmit={(event) => void saveProfile(event)}>
          <div className="bmr-calculator__body">
            <div className="bmr-calculator__controls">
              <div className="bmr-calculator__profile-fields">
                <label className="field">
                  <span>Sex used by formula</span>
                  <select ref={firstFieldRef} value={formulaSex} onChange={(event) => setFormulaSex(event.target.value as BmrFormulaSex | '')} required>
                    <option value="">Select</option>
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                  </select>
                </label>
                <label className="field">
                  <span>Age</span>
                  <span className="input-with-suffix"><input type="number" inputMode="numeric" min="18" max="120" step="1" value={age} onChange={(event) => setAge(event.target.value)} placeholder="Years" autoComplete="off" required /><b>years</b></span>
                </label>
                <fieldset className="bmr-height-fields">
                  <legend>Height</legend>
                  <label className="field"><span>Feet</span><span className="input-with-suffix"><input type="number" inputMode="numeric" min="3" max="9" step="1" value={heightFeet} onChange={(event) => setHeightFeet(event.target.value)} placeholder="5" autoComplete="off" required /><b>ft</b></span></label>
                  <label className="field"><span>Inches</span><span className="input-with-suffix"><input type="number" inputMode="decimal" min="0" max="11.99" step="0.1" value={heightInches} onChange={(event) => setHeightInches(event.target.value)} placeholder="10" autoComplete="off" required /><b>in</b></span></label>
                </fieldset>
              </div>

              <fieldset className="bmr-weight-source">
                <legend>Weight source</legend>
                <div className="bmr-weight-source__choices">
                  <label className={`bmr-source-choice ${weightSourceMode === 'tracker' ? 'is-selected' : ''} ${weightSourcesLoaded && !weightSourcesLoading && !weightSources.length ? 'is-disabled' : ''}`}>
                    <input type="radio" name="bmr-weight-source" value="tracker" checked={weightSourceMode === 'tracker'} disabled={weightSourcesLoaded && !weightSourcesLoading && !weightSources.length} onChange={() => { setWeightSourceMode('tracker'); setSourceFallbackMessage('') }} />
                    <Scale size={18} />
                    <span><strong>Measurements tracker</strong><small>Choose a saved tracker and check-in.</small></span>
                  </label>
                  <label className={`bmr-source-choice ${weightSourceMode === 'manual' ? 'is-selected' : ''}`}>
                    <input type="radio" name="bmr-weight-source" value="manual" checked={weightSourceMode === 'manual'} onChange={() => { setWeightSourceMode('manual'); setSourceFallbackMessage('') }} />
                    <Pencil size={18} />
                    <span><strong>Enter manually</strong><small>Save a weight without linking a check-in.</small></span>
                  </label>
                </div>

                {weightSourceMode === 'tracker' ? (
                  <div className="bmr-weight-source__input bmr-weight-source__input--tracker">
                    <label className="field">
                      <span>Weight tracker</span>
                      <select value={selectedSourceId} disabled={weightSourcesLoading || !weightSources.length} onChange={(event) => { setSelectedSourceId(event.target.value); setSelectedMeasurementId('') }}>
                        {weightSourcesLoading && <option value="">Loading measurements...</option>}
                        {!weightSourcesLoading && !weightSources.length && <option value="">No compatible measurements</option>}
                        {weightSources.map((part) => <option value={part.id} key={part.id}>{part.name} - latest {formatAmount(part.latestValue ?? 0)} {part.unit}</option>)}
                      </select>
                    </label>
                    <label className="field">
                      <span>Saved check-in</span>
                      <select value={selectedMeasurementId} disabled={measurementRecordsLoading || !measurementRecords.length} onChange={(event) => setSelectedMeasurementId(event.target.value)}>
                        {measurementRecordsLoading && <option value="">Loading check-ins...</option>}
                        {!measurementRecordsLoading && !measurementRecords.length && <option value="">No check-ins available</option>}
                        {measurementRecords.map((record) => <option value={record.id} key={record.id}>{formatDate(record.recordedAt)} - {formatAmount(record.value)} {selectedSource?.unit}</option>)}
                      </select>
                      <small>The newest check-in is selected automatically.</small>
                    </label>
                  </div>
                ) : (
                  <div className="bmr-weight-source__input bmr-weight-source__input--manual">
                    <label className="field"><span>Weight</span><input type="number" inputMode="decimal" min="1" step="0.1" value={manualWeight} onChange={(event) => setManualWeight(event.target.value)} placeholder="Enter weight" autoComplete="off" required /></label>
                    <label className="field"><span>Unit</span><select value={manualWeightUnit} onChange={(event) => setManualWeightUnit(event.target.value as WeightUnit)}><option value="kg">kg</option><option value="lb">lb</option><option value="st">st (decimal)</option></select></label>
                  </div>
                )}

                {weightSourcesLoaded && !weightSourcesLoading && !weightSources.length && !weightSourceError && <p className="bmr-weight-source__message">No saved measurement has a latest value in kg, lb, or stone yet. Manual entry is ready to use.</p>}
                {weightSourceError && <p className="bmr-weight-source__message bmr-weight-source__message--error" role="alert">Saved measurements could not be loaded. Enter your weight manually instead.</p>}
                {measurementRecordsError && <p className="bmr-weight-source__message bmr-weight-source__message--error" role="alert">That tracker's check-ins could not be loaded. Choose another tracker or enter your weight manually.</p>}
                {sourceFallbackMessage && <p className="bmr-weight-source__message" role="status">{sourceFallbackMessage}</p>}
              </fieldset>
            </div>

            <output className={`bmr-result ${estimate != null ? 'has-estimate' : ''}`} aria-live="polite">
              <span>Estimated BMR</span>
              <strong>{estimate == null ? '—' : estimate.toLocaleString()} <small>kcal/day</small></strong>
              <p>{estimate == null ? (hasAllInputs ? 'Check the supported ranges: age 18-120, height 3-9 ft with 0-11.99 in, and weight 20-500 kg.' : 'Complete the details to see your estimate.') : 'Save this estimate to keep it on your meal planner.'}</p>
            </output>
          </div>

          {saveError && <div className="form-alert bmr-calculator__error" role="alert">{saveError}</div>}
          <div className="bmr-calculator__actions">
            {profile && <Button type="button" variant="secondary" disabled={saving} onClick={onCancel}>Cancel</Button>}
            <Button type="submit" busy={saving} disabled={estimate == null || (weightSourceMode === 'tracker' && !selectedMeasurement)}>{profile ? 'Save changes' : 'Save BMR'}</Button>
          </div>
          <p className="bmr-calculator__note"><Info size={15} />Calculated with the Mifflin–St Jeor equation. This is an estimate of resting energy use, not your total daily calorie requirement.</p>
        </form>
      )}
    </section>
  )
}

function PlanLoading() {
  return (
    <div className="plan-loading" role="status">
      <span className="plan-loading__title" />
      <span className="plan-loading__row" />
      <span className="plan-loading__row" />
      <span className="plan-loading__row" />
      <span className="sr-only">Loading meal plan...</span>
    </div>
  )
}

function NutritionMetric({
  label,
  value,
  unit,
  target,
  icon,
  tone,
}: {
  label: string
  value: number
  unit: string
  target: number | null
  icon: ReactNode
  tone: 'calories' | 'protein' | 'carbs' | 'fat'
}) {
  const percentage = target && target > 0 ? Math.round((value / target) * 100) : null
  return (
    <article className={`nutrition-total nutrition-total--${tone}`}>
      <span className="nutrition-total__icon">{icon}</span>
      <div><span>{label}</span><strong>{formatAmount(value)} <small>{unit}</small></strong><p>{target ? `of ${formatAmount(target)} ${unit} target` : 'No target set'}</p></div>
      {percentage != null && (
        <span
          className="nutrition-total__progress"
          role="progressbar"
          aria-label={`${label}: ${percentage} percent of target`}
          aria-valuenow={Math.min(percentage, 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <i style={{ '--nutrition-progress': `${Math.min(percentage, 100)}%` } as React.CSSProperties} />
          <b>{percentage}%</b>
        </span>
      )}
    </article>
  )
}

function MealModal({
  open,
  item,
  dayOfWeek,
  nextSortOrder,
  settings,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  item: Meal | null
  dayOfWeek: number
  nextSortOrder: number
  settings: MealPlanSettings | null
  error: string
  busy: boolean
  onClose: () => void
  onSave: (input: Omit<Meal, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [targetDay, setTargetDay] = useState(dayOfWeek)
  const [description, setDescription] = useState('')
  const [calories, setCalories] = useState('')
  const [protein, setProtein] = useState('')
  const [carbs, setCarbs] = useState('')
  const [fat, setFat] = useState('')

  useEffect(() => {
    if (!open) return
    setName(item?.name ?? '')
    setTargetDay(item?.dayOfWeek ?? dayOfWeek)
    setDescription(item?.description ?? '')
    setCalories(item?.calories == null ? '' : String(item.calories))
    setProtein(item?.protein == null ? '' : String(item.protein))
    setCarbs(item?.carbs == null ? '' : String(item.carbs))
    setFat(item?.fat == null ? '' : String(item.fat))
  }, [dayOfWeek, item, open])

  function optionalNumber(value: string) {
    return value === '' ? null : Number(value)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    void onSave({
      dayOfWeek: targetDay,
      name: name.trim(),
      description: description.trim() || null,
      calories: settings.showCalories ? optionalNumber(calories) : item?.calories ?? null,
      protein: settings.showMacros ? optionalNumber(protein) : item?.protein ?? null,
      carbs: settings.showMacros ? optionalNumber(carbs) : item?.carbs ?? null,
      fat: settings.showMacros ? optionalNumber(fat) : item?.fat ?? null,
      sortOrder: item?.sortOrder ?? nextSortOrder,
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={dayLabel(targetDay).toUpperCase()}
      title={item ? 'Edit meal' : 'Add a meal'}
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" form="meal-plan-form" busy={busy}>{item ? 'Save changes' : 'Add meal'}</Button>
        </>
      )}
    >
      <form id="meal-plan-form" className="form-stack plan-form" onSubmit={submit}>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <label className="field"><span>Meal name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Greek yoghurt breakfast" maxLength={80} required data-modal-autofocus /></label>
        <label className="field">
          <span>Plan day</span>
          <select value={targetDay} onChange={(event) => setTargetDay(Number(event.target.value))}>
            {DAYS.map((day) => <option value={day.value} key={day.value}>{day.label}</option>)}
          </select>
          <small>Choose another day to move this meal.</small>
        </label>
        <label className="field"><span>Description <small>Optional</small></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Ingredients, preparation, or a simple reminder..." maxLength={500} rows={3} /></label>

        {settings?.showCalories && (
          <section className="plan-form-section plan-form-section--nutrition" aria-labelledby="calorie-input-heading">
            <header><div><span className="eyebrow">ENERGY</span><h3 id="calorie-input-heading">Calories</h3></div></header>
            <label className="field"><span>Calories (kcal) <small>Optional</small></span><input type="number" min="0" step="1" value={calories} onChange={(event) => setCalories(event.target.value)} placeholder="0" /></label>
          </section>
        )}

        {settings?.showMacros && (
          <section className="plan-form-section plan-form-section--nutrition" aria-labelledby="macro-input-heading">
            <header><div><span className="eyebrow">MACRONUTRIENTS</span><h3 id="macro-input-heading">Macros</h3></div></header>
            <div className="nutrition-input-grid">
              <label className="field"><span>Protein (g)</span><input type="number" min="0" step="0.1" value={protein} onChange={(event) => setProtein(event.target.value)} placeholder="0" /></label>
              <label className="field"><span>Carbs (g)</span><input type="number" min="0" step="0.1" value={carbs} onChange={(event) => setCarbs(event.target.value)} placeholder="0" /></label>
              <label className="field"><span>Fat (g)</span><input type="number" min="0" step="0.1" value={fat} onChange={(event) => setFat(event.target.value)} placeholder="0" /></label>
            </div>
          </section>
        )}

        {!settings?.showCalories && !settings?.showMacros && <p className="plan-form-hint"><Carrot size={17} /> Nutrition fields are hidden by your display settings. This meal will be saved with its name and description.</p>}
      </form>
    </Modal>
  )
}

function MealSettingsModal({
  open,
  settings,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  settings: MealPlanSettings | null
  error: string
  busy: boolean
  onClose: () => void
  onSave: (input: MealPlanSettings) => Promise<void>
}) {
  const [showCalories, setShowCalories] = useState(false)
  const [showMacros, setShowMacros] = useState(false)
  const [calorieTarget, setCalorieTarget] = useState('')
  const [proteinTarget, setProteinTarget] = useState('')
  const [carbsTarget, setCarbsTarget] = useState('')
  const [fatTarget, setFatTarget] = useState('')

  useEffect(() => {
    if (!open || !settings) return
    setShowCalories(settings.showCalories)
    setShowMacros(settings.showMacros)
    setCalorieTarget(settings.calorieTarget == null ? '' : String(settings.calorieTarget))
    setProteinTarget(settings.proteinTarget == null ? '' : String(settings.proteinTarget))
    setCarbsTarget(settings.carbsTarget == null ? '' : String(settings.carbsTarget))
    setFatTarget(settings.fatTarget == null ? '' : String(settings.fatTarget))
  }, [open, settings])

  function optionalNumber(value: string) {
    return value === '' ? null : Number(value)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void onSave({
      showCalories,
      showMacros,
      calorieTarget: optionalNumber(calorieTarget),
      proteinTarget: optionalNumber(proteinTarget),
      carbsTarget: optionalNumber(carbsTarget),
      fatTarget: optionalNumber(fatTarget),
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="NUTRITION DISPLAY"
      title="Choose what to track"
      size="medium"
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" form="meal-settings-form" busy={busy}>Save settings</Button>
        </>
      )}
    >
      <form id="meal-settings-form" className="form-stack plan-form" onSubmit={submit}>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <p className="plan-modal-copy">Keep this planner simple, or add nutrition targets when the numbers help you stay consistent. Hidden fields are never shown in meal cards or totals.</p>

        <label className="plan-switch-row">
          <span className="plan-switch-row__icon"><Flame size={19} /></span>
          <span><strong>Show calories</strong><small>Add calories to meals and daily totals.</small></span>
          <input type="checkbox" role="switch" checked={showCalories} onChange={(event) => setShowCalories(event.target.checked)} />
        </label>
        {showCalories && <label className="field plan-target-field"><span>Daily calorie target <small>Optional</small></span><span className="input-with-suffix"><input type="number" min="0" step="1" value={calorieTarget} onChange={(event) => setCalorieTarget(event.target.value)} placeholder="No target" /><b>kcal</b></span></label>}

        <label className="plan-switch-row">
          <span className="plan-switch-row__icon"><Gauge size={19} /></span>
          <span><strong>Show macros</strong><small>Add protein, carbohydrates, and fat.</small></span>
          <input type="checkbox" role="switch" checked={showMacros} onChange={(event) => setShowMacros(event.target.checked)} />
        </label>
        {showMacros && (
          <div className="nutrition-input-grid plan-target-grid">
            <label className="field"><span>Protein target</span><span className="input-with-suffix"><input type="number" min="0" step="0.1" value={proteinTarget} onChange={(event) => setProteinTarget(event.target.value)} placeholder="None" /><b>g</b></span></label>
            <label className="field"><span>Carb target</span><span className="input-with-suffix"><input type="number" min="0" step="0.1" value={carbsTarget} onChange={(event) => setCarbsTarget(event.target.value)} placeholder="None" /><b>g</b></span></label>
            <label className="field"><span>Fat target</span><span className="input-with-suffix"><input type="number" min="0" step="0.1" value={fatTarget} onChange={(event) => setFatTarget(event.target.value)} placeholder="None" /><b>g</b></span></label>
          </div>
        )}
      </form>
    </Modal>
  )
}
