import {
  Activity,
  CalendarRange,
  Check,
  ChevronDown,
  CircleUserRound,
  Download,
  Dumbbell,
  Eye,
  EyeOff,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Pencil,
  Plus,
  Ruler,
  ShieldCheck,
  UsersRound,
  Utensils,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, errorMessage } from '../api'
import '../account.css'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  DEFAULT_MOBILE_NAVIGATION,
  MOBILE_NAVIGATION_CATALOG,
  MOBILE_NAVIGATION_MORE,
  navigationPathMatches,
  normalizeMobileNavigation,
  type MobileNavigationOutletContext,
} from '../mobileNavigation'
import { planDayOfWeek } from '../navigationState'
import type { MobileNavigationDestination } from '../types'
import { downloadBlob } from '../utils'
import { Brand, Button, Modal } from './ui'

interface NavigationLink {
  to: string
  label: string
  icon: typeof LayoutDashboard
  end?: boolean
}

const trainingLinks: NavigationLink[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/measurements', label: 'Measurements', icon: Ruler },
  { to: '/lifts', label: 'Max lifts', icon: Dumbbell },
]

const planLinks: NavigationLink[] = [
  { to: '/workout', label: 'Workout plan', icon: CalendarRange },
  { to: '/meals', label: 'Meal plan', icon: Utensils },
]

const socialLinks: NavigationLink[] = [
  { to: '/sharing', label: 'Sharing', icon: UsersRound },
]

const pageLabels: Record<string, string> = {
  '/': 'Dashboard',
  '/measurements': 'Measurements',
  '/lifts': 'Max lifts',
  '/workout': 'Workout plan',
  '/meals': 'Meal plan',
  '/sharing': 'Sharing',
  '/more': 'More',
  '/admin': 'Admin panel',
}

function SidebarLinks({ links }: { links: NavigationLink[] }) {
  return links.map(({ to, label, icon: Icon, end }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      className={({ isActive }) => `sidebar__link ${isActive ? 'is-active' : ''}`}
      aria-label={label}
      title={label}
    >
      <Icon size={19} />
      <span>{label}</span>
      {to === '/admin' && <small>ADMIN</small>}
    </NavLink>
  ))
}

type AccountOrigin = 'sidebar' | 'mobile'
type AccountFocus = 'overview' | 'username' | 'password'

interface AccountModalState {
  origin: AccountOrigin
  focus: AccountFocus
}

