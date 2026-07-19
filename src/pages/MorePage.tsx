import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  LockKeyhole,
  Plus,
  RotateCcw,
  Settings2,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { Button, PageHeader } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  DEFAULT_MOBILE_NAVIGATION,
  MOBILE_NAVIGATION_CATALOG,
  MOBILE_NAVIGATION_MORE,
  availableMobileNavigation,
  normalizeMobileNavigation,
  type MobileNavigationOutletContext,
} from '../mobileNavigation'
import type { MobileNavigationDestination } from '../types'
import { errorMessage } from '../api'
import '../more.css'

function sameOrder(
  first: readonly MobileNavigationDestination[],
  second: readonly MobileNavigationDestination[],
): boolean {
  return first.length === second.length && first.every((item, index) => item === second[index])
}

export function MorePage() {
  const { user } = useAuth()
  const toast = useToast()
  const {
    mobileNavigationItems,
    mobileNavigationLoading,
    mobileNavigationError,
    saveMobileNavigation,
    retryMobileNavigation,
  } = useOutletContext<MobileNavigationOutletContext>()
  const role = user?.role ?? 'user'
  const FixedMoreIcon = MOBILE_NAVIGATION_MORE.icon
  const eligibleDestinations = availableMobileNavigation(role)
  const [editingNavigation, setEditingNavigation] = useState(false)
  const [draftItems, setDraftItems] = useState<MobileNavigationDestination[]>(mobileNavigationItems)
  const [savingNavigation, setSavingNavigation] = useState(false)
  const [navigationFormError, setNavigationFormError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const editButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!editingNavigation) setDraftItems(mobileNavigationItems)
  }, [editingNavigation, mobileNavigationItems])

  const selectedSet = new Set(draftItems)
  const availableToAdd = eligibleDestinations.filter((destination) => !selectedSet.has(destination.key))
  const draftIsComplete = draftItems.length === 4
  const draftChanged = !sameOrder(draftItems, mobileNavigationItems)

  function restoreEditButtonFocus() {
    window.requestAnimationFrame(() => editButtonRef.current?.focus())
  }

  function startEditingNavigation() {
    setDraftItems(mobileNavigationItems)
    setNavigationFormError('')
    setAnnouncement('Bottom navigation editor opened.')
    setEditingNavigation(true)
  }

  function cancelEditingNavigation() {
    setDraftItems(mobileNavigationItems)
    setNavigationFormError('')
    setAnnouncement('Bottom navigation changes cancelled.')
    setEditingNavigation(false)
    restoreEditButtonFocus()
  }

  function moveItem(item: MobileNavigationDestination, destinationIndex: number) {
    const sourceIndex = draftItems.indexOf(item)
    if (sourceIndex < 0) return
    const nextIndex = Math.max(0, Math.min(destinationIndex, draftItems.length - 1))
    if (sourceIndex === nextIndex) return
    const next = [...draftItems]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(nextIndex, 0, moved)
    setDraftItems(next)
    setNavigationFormError('')
    setAnnouncement(`${MOBILE_NAVIGATION_CATALOG[moved].label} moved to position ${nextIndex + 1}.`)
  }

  function removeItem(item: MobileNavigationDestination) {
    setDraftItems((current) => current.filter((candidate) => candidate !== item))
    setNavigationFormError('')
    setAnnouncement(`${MOBILE_NAVIGATION_CATALOG[item].label} removed. Choose another shortcut before saving.`)
  }

  function addItem(item: MobileNavigationDestination) {
    if (draftItems.length >= 4 || selectedSet.has(item)) return
    setDraftItems((current) => [...current, item])
    setNavigationFormError('')
    setAnnouncement(`${MOBILE_NAVIGATION_CATALOG[item].label} added in position ${draftItems.length + 1}.`)
  }

  function restoreDefaults() {
    setDraftItems(normalizeMobileNavigation(DEFAULT_MOBILE_NAVIGATION, role))
    setNavigationFormError('')
    setAnnouncement('Default shortcuts restored in the editor. Save to keep them.')
  }

  async function saveNavigation() {
    if (!draftIsComplete || savingNavigation) return
    setSavingNavigation(true)
    setNavigationFormError('')
    try {
      const saved = await saveMobileNavigation(draftItems)
      setDraftItems(saved)
      setEditingNavigation(false)
      setAnnouncement('Bottom navigation saved.')
      toast('Bottom navigation saved.')
      restoreEditButtonFocus()
    } catch (caught) {
      const message = errorMessage(caught)
      setNavigationFormError(message)
      setAnnouncement(`Could not save bottom navigation: ${message}`)
    } finally {
      setSavingNavigation(false)
    }
  }

  return (
    <div className="page-stack more-page">
      <PageHeader
        eyebrow="MORE"
        title="Customize your Forge"
        description="Choose your mobile shortcuts, or open any feature from one place."
      />

      <section className="panel mobile-nav-settings" aria-labelledby="mobile-nav-settings-title">
        <div className="mobile-nav-settings__header">
          <div>
            <span className="eyebrow">MOBILE APP</span>
            <h2 id="mobile-nav-settings-title">Bottom navigation</h2>
            <p>Choose four shortcuts. More stays in the final position so every feature remains reachable.</p>
          </div>
          {!editingNavigation && (
            <button
              ref={editButtonRef}
              type="button"
              className="button button--secondary"
              onClick={startEditingNavigation}
              disabled={mobileNavigationLoading || Boolean(mobileNavigationError)}
            >
              <Settings2 size={17} />
              Customize
            </button>
          )}
        </div>

        {mobileNavigationError && (
          <div className="mobile-nav-settings__error form-alert" role="alert">
            <span>{mobileNavigationError}</span>
            <Button type="button" variant="secondary" onClick={() => void retryMobileNavigation()}>
              Try again
            </Button>
          </div>
        )}

        <div className="mobile-nav-preview" aria-label="Current bottom navigation">
          {mobileNavigationItems.map((item) => {
            const destination = MOBILE_NAVIGATION_CATALOG[item]
            const Icon = destination.icon
            return (
              <span className="mobile-nav-preview__item" key={item}>
                <Icon size={20} />
                <small>{destination.shortLabel}</small>
              </span>
            )
          })}
          <span className="mobile-nav-preview__item mobile-nav-preview__item--fixed">
            <FixedMoreIcon size={20} />
            <small>More</small>
            <LockKeyhole size={10} aria-label="Always shown" />
          </span>
        </div>

        {mobileNavigationLoading && (
          <p className="mobile-nav-settings__status" role="status">Loading your saved shortcuts...</p>
        )}

        {editingNavigation && (
          <div className="mobile-nav-editor">
            <div className="mobile-nav-editor__heading">
              <div>
                <strong>Choose and order your shortcuts</strong>
                <span className={draftIsComplete ? 'is-complete' : ''}>
                  {draftItems.length} of 4 selected {draftIsComplete && <Check size={13} />}
                </span>
              </div>
              <p>Use the arrow buttons to set their left-to-right order.</p>
            </div>

            {navigationFormError && <div className="form-alert" role="alert">{navigationFormError}</div>}

            <div className="mobile-nav-editor__columns">
              <section aria-labelledby="selected-shortcuts-title">
                <h3 id="selected-shortcuts-title">Shown on the bottom</h3>
                <div className="mobile-nav-editor__list" role="list">
                  {draftItems.map((item, index) => {
                    const destination = MOBILE_NAVIGATION_CATALOG[item]
                    const Icon = destination.icon
                    return (
                      <div className="mobile-nav-editor__item" role="listitem" key={item}>
                        <span className="mobile-nav-editor__position" aria-hidden="true">{index + 1}</span>
                        <span className="mobile-nav-editor__icon"><Icon size={18} /></span>
                        <span className="mobile-nav-editor__label">
                          <strong>{destination.label}</strong>
                          <small>Position {index + 1} of 4</small>
                        </span>
                        <span className="mobile-nav-editor__controls">
                          <button
                            className="icon-button"
                            type="button"
                            onClick={() => moveItem(item, index - 1)}
                            disabled={savingNavigation || index === 0}
                            aria-label={`Move ${destination.label} left`}
                          ><ArrowLeft size={16} /></button>
                          <button
                            className="icon-button"
                            type="button"
                            onClick={() => moveItem(item, index + 1)}
                            disabled={savingNavigation || index === draftItems.length - 1}
                            aria-label={`Move ${destination.label} right`}
                          ><ArrowRight size={16} /></button>
                          <button
                            className="icon-button icon-button--danger"
                            type="button"
                            onClick={() => removeItem(item)}
                            disabled={savingNavigation}
                            aria-label={`Remove ${destination.label} from bottom navigation`}
                          ><X size={16} /></button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </section>

              <section aria-labelledby="available-shortcuts-title">
                <h3 id="available-shortcuts-title">Available shortcuts</h3>
                <div className="mobile-nav-editor__available">
                  {availableToAdd.map((destination) => {
                    const Icon = destination.icon
                    return (
                      <button
                        type="button"
                        key={destination.key}
                        onClick={() => addItem(destination.key)}
                        disabled={savingNavigation || draftItems.length >= 4}
                        aria-label={`Add ${destination.label} to bottom navigation`}
                      >
                        <span className="mobile-nav-editor__icon"><Icon size={18} /></span>
                        <span><strong>{destination.label}</strong><small>{destination.description}</small></span>
                        <Plus size={17} />
                      </button>
                    )
                  })}
                  {availableToAdd.length === 0 && (
                    <p className="mobile-nav-editor__empty">Every available destination is selected.</p>
                  )}
                </div>
              </section>
            </div>

            <div className="mobile-nav-editor__actions">
              <Button
                type="button"
                variant="ghost"
                icon={<RotateCcw size={16} />}
                onClick={restoreDefaults}
                disabled={savingNavigation || sameOrder(draftItems, DEFAULT_MOBILE_NAVIGATION)}
              >
                Restore default
              </Button>
              <span />
              <Button type="button" variant="secondary" onClick={cancelEditingNavigation} disabled={savingNavigation}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void saveNavigation()}
                busy={savingNavigation}
                disabled={!draftIsComplete || !draftChanged}
              >
                Save shortcuts
              </Button>
            </div>
          </div>
        )}

        <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
      </section>

      <section aria-labelledby="all-features-title">
        <div className="more-section-heading">
          <span className="eyebrow">ALL FEATURES</span>
          <h2 id="all-features-title">Everything in Forge</h2>
          <p>Pinned and unpinned pages are always available here.</p>
        </div>
        <div className="more-grid" aria-label="All Forge features">
          {eligibleDestinations.map(({ key, to, label, description, icon: Icon, tone }) => (
            <Link className={`more-card more-card--${tone}`} to={to} key={key}>
              <span className="more-card__icon"><Icon size={22} /></span>
              <span><strong>{label}</strong><small>{description}</small></span>
              <ChevronRight size={18} aria-hidden="true" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  )
}
