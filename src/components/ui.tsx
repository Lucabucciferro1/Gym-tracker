import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Dumbbell,
  LoaderCircle,
  Minus,
  X,
} from 'lucide-react'
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { DateRange } from '../types'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  icon?: ReactNode
  busy?: boolean
}

export function Button({
  variant = 'primary',
  icon,
  busy,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button--${variant} ${className}`}
      disabled={disabled || busy}
      {...props}
    >
      {busy ? <LoaderCircle className="spin" size={17} /> : icon}
      {children}
    </button>
  )
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand--compact' : ''}`}>
      <span className="brand__mark" aria-hidden="true">
        <Dumbbell size={20} strokeWidth={2.4} />
      </span>
      {!compact && (
        <span className="brand__wordmark">
          FORGE <small>Progress, made visible.</small>
        </span>
      )}
    </div>
  )
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  eyebrow?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'small' | 'medium' | 'large'
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    const style = window.getComputedStyle(element)
    return element.getClientRects().length > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && element.getAttribute('aria-hidden') !== 'true'
  })
}

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  size = 'medium',
}: ModalProps) {
  const generatedId = useId()
  const titleId = `modal-title-${generatedId.replace(/:/g, '')}`
  const backdropRef = useRef<HTMLDivElement>(null)
  const modalRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (open) return

    const rememberFocusedElement = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && !event.target.closest('[role="dialog"]')) {
        restoreFocusRef.current = event.target
      }
    }

    if (document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement
    }
    document.addEventListener('focusin', rememberFocusedElement, true)
    return () => document.removeEventListener('focusin', rememberFocusedElement, true)
  }, [open])

  useEffect(() => {
    if (!open) return
    const body = document.body
    const previousOverflow = body.style.overflow
    const previousPosition = body.style.position
    const previousTop = body.style.top
    const previousLeft = body.style.left
    const previousWidth = body.style.width
    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const touchInput = navigator.maxTouchPoints > 0
      || (window.matchMedia?.('(any-pointer: coarse)').matches ?? false)

    document.body.style.overflow = 'hidden'
    if (touchInput) {
      body.style.position = 'fixed'
      body.style.top = `-${scrollY}px`
      body.style.left = `-${scrollX}px`
      body.style.width = '100%'
    }

    const modal = modalRef.current
    const backdrop = backdropRef.current
    const isolatedElements: Array<{
      element: HTMLElement
      ariaHidden: string | null
      hadInertAttribute: boolean
    }> = []

    if (modal) {
      // Focusing a field as a bottom sheet opens the software keyboard before
      // mobile Safari has positioned the dialog. Keep focus on the dialog on
      // touch devices; desktop users still land in the preferred field.
      const preferredFocus = touchInput
        ? modal
        : modal.querySelector<HTMLElement>('[data-modal-autofocus]')
          ?? modal.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])')
          ?? focusableElements(modal)[0]
          ?? modal
      preferredFocus.focus({ preventScroll: true })
    }

    let activeBranch: HTMLElement | null = backdrop
    while (activeBranch?.parentElement) {
      const parent = activeBranch.parentElement
      Array.from(parent.children).forEach((sibling) => {
        if (sibling === activeBranch || !(sibling instanceof HTMLElement)) return
        isolatedElements.push({
          element: sibling,
          ariaHidden: sibling.getAttribute('aria-hidden'),
          hadInertAttribute: sibling.hasAttribute('inert'),
        })
        sibling.setAttribute('aria-hidden', 'true')
        sibling.setAttribute('inert', '')
      })
      if (parent === document.body) break
      activeBranch = parent
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab' || !modal) return
      const focusable = focusableElements(modal)
      if (!focusable.length) {
        event.preventDefault()
        modal.focus({ preventScroll: true })
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement
      if (event.shiftKey && (activeElement === first || !modal.contains(activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || !modal.contains(activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      body.style.overflow = previousOverflow
      body.style.position = previousPosition
      body.style.top = previousTop
      body.style.left = previousLeft
      body.style.width = previousWidth
      if (touchInput) window.scrollTo(scrollX, scrollY)
      document.removeEventListener('keydown', onKeyDown)
      isolatedElements.reverse().forEach(({ element, ariaHidden, hadInertAttribute }) => {
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
        if (!hadInertAttribute) element.removeAttribute('inert')
      })
      if (restoreFocusRef.current?.isConnected) {
        restoreFocusRef.current.focus({ preventScroll: true })
      }
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={modalRef}
        className={`modal modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>,
    document.body,
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  busy,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="small">
      <div className="confirm-message">
        <span className="confirm-message__icon"><AlertTriangle size={22} /></span>
        <p>{message}</p>
      </div>
      <div className="modal__inline-actions">
        <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="button" variant="danger" busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Modal>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}

export function MetricCard({
  label,
  value,
  detail,
  icon,
  trend,
}: {
  label: string
  value: string
  detail?: string
  icon: ReactNode
  trend?: number | null
}) {
  const trendLabel = trend == null
    ? null
    : trend > 0
      ? `Increase of ${Math.abs(trend).toFixed(1)} percent`
      : trend < 0
        ? `Decrease of ${Math.abs(trend).toFixed(1)} percent`
        : 'No percentage change'
  const trendDisplay = trend == null
    ? null
    : `${trend > 0 ? '+' : trend < 0 ? '-' : ''}${Math.abs(trend).toFixed(1)}%`

  return (
    <article className="metric-card">
      <div className="metric-card__top">
        <span>{label}</span>
        <span className="metric-card__icon">{icon}</span>
      </div>
      <strong>{value}</strong>
      <div className="metric-card__detail">
        {trend !== undefined && trend !== null ? (
          <span className={trend > 0 ? 'trend trend--up' : trend < 0 ? 'trend trend--down' : 'trend'}>
            <span className="trend__visual" aria-hidden="true">
              {trend > 0 ? <ArrowUpRight size={14} /> : trend < 0 ? <ArrowDownRight size={14} /> : <Minus size={14} />}
              {trendDisplay}
            </span>
            <span className="sr-only">{trendLabel}</span>
          </span>
        ) : null}
        {detail && <span>{detail}</span>}
      </div>
    </article>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`empty-state ${compact ? 'empty-state--compact' : ''}`}>
      <span className="empty-state__icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function LoadingScreen({ label = 'Loading your progress...' }: { label?: string }) {
  return (
    <div className="loading-screen" role="status">
      <Brand />
      <LoaderCircle className="spin" size={26} />
      <span>{label}</span>
    </div>
  )
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-notice" role="alert">
      <AlertTriangle size={18} />
      <span>{message}</span>
      {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
    </div>
  )
}

export function RangeSelector({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
  const ranges: Array<{ value: DateRange; label: string }> = [
    { value: '30d', label: '30D' },
    { value: '90d', label: '3M' },
    { value: '1y', label: '1Y' },
    { value: 'all', label: 'All' },
  ]
  return (
    <div className="segmented-control" role="group" aria-label="Chart date range">
      {ranges.map((range) => (
        <button
          type="button"
          key={range.value}
          className={value === range.value ? 'is-active' : ''}
          aria-pressed={value === range.value}
          onClick={() => onChange(range.value)}
        >
          {range.label}
        </button>
      ))}
    </div>
  )
}

export function FieldError({ children }: { children?: ReactNode }) {
  return children ? <span className="field-error">{children}</span> : null
}
