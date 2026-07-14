import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { LoadingScreen } from './components/ui'
import { useAuth } from './context/AuthContext'

const AdminPage = lazy(() => import('./pages/AdminPage').then((module) => ({ default: module.AdminPage })))
const LoginPage = lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.LoginPage })))
const SetupPage = lazy(() => import('./pages/AuthPages').then((module) => ({ default: module.SetupPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const LiftsPage = lazy(() => import('./pages/LiftsPage').then((module) => ({ default: module.LiftsPage })))
const MeasurementsPage = lazy(() => import('./pages/MeasurementsPage').then((module) => ({ default: module.MeasurementsPage })))
const WorkoutPlanPage = lazy(() => import('./pages/WorkoutPlanPage').then((module) => ({ default: module.WorkoutPlanPage })))
const MealPlanPage = lazy(() => import('./pages/MealPlanPage').then((module) => ({ default: module.MealPlanPage })))
const SharingPage = lazy(() => import('./pages/SharingPage').then((module) => ({ default: module.SharingPage })))
const MorePage = lazy(() => import('./pages/MorePage').then((module) => ({ default: module.MorePage })))

function ProtectedRoute() {
  const { loading, setupRequired, user } = useAuth()
  if (loading) return <LoadingScreen />
  if (setupRequired) return <Navigate to="/setup" replace />
  if (!user) return <Navigate to="/login" replace />
  return <Outlet />
}

function AdminRoute() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  return isAdmin ? <AdminPage /> : <Navigate to="/" replace />
}

export default function App() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="measurements" element={<MeasurementsPage />} />
            <Route path="lifts" element={<LiftsPage />} />
            <Route path="workout" element={<WorkoutPlanPage />} />
            <Route path="meals" element={<MealPlanPage />} />
            <Route path="sharing" element={<SharingPage />} />
            <Route path="more" element={<MorePage />} />
            <Route path="admin" element={<AdminRoute />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
