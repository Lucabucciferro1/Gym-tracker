import {
  Activity,
  Check,
  Copy,
  Download,
  Dumbbell,
  KeyRound,
  LoaderCircle,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Ruler,
  ShieldCheck,
  TicketCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { api, errorMessage } from '../api'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  MetricCard,
  Modal,
  PageHeader,
} from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import type { AdminOverview, AuditEvent, User } from '../types'
import { downloadBlob } from '../utils'
import '../sharing.css'

const RECENT_AUDIT_LIMIT = 10

interface InviteResult {
  username: string
  inviteCode: string
  kind: 'created' | 'reset'
}

function userIsActive(user: User): boolean {
  return user.isActive ?? user.active ?? true
}

function relativeTime(value?: string | null): string {
  if (!value) return 'Never'
  try {
    return formatDistanceToNow(parseISO(value), { addSuffix: true })
  } catch {
    return 'Unknown'
  }
}

function exactTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function auditTarget(event: AuditEvent): string | null {
  const username = event.metadata?.username
  if (typeof username === 'string' && username.trim()) return username
  const name = event.metadata?.name
  if (typeof name === 'string' && name.trim()) return name
  return null
}

function auditSummary(event: AuditEvent): string {
  const actor = event.actorUsername ?? 'System'
  const target = auditTarget(event)

  switch (event.action) {
    case 'system.setup': return `Forge was configured and the ${target ?? 'administrator'} account was created.`
    case 'auth.login': return `${actor} signed in.`
    case 'auth.logout': return `${actor} signed out.`
    case 'auth.login_failed': return `A sign-in attempt for ${target ?? 'an unknown user'} failed.`
    case 'auth.login_disabled': return `${actor} tried to sign in to a disabled account.`
    case 'auth.password_changed': return `${actor} changed their password.`
    case 'auth.username_changed': return `${actor} changed their username.`
    case 'auth.account_activated': return `${actor} activated their invited account.`
    case 'admin.user_created': return `${actor} created the ${target ?? 'new user'} account.`
    case 'admin.invite_reset': return `${actor} issued a new invite for ${target ?? 'a user account'}.`
    case 'admin.user_activated': return `${actor} enabled ${target ?? 'a user account'}.`
    case 'admin.user_disabled': return `${actor} disabled ${target ?? 'a user account'}.`
    case 'admin.password_reset': return `${actor} reset ${target ?? 'a user'}'s password.`
    case 'admin.user_deleted': return `${actor} permanently deleted ${target ?? 'a user account'}.`
    case 'body_part.created': return `${actor} added ${target ?? 'a body measurement'} to their tracker.`
    case 'body_part.updated': return `${actor} updated a body measurement.`
    case 'body_part.deleted': return `${actor} removed ${target ?? 'a body measurement'} from their tracker.`
    case 'measurement.created': return `${actor} logged a measurement.`
    case 'measurement.updated': return `${actor} edited a measurement.`
    case 'measurement.deleted': return `${actor} deleted a measurement.`
    case 'exercise.created': return `${actor} added ${target ?? 'an exercise'} to their tracker.`
    case 'exercise.updated': return `${actor} updated an exercise.`
    case 'exercise.deleted': return `${actor} removed ${target ?? 'an exercise'} from their tracker.`
    case 'lift.created': return `${actor} logged a max lift.`
    case 'lift.updated': return `${actor} edited a max lift.`
    case 'lift.deleted': return `${actor} deleted a max lift.`
    default: {
      const readableAction = event.action.replace(/[._-]+/g, ' ')
      return `${actor}: ${readableAction}.`
    }
  }
}

function auditPresentation(event: AuditEvent): { icon: ReactNode; tone: string } {
  if (event.action.startsWith('admin.') || event.action.startsWith('system.')) {
    return { icon: <ShieldCheck size={17} />, tone: 'security' }
  }
  if (event.action.startsWith('auth.')) {
    return { icon: <KeyRound size={17} />, tone: 'auth' }
  }
  if (event.action.startsWith('body_part.') || event.action.startsWith('measurement.')) {
    return { icon: <Ruler size={17} />, tone: 'measurement' }
  }
  if (event.action.startsWith('exercise.') || event.action.startsWith('lift.')) {
    return { icon: <Dumbbell size={17} />, tone: 'lift' }
  }
  return { icon: <Activity size={17} />, tone: 'neutral' }
}

