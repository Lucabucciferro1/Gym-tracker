import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  TicketCheck,
  TrendingUp,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { ApiError, api, errorMessage } from '../api'
import { Brand, Button, FieldError, LoadingScreen } from '../components/ui'
import { useAuth } from '../context/AuthContext'

function AuthVisual({ setup = false }: { setup?: boolean }) {
  return (
    <section className="auth-visual">
      <div className="auth-visual__top"><Brand /></div>
      <div className="auth-visual__content">
        <span className="auth-visual__eyebrow">PRIVATE TRAINING LOG</span>
        <h1>Progress worth<br />measuring.</h1>
        <p>
          Turn every measurement and personal best into a clear picture of how far you have come.
        </p>
        <div className="auth-visual__chart" aria-hidden="true">
          <svg viewBox="0 0 600 190" preserveAspectRatio="none">
            <path className="chart-grid" d="M0 40H600M0 95H600M0 150H600" />
            <path className="chart-fill" d="M0 163 C82 154 103 132 162 137 S251 93 315 109 S421 49 485 69 S551 23 600 31 V190 H0Z" />
            <path className="chart-line" d="M0 163 C82 154 103 132 162 137 S251 93 315 109 S421 49 485 69 S551 23 600 31" />
          </svg>
          <span className="auth-visual__badge"><TrendingUp size={15} /> Build momentum</span>
        </div>
      </div>
      <div className="auth-visual__footer">
        <ShieldCheck size={17} />
        <span>{setup ? 'Your data stays private on this server.' : 'Secure, private, and built around your goals.'}</span>
      </div>
    </section>
  )
}