export function AppShell() {
  const { user, logout } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountModal, setAccountModal] = useState<AccountModalState | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [mobileNavigationItems, setMobileNavigationItems] = useState<MobileNavigationDestination[]>(
    [...DEFAULT_MOBILE_NAVIGATION],
  )
  const [mobileNavigationLoading, setMobileNavigationLoading] = useState(true)
  const [mobileNavigationError, setMobileNavigationError] = useState('')
  const accountControlRef = useRef<HTMLDivElement>(null)
  const accountButtonRef = useRef<HTMLButtonElement>(null)
  const accountPopoverRef = useRef<HTMLDivElement>(null)
  const mobileAccountButtonRef = useRef<HTMLButtonElement>(null)
  const mobileNavigationRequestRef = useRef(0)
  const isAdmin = user?.role === 'admin'
  const adminLinks = isAdmin ? [{ to: '/admin', label: 'Admin', icon: ShieldCheck }] : []
  const mobileRole = user?.role ?? 'user'

  const loadMobileNavigation = useCallback(async () => {
    if (!user) return
    const requestId = ++mobileNavigationRequestRef.current
    setMobileNavigationLoading(true)
    setMobileNavigationError('')
    try {
      const preference = await api.preferences.getMobileNavigation()
      if (requestId !== mobileNavigationRequestRef.current) return
      setMobileNavigationItems(normalizeMobileNavigation(preference.items, user.role))
    } catch (caught) {
      if (requestId !== mobileNavigationRequestRef.current) return
      setMobileNavigationError(errorMessage(caught))
    } finally {
      if (requestId === mobileNavigationRequestRef.current) setMobileNavigationLoading(false)
    }
  }, [user?.id, user?.role])

  useEffect(() => {
    mobileNavigationRequestRef.current += 1
    setMobileNavigationItems([...DEFAULT_MOBILE_NAVIGATION])
    setMobileNavigationError('')
    if (!user) {
      setMobileNavigationLoading(false)
      return
    }
    void loadMobileNavigation()
    return () => {
      mobileNavigationRequestRef.current += 1
    }
  }, [loadMobileNavigation, user?.id])

  useEffect(() => {
    setAccountOpen(false)
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [location.pathname])

  useEffect(() => {
    if (!accountOpen) return

    accountPopoverRef.current?.querySelector<HTMLButtonElement>('button')?.focus()

    function handlePointerDown(event: PointerEvent) {
      if (!accountControlRef.current?.contains(event.target as Node)) setAccountOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setAccountOpen(false)
      accountButtonRef.current?.focus()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [accountOpen])

  function openAccountModal(focus: AccountFocus, origin: AccountOrigin) {
    setAccountOpen(false)
    setAccountModal({ focus, origin })
  }

  function closeAccountModal() {
    const origin = accountModal?.origin
    setAccountModal(null)
    window.requestAnimationFrame(() => {
      if (origin === 'mobile') mobileAccountButtonRef.current?.focus()
      else accountButtonRef.current?.focus()
    })
  }

  async function handleLogout() {
    if (signingOut) return
    setSigningOut(true)
    setAccountOpen(false)
    try {
      await logout()
    } catch (caught) {
      toast(`${errorMessage(caught)} Your server session may still be active.`, 'error')
    } finally {
      setSigningOut(false)
      setAccountModal(null)
      navigate('/login', { replace: true })
    }
  }

  async function saveMobileNavigation(
    items: MobileNavigationDestination[],
  ): Promise<MobileNavigationDestination[]> {
    const preference = await api.preferences.updateMobileNavigation(items)
    const savedItems = normalizeMobileNavigation(preference.items, mobileRole)
    setMobileNavigationItems(savedItems)
    setMobileNavigationError('')
    return savedItems
  }

  const displayedMobileNavigation = mobileNavigationItems.map(
    (item) => MOBILE_NAVIGATION_CATALOG[item],
  )
  const pinnedMobileDestinationActive = displayedMobileNavigation.some(
    (item) => navigationPathMatches(location.pathname, item.to),
  )
  const MoreIcon = MOBILE_NAVIGATION_MORE.icon
  const today = planDayOfWeek()
  const mobileQuickAction = ({
    '/measurements': {
      to: '/measurements?new=record',
      label: 'Log a measurement',
      icon: Ruler,
    },
    '/lifts': {
      to: '/lifts?new=record',
      label: 'Log a max lift',
      icon: Dumbbell,
    },
    '/workout': {
      to: `/workout?day=${today}&edit=day`,
      label: "Edit today's workout",
      icon: CalendarRange,
    },
    '/meals': {
      to: `/meals?day=${today}&new=meal`,
      label: "Add a meal to today",
      icon: Utensils,
    },
  } as const)[location.pathname]
  const MobileQuickActionIcon = mobileQuickAction?.icon
  const mobileNavigationContext: MobileNavigationOutletContext = {
    mobileNavigationItems,
    mobileNavigationLoading,
    mobileNavigationError,
    saveMobileNavigation,
    retryMobileNavigation: loadMobileNavigation,
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand"><Brand /></div>
        <nav className="sidebar__nav" aria-label="Primary navigation">
          <span className="sidebar__label">Your training</span>
          <SidebarLinks links={trainingLinks} />
          <span className="sidebar__label sidebar__label--section">Plan</span>
          <SidebarLinks links={planLinks} />
          <span className="sidebar__label sidebar__label--section">Community</span>
          <SidebarLinks links={socialLinks} />
          {isAdmin && <span className="sidebar__label sidebar__label--section">Manage</span>}
          <SidebarLinks links={adminLinks} />
        </nav>
        <div className="sidebar__insight">
          <Activity size={19} />
          <div><strong>Small steps add up.</strong><span>Keep logging consistently.</span></div>
        </div>

        <div className="account-control" ref={accountControlRef}>
          <button
            className={`sidebar__account ${accountOpen ? 'is-open' : ''}`}
            type="button"
            ref={accountButtonRef}
            onClick={() => setAccountOpen((current) => !current)}
            aria-label={`Open account menu for ${user?.username ?? 'your account'}`}
            aria-expanded={accountOpen}
            aria-controls="sidebar-account-popover"
            aria-haspopup="true"
            title={`Account menu - ${user?.username ?? ''}`}
          >
            <span className="avatar" aria-hidden="true">{user?.username.charAt(0).toUpperCase()}</span>
            <span><strong>{user?.username}</strong><small>{isAdmin ? 'Administrator' : 'Member'}</small></span>
            <ChevronDown size={17} />
          </button>

          {accountOpen && (
            <div
              className="account-popover"
              id="sidebar-account-popover"
              ref={accountPopoverRef}
              role="group"
              aria-label="Account actions"
            >
              <div className="account-popover__identity">
                <span className="account-popover__avatar" aria-hidden="true">{user?.username.charAt(0).toUpperCase()}</span>
                <span><strong>{user?.username}</strong><small>{isAdmin ? 'Administrator' : 'Member'}</small></span>
              </div>
              <button type="button" onClick={() => openAccountModal('overview', 'sidebar')}>
                <CircleUserRound size={17} />
                <span><strong>Account & data</strong><small>Review your account and records</small></span>
              </button>
              <button type="button" onClick={() => openAccountModal('username', 'sidebar')}>
                <Pencil size={17} />
                <span><strong>Change username</strong><small>Update your sign-in name</small></span>
              </button>
              <button type="button" onClick={() => openAccountModal('password', 'sidebar')}>
                <KeyRound size={17} />
                <span><strong>Change password</strong><small>Update your sign-in password</small></span>
              </button>
              <button
                type="button"
                className="account-popover__danger"
                disabled={signingOut}
                onClick={() => void handleLogout()}
              >
                <LogOut size={17} />
                <span><strong>{signingOut ? 'Signing out...' : 'Sign out'}</strong><small>End this session</small></span>
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="app-main">
        <header className="mobile-header">
          {mobileQuickAction && MobileQuickActionIcon ? (
            <Link
              className="mobile-header__quick-action"
              to={mobileQuickAction.to}
              aria-label={mobileQuickAction.label}
              title={mobileQuickAction.label}
            >
              <Plus size={15} />
              <MobileQuickActionIcon size={19} />
            </Link>
          ) : (
            <Brand compact />
          )}
          <span>{pageLabels[location.pathname] ?? 'Forge'}</span>
          <button
            type="button"
            className="avatar mobile-account-button"
            ref={mobileAccountButtonRef}
            onClick={() => openAccountModal('overview', 'mobile')}
            aria-label={`Open account settings for ${user?.username ?? 'your account'}`}
            aria-haspopup="dialog"
            aria-expanded={Boolean(accountModal)}
            title="Account settings"
          >
            {user?.username.charAt(0).toUpperCase()}
          </button>
        </header>
        <main className="page-content"><Outlet context={mobileNavigationContext} /></main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation" aria-busy={mobileNavigationLoading}>
        {displayedMobileNavigation.map(({ key, to, label, shortLabel, icon: Icon }) => {
          const isActive = navigationPathMatches(location.pathname, to)
          return (
            <Link
              key={key}
              to={to}
              className={isActive ? 'is-active' : ''}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon size={20} />
              <span>{shortLabel}</span>
            </Link>
          )
        })}
        <Link
          to={MOBILE_NAVIGATION_MORE.to}
          className={pinnedMobileDestinationActive ? '' : 'is-active'}
          aria-label={MOBILE_NAVIGATION_MORE.label}
          aria-current={pinnedMobileDestinationActive ? undefined : 'page'}
        >
          <MoreIcon size={20} />
          <span>{MOBILE_NAVIGATION_MORE.shortLabel}</span>
        </Link>
      </nav>

      <AccountModal
        open={Boolean(accountModal)}
        focus={accountModal?.focus ?? 'overview'}
        username={user?.username ?? ''}
        role={isAdmin ? 'Administrator' : 'Member'}
        signingOut={signingOut}
        onClose={closeAccountModal}
        onSignOut={handleLogout}
      />
    </div>
  )
}

function AccountModal({
  open,
  focus,
  username,
  role,
  signingOut,
  onClose,
  onSignOut,
}: {
  open: boolean
  focus: AccountFocus
  username: string
  role: string
  signingOut: boolean
  onClose: () => void
  onSignOut: () => Promise<void>
}) {
  const toast = useToast()
  const { updateUsername } = useAuth()
  const [usernameDraft, setUsernameDraft] = useState(username)
  const [usernameError, setUsernameError] = useState('')
  const [usernameSuccess, setUsernameSuccess] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [formError, setFormError] = useState('')
  const [changingUsername, setChangingUsername] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [exporting, setExporting] = useState(false)
  const overviewRef = useRef<HTMLDivElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const currentPasswordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setUsernameDraft(username)
    setUsernameError('')
    setUsernameSuccess('')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setShowCurrentPassword(false)
    setShowNewPassword(false)
    setFormError('')

    const frame = window.requestAnimationFrame(() => {
      if (focus === 'password') currentPasswordRef.current?.focus()
      else if (focus === 'username') usernameRef.current?.focus()
      else overviewRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focus, open])

  const modalBusy = changingUsername || changingPassword || exporting || signingOut
  const passwordLongEnough = newPassword.length >= 8
  const passwordsMatch = confirmPassword.length > 0 && newPassword === confirmPassword

  function requestClose() {
    if (!modalBusy) onClose()
  }

  async function changeUsername(event: FormEvent) {
    event.preventDefault()
    setUsernameError('')
    setUsernameSuccess('')
    const cleanUsername = usernameDraft.trim()

    if (cleanUsername.length < 2 || cleanUsername.length > 32) {
      setUsernameError('Use between 2 and 32 characters for your username.')
      return
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(cleanUsername)) {
      setUsernameError('Use only letters, numbers, dots, underscores, and hyphens.')
      return
    }
    if (cleanUsername === username) {
      setUsernameError('Enter a different username before saving.')
      return
    }

    setChangingUsername(true)
    try {
      const updatedUser = await updateUsername(cleanUsername)
      setUsernameDraft(updatedUser.username)
      setUsernameSuccess(`Username updated to ${updatedUser.username}. Use it the next time you sign in.`)
      toast(`Username updated to ${updatedUser.username}.`)
    } catch (caught) {
      setUsernameError(errorMessage(caught))
    } finally {
      setChangingUsername(false)
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault()
    setFormError('')
    if (!currentPassword) {
      setFormError('Enter your current password.')
      return
    }
    if (!passwordLongEnough) {
      setFormError('Use at least 8 characters for your new password.')
      return
    }
    if (newPassword === currentPassword) {
      setFormError('Your new password must be different from your current password.')
      return
    }
    if (!passwordsMatch) {
      setFormError('The new passwords do not match.')
      return
    }

    setChangingPassword(true)
    try {
      await api.auth.changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setShowCurrentPassword(false)
      setShowNewPassword(false)
      toast('Password updated. Your other sessions were signed out.')
      overviewRef.current?.focus()
    } catch (caught) {
      setFormError(errorMessage(caught))
    } finally {
      setChangingPassword(false)
    }
  }

  async function exportOwnData() {
    setExporting(true)
    try {
      const blob = await api.exportData()
      const safeUsername = username.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'user'
      const date = new Date().toISOString().slice(0, 10)
      downloadBlob(blob, `forge-${safeUsername}-data-${date}.json`)
      toast('Your private Forge data export is ready.')
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      eyebrow="ACCOUNT & SECURITY"
      title="Your account"
      size="large"
      footer={<Button type="button" variant="secondary" disabled={modalBusy} onClick={requestClose}>Close</Button>}
    >
      <div className="account-modal">
        <div className="account-modal__profile" ref={overviewRef} tabIndex={-1}>
          <span className="account-modal__avatar" aria-hidden="true">{username.charAt(0).toUpperCase()}</span>
          <div><strong>{username}</strong><span>{role} | Private Forge account</span></div>
          <ShieldCheck size={20} aria-hidden="true" />
        </div>

        <div className="account-modal__layout">
          <div className="account-modal__main">
            <section className="account-modal__card" aria-labelledby="username-section-title">
              <div className="account-modal__heading">
                <span className="account-modal__heading-icon"><Pencil size={18} /></span>
                <div><h3 id="username-section-title">Change username</h3><p>This becomes the name you use to sign in.</p></div>
              </div>
              <form className="form-stack" onSubmit={(event) => void changeUsername(event)}>
                {usernameError && <div className="form-alert" role="alert">{usernameError}</div>}
                {usernameSuccess && <div className="account-form-success" role="status"><Check size={15} />{usernameSuccess}</div>}
                <label className="field">
                  <span>Username</span>
                  <input
                    ref={usernameRef}
                    type="text"
                    value={usernameDraft}
                    onChange={(event) => {
                      setUsernameDraft(event.target.value)
                      setUsernameError('')
                      setUsernameSuccess('')
                    }}
                    autoComplete="username"
                    minLength={2}
                    maxLength={32}
                    pattern="[A-Za-z0-9_.-]+"
                    required
                  />
                  <small>Letters, numbers, dots, underscores, and hyphens only.</small>
                </label>
                <Button type="submit" busy={changingUsername} disabled={changingPassword || exporting || signingOut || usernameDraft.trim() === username} icon={<Pencil size={16} />}>
                  Save username
                </Button>
              </form>
            </section>

            <section className="account-modal__card" aria-labelledby="password-section-title">
              <div className="account-modal__heading">
                <span className="account-modal__heading-icon"><KeyRound size={18} /></span>
                <div><h3 id="password-section-title">Change password</h3><p>Updating it signs out every other device.</p></div>
              </div>
              <form className="form-stack" onSubmit={(event) => void changePassword(event)}>
                {formError && <div className="form-alert" role="alert">{formError}</div>}
                <label className="field">
                  <span>Current password</span>
                  <span className="password-input">
                    <input
                      ref={currentPasswordRef}
                      type={showCurrentPassword ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      autoComplete="current-password"
                      maxLength={128}
                      required
                    />
                    <button type="button" onClick={() => setShowCurrentPassword((current) => !current)} aria-label={showCurrentPassword ? 'Hide current password' : 'Show current password'}>
                      {showCurrentPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </span>
                </label>
                <label className="field">
                  <span>New password</span>
                  <span className="password-input">
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                    />
                    <button type="button" onClick={() => setShowNewPassword((current) => !current)} aria-label={showNewPassword ? 'Hide new passwords' : 'Show new passwords'}>
                      {showNewPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </span>
                  <span className={`password-check ${passwordLongEnough ? 'is-valid' : ''}`}><Check size={14} /> At least 8 characters</span>
                </label>
                <label className="field">
                  <span>Confirm new password</span>
                  <input
                    type={showNewPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    maxLength={128}
                    required
                  />
                </label>
                <Button type="submit" busy={changingPassword} disabled={changingUsername || exporting || signingOut} icon={<KeyRound size={16} />}>
                  Update password
                </Button>
              </form>
            </section>
          </div>

          <aside className="account-modal__side" aria-label="Account actions">
            <section className="account-action-card">
              <span className="account-action-card__icon"><Download size={18} /></span>
              <div><h3>Export your data</h3><p>Download your measurements and lift history as a private JSON file.</p></div>
              <Button type="button" variant="secondary" busy={exporting} disabled={changingUsername || changingPassword || signingOut} icon={<Download size={16} />} onClick={() => void exportOwnData()}>
                Export JSON
              </Button>
            </section>
            <section className="account-action-card account-action-card--danger">
              <span className="account-action-card__icon"><LogOut size={18} /></span>
              <div><h3>Sign out</h3><p>End this session on the current device.</p></div>
              <Button type="button" variant="danger" busy={signingOut} disabled={changingUsername || changingPassword || exporting} icon={<LogOut size={16} />} onClick={() => void onSignOut()}>
                Sign out
              </Button>
            </section>
          </aside>
        </div>
      </div>
    </Modal>
  )
}