export function AdminPage() {
  const { user: currentUser } = useAuth()
  const toast = useToast()
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [audit, setAudit] = useState<AuditEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formError, setFormError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<User | null>(null)
  const [disableTarget, setDisableTarget] = useState<User | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [statusBusyId, setStatusBusyId] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [showAllAudit, setShowAllAudit] = useState(false)

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true)
    setError('')
    try {
      const [nextOverview, nextUsers, nextAudit] = await Promise.all([
        api.admin.overview(),
        api.admin.users(),
        api.admin.audit(),
      ])
      setOverview(nextOverview)
      setUsers(nextUsers)
      setAudit(nextAudit)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visibleAudit = useMemo(
    () => showAllAudit ? audit : audit.slice(0, RECENT_AUDIT_LIMIT),
    [audit, showAllAudit],
  )

  const totalTrainingRecords = overview
    ? overview.records.measurements + overview.records.lifts
    : 0

  async function createUser(input: { username: string }) {
    setSaving(true)
    setFormError('')
    try {
      const created = await api.admin.createUser(input)
      setCreateOpen(false)
      setInviteResult({
        username: created.user.username,
        inviteCode: created.inviteCode,
        kind: 'created',
      })
      toast(`Invite created for ${created.user.username}.`)
      await load(false)
    } catch (caught) {
      setFormError(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  async function setUserStatus(target: User, isActive: boolean) {
    if (target.id === currentUser?.id) {
      toast('Use your account settings for changes to your own access.', 'error')
      return
    }
    setStatusBusyId(target.id)
    try {
      const updated = await api.admin.setUserStatus(target.id, isActive)
      setDisableTarget(null)
      toast(`${updated.username} ${isActive ? 'enabled' : 'disabled'}.`)
      await load(false)
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setStatusBusyId(null)
    }
  }

  async function resetAccess() {
    if (!resetTarget) return
    setResetting(true)
    try {
      const reset = await api.admin.resetInvite(resetTarget.id)
      const username = reset.user.username
      setResetTarget(null)
      setInviteResult({ username, inviteCode: reset.inviteCode, kind: 'reset' })
      toast(`A new invite was issued for ${username}.`)
      await load(false)
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setResetting(false)
    }
  }

  async function deleteUser() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.admin.removeUser(deleteTarget.id)
      const username = deleteTarget.username
      setDeleteTarget(null)
      toast(`${username} and all of their data were deleted.`)
      await load(false)
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setDeleting(false)
    }
  }

  async function exportOwnData() {
    setExporting(true)
    try {
      const blob = await api.exportData()
      const username = (currentUser?.username ?? 'user').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
      const date = new Date().toISOString().slice(0, 10)
      downloadBlob(blob, `forge-${username}-data-${date}.json`)
      toast('Your private Forge data export is ready.')
    } catch (caught) {
      toast(errorMessage(caught), 'error')
    } finally {
      setExporting(false)
    }
  }

  const anyMutationBusy = saving || resetting || deleting || statusBusyId !== null

  return (
    <div className="page-stack admin-page">
      <PageHeader
        eyebrow="ADMINISTRATION"
        title="Admin panel"
        description="Manage account access, review activity, and keep Forge secure. Training data remains private to each user."
        actions={(
          <>
            <Button
              variant="secondary"
              icon={<Download size={17} />}
              busy={exporting}
              onClick={() => void exportOwnData()}
            >
              Export my data
            </Button>
            <Button icon={<UserPlus size={17} />} onClick={() => { setFormError(''); setCreateOpen(true) }}>
              Add user
            </Button>
          </>
        )}
      />

      {error && <ErrorNotice message={error} onRetry={() => void load()} />}

      <section className="metric-grid admin-summary-grid" aria-label="Admin overview">
        <MetricCard
          label="Total users"
          value={loading || !overview ? '-' : String(overview.users.total)}
          detail={overview ? `${overview.users.admins} ${overview.users.admins === 1 ? 'administrator' : 'administrators'}` : 'Loading accounts'}
          icon={<Users size={20} />}
        />
        <MetricCard
          label="Active users"
          value={loading || !overview ? '-' : String(overview.users.active)}
          detail={overview ? `${overview.users.pending} pending / ${overview.users.disabled} disabled` : 'Loading account status'}
          icon={<UserCheck size={20} />}
        />
        <MetricCard
          label="Training records"
          value={loading || !overview ? '-' : String(totalTrainingRecords)}
          detail={overview ? `${overview.records.measurements} measurements / ${overview.records.lifts} lifts` : 'Loading records'}
          icon={<Activity size={20} />}
        />
        <MetricCard
          label="Active sessions"
          value={loading || !overview ? '-' : String(overview.activeSessions)}
          detail="Currently signed-in devices"
          icon={<MonitorSmartphone size={20} />}
        />
      </section>

      <section className="admin-layout">
        <article className="panel admin-user-panel">
          <header className="panel__header">
            <div>
              <span className="eyebrow">USER ACCESS</span>
              <h2>Accounts</h2>
            </div>
            <span className="panel__subcopy">{loading ? 'Loading...' : `${users.length} ${users.length === 1 ? 'account' : 'accounts'}`}</span>
          </header>

          {loading ? (
            <div className="panel-loading" role="status"><LoaderCircle className="spin" size={22} /> Loading accounts...</div>
          ) : users.length ? (
            <div className="responsive-table user-table">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Records</th>
                    <th>Last sign-in</th>
                    <th><span className="sr-only">Account actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((account) => {
                    const active = userIsActive(account)
                    const invitePending = Boolean(account.requiresPasswordSetup)
                    const isSelf = account.id === currentUser?.id
                    const recordCount = (account.measurementCount ?? 0) + (account.liftCount ?? 0)
                    const actionDisabled = anyMutationBusy || isSelf
                    return (
                      <tr key={account.id}>
                        <td data-label="User">
                          <span className="user-cell">
                            <span className="user-avatar" aria-hidden="true">{account.username.slice(0, 1).toUpperCase()}</span>
                            <span>
                              <strong>{account.username}</strong>
                              <small>Joined {relativeTime(account.createdAt)}</small>
                            </span>
                            {isSelf && <span className="you-badge">YOU</span>}
                          </span>
                        </td>
                        <td data-label="Role"><span className={`role-badge role-badge--${account.role}`}>{account.role === 'admin' ? <ShieldCheck size={13} /> : <Users size={13} />}{account.role === 'admin' ? 'Admin' : 'Member'}</span></td>
                        <td data-label="Status"><span className={`status-badge status-badge--${!active ? 'disabled' : invitePending ? 'pending' : 'active'}`}><span />{!active ? 'Disabled' : invitePending ? 'Invite pending' : 'Active'}</span></td>
                        <td data-label="Records">
                          <span className="record-count-cell">
                            <strong>{recordCount}</strong>
                            <small>{account.measurementCount ?? 0} measurements / {account.liftCount ?? 0} lifts</small>
                          </span>
                        </td>
                        <td data-label="Last sign-in"><time dateTime={account.lastLoginAt ?? undefined} title={account.lastLoginAt ? exactTime(account.lastLoginAt) : undefined}>{relativeTime(account.lastLoginAt)}</time></td>
                        <td className="table-actions user-actions">
                          <button
                            type="button"
                            className="icon-button"
                            disabled={actionDisabled}
                            onClick={() => active ? setDisableTarget(account) : void setUserStatus(account, true)}
                            aria-label={isSelf ? 'You cannot change your own account status here' : `${active ? 'Disable' : 'Enable'} ${account.username}`}
                            title={isSelf ? 'Your own account is protected' : `${active ? 'Disable' : 'Enable'} account`}
                          >
                            {statusBusyId === account.id
                              ? <LoaderCircle className="spin" size={16} />
                              : active ? <UserX size={16} /> : <UserCheck size={16} />}
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            disabled={actionDisabled}
                            onClick={() => setResetTarget(account)}
                            aria-label={isSelf ? 'Use account settings to change your password' : `Reset access and issue a new invite for ${account.username}`}
                            title={isSelf ? 'Use your account settings' : 'Reset access and invite'}
                          >
                            <RefreshCw size={16} />
                          </button>
                          <button
                            type="button"
                            className="icon-button icon-button--danger"
                            disabled={actionDisabled}
                            onClick={() => setDeleteTarget(account)}
                            aria-label={isSelf ? 'You cannot delete your own account' : `Delete ${account.username}`}
                            title={isSelf ? 'Your own account is protected' : 'Delete account'}
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState compact icon={<Users size={22} />} title="No accounts found" description="Create an account to give someone access to Forge." action={<Button icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>Add user</Button>} />
          )}

          <div className="admin-security-note">
            <ShieldCheck size={18} />
            <div>
              <strong>Server-enforced access</strong>
              <p>Roles are checked by the API on every admin action. Administrators manage accounts and totals, but cannot open another user's private measurements or lifts.</p>
            </div>
          </div>
        </article>

        <article className="panel admin-audit-panel">
          <header className="panel__header">
            <div>
              <span className="eyebrow">SECURITY & ACTIVITY</span>
              <h2>Audit trail</h2>
            </div>
            <span className="panel__subcopy">{audit.length} events</span>
          </header>

          {loading ? (
            <div className="panel-loading" role="status"><LoaderCircle className="spin" size={22} /> Loading activity...</div>
          ) : visibleAudit.length ? (
            <>
              <ol className="audit-list">
                {visibleAudit.map((event) => {
                  const presentation = auditPresentation(event)
                  return (
                    <li className={`audit-item audit-item--${presentation.tone}`} key={event.id}>
                      <span className="audit-item__icon">{presentation.icon}</span>
                      <div className="audit-item__content">
                        <p>{auditSummary(event)}</p>
                        <span className="audit-item__meta">
                          <time dateTime={event.createdAt} title={exactTime(event.createdAt)}>{relativeTime(event.createdAt)}</time>
                          <small>{event.action}</small>
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ol>
              {audit.length > RECENT_AUDIT_LIMIT && (
                <Button className="audit-toggle" variant="ghost" onClick={() => setShowAllAudit((current) => !current)}>
                  {showAllAudit ? 'Show recent activity' : `View all ${audit.length} events`}
                </Button>
              )}
            </>
          ) : (
            <EmptyState compact icon={<Activity size={22} />} title="No activity yet" description="Administrative and account security events will appear here." />
          )}
        </article>
      </section>

      <CreateUserModal
        open={createOpen}
        error={formError}
        busy={saving}
        onClose={() => { if (!saving) setCreateOpen(false) }}
        onSave={createUser}
      />
      <ConfirmDialog
        open={Boolean(resetTarget)}
        title={`Issue a new invite for ${resetTarget?.username ?? 'this account'}?`}
        message="Their current password and sessions will stop working. A disabled account will be enabled again so the new one-time code can be used."
        confirmLabel="Reset access"
        busy={resetting}
        onClose={() => { if (!resetting) setResetTarget(null) }}
        onConfirm={() => void resetAccess()}
      />
      <ConfirmDialog
        open={Boolean(disableTarget)}
        title={`Disable ${disableTarget?.username ?? 'this account'}?`}
        message="They will be signed out on every device and cannot sign in again until an administrator re-enables the account. Their training data will be kept."
        confirmLabel="Disable account"
        busy={statusBusyId !== null}
        onClose={() => { if (statusBusyId === null) setDisableTarget(null) }}
        onConfirm={() => { if (disableTarget) void setUserStatus(disableTarget, false) }}
      />
      <DeleteUserModal
        user={deleteTarget}
        busy={deleting}
        onClose={() => { if (!deleting) setDeleteTarget(null) }}
        onConfirm={() => void deleteUser()}
      />
      <InviteResultModal
        result={inviteResult}
        onAcknowledge={() => setInviteResult(null)}
      />
    </div>
  )
}

function CreateUserModal({
  open,
  error,
  busy,
  onClose,
  onSave,
}: {
  open: boolean
  error: string
  busy: boolean
  onClose: () => void
  onSave: (input: { username: string }) => Promise<void>
}) {
  const [username, setUsername] = useState('')

  useEffect(() => {
    if (!open) return
    setUsername('')
  }, [open])

  function submit(event: FormEvent) {
    event.preventDefault()
    void onSave({ username: username.trim() })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="USER ACCESS"
      title="Create an account"
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" form="create-user-form" busy={busy} icon={<UserPlus size={16} />}>Create user</Button>
        </>
      )}
    >
      <form id="create-user-form" className="form-stack" onSubmit={submit}>
        {error && <div className="form-alert" role="alert">{error}</div>}
        <div className="invite-explainer">
          <TicketCheck size={20} />
          <p>Forge will generate a one-time activation code after the account is created. You choose who receives it; no password is stored or sent for them.</p>
        </div>
        <label className="field">
          <span>Username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="e.g. Sam"
            minLength={2}
            maxLength={32}
            pattern="[A-Za-z0-9_.-]+"
            autoComplete="off"
            required
            data-modal-autofocus
          />
          <small>Letters, numbers, dots, underscores, and hyphens only.</small>
        </label>
        <div className="admin-security-note">
          <ShieldCheck size={18} />
          <div><strong>Member access</strong><p>Friends can use their own tracker and sharing controls. Only the administrator can manage member accounts.</p></div>
        </div>
      </form>
    </Modal>
  )
}

function InviteResultModal({
  result,
  onAcknowledge,
}: {
  result: InviteResult | null
  onAcknowledge: () => void
}) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setCopied(false)
  }, [result])

  async function copyInvite() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.inviteCode)
      setCopied(true)
      toast('Invite code copied.')
    } catch {
      toast('Copy was blocked. Select the code and copy it manually.', 'error')
    }
  }

  return (
    <Modal
      open={Boolean(result)}
      onClose={() => undefined}
      eyebrow="ONE-TIME INVITE"
      title={result?.kind === 'reset' ? `New access code for ${result.username}` : `Invite ${result?.username ?? 'new user'}`}
      size="small"
      footer={<Button type="button" onClick={onAcknowledge}>I've saved this code</Button>}
    >
      <div className="form-stack invite-result">
        <div className="invite-result__notice">
          <TicketCheck size={21} />
          <p>This code is shown only now. Keep this window open until you have copied it somewhere safe.</p>
        </div>
        <div className="invite-result__identity">
          <span>Username</span>
          <strong>{result?.username}</strong>
        </div>
        <div className="invite-result__code" aria-label="One-time invite code">
          <code>{result?.inviteCode}</code>
          <Button type="button" variant="secondary" icon={copied ? <Check size={16} /> : <Copy size={16} />} onClick={() => void copyInvite()}>
            {copied ? 'Copied' : 'Copy code'}
          </Button>
        </div>
        <ol className="invite-result__steps">
          <li>Send the username and code directly to {result?.username} through a private channel.</li>
          <li>They choose <strong>Activate with an invite code</strong> on the Forge sign-in screen.</li>
          <li>The code expires as soon as they set their own password.</li>
        </ol>
      </div>
    </Modal>
  )
}

function DeleteUserModal({
  user,
  busy,
  onClose,
  onConfirm,
}: {
  user: User | null
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const [confirmation, setConfirmation] = useState('')

  useEffect(() => {
    if (user) setConfirmation('')
  }, [user])

  const matches = Boolean(user && confirmation === user.username)

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      eyebrow="PERMANENT ACTION"
      title={`Delete ${user?.username ?? 'this user'}?`}
      size="small"
      footer={(
        <>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="danger" busy={busy} disabled={!matches} icon={<Trash2 size={16} />} onClick={onConfirm}>Delete user</Button>
        </>
      )}
    >
      <div className="form-stack">
        <div className="danger-copy">
          <Trash2 size={20} />
          <p>This permanently removes the account, sessions, measurements, exercises, and lift history. It cannot be undone.</p>
        </div>
        <label className="field">
          <span>Type <strong>{user?.username}</strong> to confirm</span>
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
            disabled={busy}
            data-modal-autofocus
          />
        </label>
      </div>
    </Modal>
  )
}