export function LoginPage() {
  const { loading, setupRequired, user, login, refresh } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'activate'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (loading) return <LoadingScreen />
  if (setupRequired) return <Navigate to="/setup" replace />
  if (user) return <Navigate to="/" replace />

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(username.trim(), password)
      navigate('/', { replace: true })
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'PASSWORD_SETUP_REQUIRED') {
        setMode('activate')
        setPassword('')
        setShowPassword(false)
        setError('This invited account still needs to be activated. Enter the one-time code from your administrator, then choose your password.')
        return
      }
      setError(errorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleActivation(event: FormEvent) {
    event.preventDefault()
    setError('')
    const cleanUsername = username.trim()
    const cleanCode = inviteCode.trim()
    if (!cleanUsername) return setError('Enter the username from your invitation.')
    if (!cleanCode) return setError('Enter your one-time invite code.')
    if (newPassword.length < 8) return setError('Use at least 8 characters for your new password.')
    if (newPassword !== confirmPassword) return setError('The passwords do not match.')

    setSubmitting(true)
    try {
      await api.auth.activate(cleanUsername, cleanCode, newPassword)
      await refresh()
      navigate('/', { replace: true })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  function showActivation() {
    setMode('activate')
    setPassword('')
    setError('')
    setShowPassword(false)
  }

  function showLogin() {
    setMode('login')
    setInviteCode('')
    setNewPassword('')
    setConfirmPassword('')
    setError('')
    setShowPassword(false)
  }

  return (
    <div className="auth-layout">
      <AuthVisual />
      <main className="auth-form-panel">
        <div className="auth-mobile-brand"><Brand /></div>
        {mode === 'login' ? (
        <form className="auth-card" autoComplete="off" onSubmit={(event) => void handleSubmit(event)}>
          <div className="auth-card__heading">
            <span className="auth-icon"><LockKeyhole size={21} /></span>
            <span className="eyebrow">WELCOME BACK</span>
            <h2>Sign in to Forge</h2>
            <p>Your next personal best starts with the last one.</p>
          </div>

          {error && <div className="form-alert" role="alert">{error}</div>}

          <label className="field">
            <span>Username</span>
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter your username"
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <span className="password-input">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                required
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
          </label>

          <Button className="button--full" type="submit" busy={submitting} icon={<ArrowRight size={17} />}>
            Sign in
          </Button>
          <div className="auth-card__hint">
            <p>Signing in for the first time?</p>
            <button className="text-link" type="button" onClick={showActivation}>
              Activate with an invite code <ArrowRight size={15} />
            </button>
          </div>
        </form>
        ) : (
          <form className="auth-card" autoComplete="off" onSubmit={(event) => void handleActivation(event)}>
            <div className="auth-card__heading">
              <span className="auth-icon"><TicketCheck size={22} /></span>
              <span className="eyebrow">FIRST-TIME ACCESS</span>
              <h2>Activate your account</h2>
              <p>Use the username and one-time code your Forge administrator gave you.</p>
            </div>

            {error && <div className="form-alert" role="alert">{error}</div>}

            <label className="field">
              <span>Username</span>
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Username from your invitation"
                maxLength={32}
                required
              />
            </label>
            <label className="field">
              <span>One-time invite code</span>
              <input
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="Enter your invite code"
                maxLength={128}
                spellCheck={false}
                required
              />
            </label>
            <label className="field">
              <span>Create password</span>
              <span className="password-input">
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="off"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  minLength={8}
                  maxLength={128}
                  required
                />
                <button type="button" onClick={() => setShowPassword((current) => !current)} aria-label={showPassword ? 'Hide passwords' : 'Show passwords'}>
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
              <span className={`password-check ${newPassword.length >= 8 ? 'is-valid' : ''}`}>
                <Check size={14} /> At least 8 characters
              </span>
            </label>
            <label className="field">
              <span>Confirm password</span>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="off"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Enter it again"
                maxLength={128}
                required
              />
              {confirmPassword && newPassword !== confirmPassword && <FieldError>Passwords do not match.</FieldError>}
            </label>

            <Button className="button--full" type="submit" busy={submitting} icon={<KeyRound size={17} />}>
              Activate and sign in
            </Button>
            <div className="auth-card__hint">
              <button className="text-link" type="button" onClick={showLogin}>
                <ArrowLeft size={15} /> Back to sign in
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  )
}

export function SetupPage() {
  const { loading, setupRequired, user, setup } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (loading) return <LoadingScreen />
  if (!setupRequired && user) return <Navigate to="/" replace />
  if (!setupRequired) return <Navigate to="/login" replace />

  const longEnough = password.length >= 8
  const matches = confirmPassword.length > 0 && password === confirmPassword

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError('')
    const cleanUsername = username.trim()
    if (cleanUsername.length < 2 || cleanUsername.length > 32) {
      return setError('Use between 2 and 32 characters for the administrator username.')
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(cleanUsername)) {
      return setError('Use only letters, numbers, dots, underscores, and hyphens in the username.')
    }
    if (!longEnough) return setError('Use at least 8 characters for your password.')
    if (!matches) return setError('The passwords do not match.')
    setSubmitting(true)
    try {
      await setup(cleanUsername, password)
      navigate('/', { replace: true })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-layout">
      <AuthVisual setup />
      <main className="auth-form-panel">
        <div className="auth-mobile-brand"><Brand /></div>
        <form className="auth-card" autoComplete="off" onSubmit={(event) => void handleSubmit(event)}>
          <div className="auth-card__heading">
            <span className="auth-icon"><ShieldCheck size={22} /></span>
            <span className="eyebrow">FIRST-RUN SETUP</span>
            <h2>Set up your Forge administrator</h2>
            <p>Choose the administrator username and password for this private tracker.</p>
          </div>

          {error && <div className="form-alert" role="alert">{error}</div>}

          <label className="field">
            <span>Administrator username</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={2}
              maxLength={32}
              pattern="[A-Za-z0-9_.-]+"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="admin-help"
              required
            />
            <small id="admin-help">Use letters, numbers, dots, underscores, or hyphens.</small>
          </label>
          <label className="field">
            <span>Create password</span>
            <span className="password-input">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="off"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                required
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </span>
            <span className={`password-check ${longEnough ? 'is-valid' : ''}`}>
              <Check size={14} /> At least 8 characters
            </span>
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete="off"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Enter it again"
              required
            />
            {confirmPassword && !matches && <FieldError>Passwords do not match.</FieldError>}
          </label>

          <Button className="button--full" type="submit" busy={submitting} icon={<ArrowRight size={17} />}>
            Create administrator account
          </Button>
          <p className="auth-card__hint">You can add and manage other users from the admin panel later.</p>
        </form>
      </main>
    </div>
  )
}
