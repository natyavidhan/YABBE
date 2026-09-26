import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Toaster } from './components/toast'
import { Spinner } from './components/ui'
import Dashboard from './pages/Dashboard'

const Editor = lazy(() => import('./pages/Editor'))

export default function App() {
  return (
    <BrowserRouter>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-muted">
            <Spinner size={22} />
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/p/:projectId" element={<Editor />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </Suspense>
      <Toaster />
    </BrowserRouter>
  )
}
