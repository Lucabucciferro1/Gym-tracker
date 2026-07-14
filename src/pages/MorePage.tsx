import { CalendarRange, ChevronRight, ShieldCheck, UsersRound, Utensils } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import '../more.css'

const moreItems = [
  {
    to: '/meals',
    label: 'Meal plan',
    description: 'Plan meals and optionally track calories and macros.',
    icon: Utensils,
    tone: 'meal',
  },
  {
    to: '/sharing',
    label: 'Sharing',
    description: 'Choose which friends can see each part of your progress.',
    icon: UsersRound,
    tone: 'share',
  },
  {
    to: '/workout',
    label: 'Workout plan',
    description: 'Edit your training week, exercises, and rest days.',
    icon: CalendarRange,
    tone: 'workout',
  },
]

export function MorePage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const items = user?.role === 'admin'
    ? [...moreItems, {
      to: '/admin',
      label: 'Admin panel',
      description: 'Invite friends and manage account access.',
      icon: ShieldCheck,
      tone: 'admin',
    }]
    : moreItems

  return (
    <div className="page-stack more-page">
      <PageHeader
        eyebrow="MORE"
        title="Plans and people"
        description="Everything beyond your day-to-day progress tracking."
      />
      <section className="more-grid" aria-label="More Forge features">
        {items.map(({ to, label, description, icon: Icon, tone }) => (
          <button className={`more-card more-card--${tone}`} type="button" key={to} onClick={() => navigate(to)}>
            <span className="more-card__icon"><Icon size={22} /></span>
            <span><strong>{label}</strong><small>{description}</small></span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        ))}
      </section>
    </div>
  )
}
