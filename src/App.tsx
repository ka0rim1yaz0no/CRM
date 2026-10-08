
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { getAuthUser } from './api/authStorage'
import { isPocOperationsUser } from './lib/roleAccess'
import { EmployeeLiveShareProvider } from './components/EmployeeLiveShare'
import EmployeeVoiceCall from './components/EmployeeVoiceCall'

const FeatureRoute = lazy(() => import('./components/FeatureRoute'))
const Login = lazy(() => import('./pages/Login'))
const Dashboard = lazy(() => import('./pages/dashboard'))
const Leads = lazy(() => import('./pages/leads'))
const Teams = lazy(() => import('./pages/teams'))
const Calendar = lazy(() => import('./pages/calendar'))
const Attendance = lazy(() => import('./pages/attendance'))
const Profile = lazy(() => import('./pages/profile'))
const Settings = lazy(() => import('./pages/settings'))
const Messages = lazy(() => import('./pages/messages'))
const KnowledgeBase = lazy(() => import('./pages/knowledge-base'))
const KnowledgeBaseDetail = lazy(() => import('./pages/knowledge-base/detail'))
const Announcements = lazy(() => import('./pages/announcements'))
const Tasks = lazy(() => import('./pages/tasks'))
const TaskDetail = lazy(() => import('./pages/tasks/detail'))
const AdminDashboard = lazy(() => import('./pages/admin/dashboard'))
const AdminTeams = lazy(() => import('./pages/admin/teams'))
const AdminEmployees = lazy(() => import('./pages/admin/employees'))
const AdminEmployeeNew = lazy(() => import('./pages/admin/employees/new'))
const AdminHr = lazy(() => import('./pages/admin/hr'))
const AdminAttendanceForm = lazy(() => import('./pages/admin/hr/attendanceForm'))
const AdminSettings = lazy(() => import('./pages/admin/settings'))
const AdminLeads = lazy(() => import('./pages/admin/leads'))
const AdminKnowledgeBase = lazy(() => import('./pages/admin/knowledge-base/index'))
const AdminAnnouncementForm = lazy(() => import('./pages/admin/knowledge-base/announcementForm'))
const AdminProductForm = lazy(() => import('./pages/admin/knowledge-base/productForm'))
const AdminMedia = lazy(() => import('./pages/admin/media'))
const AdminTasks = lazy(() => import('./pages/admin/tasks'))
const AdminTaskDetail = lazy(() => import('./pages/admin/tasks/detail'))
const AdminReports = lazy(() => import('./pages/admin/reports'))
const AdminTracker = lazy(() => import('./pages/admin/tracker'))
const AdminEvaluations = lazy(() => import('./pages/admin/evaluations'))
const PayrollPage = lazy(() => import('./pages/admin/payroll'))
const PayrollComputePage = lazy(() => import('./pages/admin/payrollCompute'))
const Credentials = lazy(() => import('./pages/admin/credentials'))
const HempIndustrySurvey = lazy(() => import('./pages/survey/HempIndustrySurvey'))

function RouteLoading() {
  return <div className="min-h-screen bg-[#070910] p-6 text-sm text-white/50">Loading workspace...</div>
}

const outsideSalesAllowedPaths = ["/dashboard", "/leads", "/tasks"];

function isOutsideSalesEmployee(authUser: ReturnType<typeof getAuthUser>) {
  if (authUser?.userType !== "employee") return false;

  const role = (authUser.user.role || "").toLowerCase();
  const team = (authUser.user.team || "").toLowerCase();

  return (role.includes("outside") && role.includes("sales")) || (team.includes("outside") && team.includes("sales"));
}

function isOutsideSalesAllowedPath(pathname: string) {
  return outsideSalesAllowedPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function ProtectedRoute({ children, type }: { children: ReactNode; type?: 'admin' | 'employee' }) {
  const authUser = getAuthUser()
  const location = useLocation()

  if (!authUser) {
    return <Navigate to="/login" replace />
  }

  if (type && authUser.userType !== type) {
    return <Navigate to={authUser.userType === 'admin' ? '/admin/dashboard' : '/dashboard'} replace />
  }

  if (type === 'employee' && isOutsideSalesEmployee(authUser) && !isOutsideSalesAllowedPath(location.pathname)) {
    return <Navigate to="/dashboard" replace />
  }

  return children
}

function PocOperationsRoute({ children }: { children: ReactNode }) {
  const authUser = getAuthUser()

  if (!authUser) return <Navigate to="/login" replace />
  if (!isPocOperationsUser(authUser)) {
    return <Navigate to={authUser.userType === 'admin' ? '/admin/dashboard' : '/dashboard'} replace />
  }

  return children
}

function RoutedApp() {
  const location = useLocation()

  return (
    <Suspense key={location.pathname} fallback={<RouteLoading />}>
        <Routes location={location}>
          <Route path="/login" element={<Login />} />
          <Route path="/survey/help-save-the-hemp-industry" element={<HempIndustrySurvey />} />
          <Route path="/dashboard" element={<ProtectedRoute type="employee"><FeatureRoute feature="dashboard" scope="employee"><Dashboard /></FeatureRoute></ProtectedRoute>} />
          <Route path="/leads" element={<ProtectedRoute type="employee"><FeatureRoute feature="leads" scope="employee"><Leads /></FeatureRoute></ProtectedRoute>} />
          <Route path="/tasks" element={<ProtectedRoute type="employee"><FeatureRoute feature="tasks" scope="employee"><Tasks /></FeatureRoute></ProtectedRoute>} />
          <Route path="/tasks/:taskId" element={<ProtectedRoute type="employee"><FeatureRoute feature="tasks" scope="employee"><TaskDetail /></FeatureRoute></ProtectedRoute>} />
          <Route path="/knowledge-base" element={<ProtectedRoute type="employee"><FeatureRoute feature="knowledge-base" scope="employee"><KnowledgeBase /></FeatureRoute></ProtectedRoute>} />
          <Route path="/announcements" element={<ProtectedRoute type="employee"><FeatureRoute feature="knowledge-base" scope="employee"><Announcements /></FeatureRoute></ProtectedRoute>} />
          <Route path="/announcements/:entryId" element={<ProtectedRoute type="employee"><FeatureRoute feature="knowledge-base" scope="employee"><KnowledgeBaseDetail /></FeatureRoute></ProtectedRoute>} />
          <Route path="/knowledge-base/:entryKind/:entryId" element={<ProtectedRoute type="employee"><FeatureRoute feature="knowledge-base" scope="employee"><KnowledgeBaseDetail /></FeatureRoute></ProtectedRoute>} />
          <Route path="/teams" element={<ProtectedRoute type="employee"><FeatureRoute feature="teams" scope="employee"><Teams /></FeatureRoute></ProtectedRoute>} />
          <Route path="/calendar" element={<ProtectedRoute type="employee"><FeatureRoute feature="calendar" scope="employee"><Calendar /></FeatureRoute></ProtectedRoute>} />
          <Route path="/attendance" element={<ProtectedRoute type="employee"><FeatureRoute feature="attendance" scope="employee"><Attendance /></FeatureRoute></ProtectedRoute>} />
          <Route path="/poc/employees" element={<PocOperationsRoute><FeatureRoute feature="employees" scope="admin"><AdminEmployees /></FeatureRoute></PocOperationsRoute>} />
          <Route path="/poc/employees/new" element={<PocOperationsRoute><FeatureRoute feature="employees" scope="admin"><AdminEmployeeNew /></FeatureRoute></PocOperationsRoute>} />
          <Route path="/poc/employees/:employeeId/edit" element={<PocOperationsRoute><FeatureRoute feature="employees" scope="admin"><AdminEmployees /></FeatureRoute></PocOperationsRoute>} />
          <Route path="/poc/employees/:employeeId" element={<PocOperationsRoute><FeatureRoute feature="employees" scope="admin"><AdminEmployees /></FeatureRoute></PocOperationsRoute>} />
          <Route path="/poc/tasks" element={<PocOperationsRoute><FeatureRoute feature="tasks" scope="admin"><AdminTasks /></FeatureRoute></PocOperationsRoute>} />
          <Route path="/poc/tasks/:taskId" element={<PocOperationsRoute><FeatureRoute feature="tasks" scope="admin"><AdminTaskDetail /></FeatureRoute></PocOperationsRoute>} />
          <Route path="/poc/credentials" element={<PocOperationsRoute><FeatureRoute feature="credentials" scope="admin"><Credentials /></FeatureRoute></PocOperationsRoute>} />
          <Route path="/profile" element={<ProtectedRoute type="employee"><FeatureRoute feature="profile" scope="employee"><Profile /></FeatureRoute></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute type="employee"><FeatureRoute feature="settings" scope="employee"><Settings /></FeatureRoute></ProtectedRoute>} />
          <Route path="/messages" element={<ProtectedRoute type="employee"><FeatureRoute feature="messages" scope="employee"><Messages /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/dashboard" element={<ProtectedRoute type="admin"><FeatureRoute feature="dashboard" scope="admin"><AdminDashboard /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/teams" element={<ProtectedRoute type="admin"><FeatureRoute feature="teams" scope="admin"><AdminTeams /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/employees" element={<ProtectedRoute type="admin"><FeatureRoute feature="employees" scope="admin"><AdminEmployees /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/employees/new" element={<ProtectedRoute type="admin"><FeatureRoute feature="employees" scope="admin"><AdminEmployeeNew /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/employees/:employeeId/edit" element={<ProtectedRoute type="admin"><FeatureRoute feature="employees" scope="admin"><AdminEmployees /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/employees/:employeeId" element={<ProtectedRoute type="admin"><FeatureRoute feature="employees" scope="admin"><AdminEmployees /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/hr" element={<ProtectedRoute type="admin"><FeatureRoute feature="hr" scope="admin"><AdminHr /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/hr/attendance/new" element={<ProtectedRoute type="admin"><FeatureRoute feature="hr" scope="admin"><AdminAttendanceForm /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/hr/attendance/:employeeId/:dateKey/edit" element={<ProtectedRoute type="admin"><FeatureRoute feature="hr" scope="admin"><AdminAttendanceForm /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/settings" element={<ProtectedRoute type="admin"><FeatureRoute feature="settings" scope="admin"><AdminSettings /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/leads" element={<ProtectedRoute type="admin"><FeatureRoute feature="leads" scope="admin"><AdminLeads /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/tasks" element={<ProtectedRoute type="admin"><FeatureRoute feature="tasks" scope="admin"><AdminTasks /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/tasks/:taskId" element={<ProtectedRoute type="admin"><FeatureRoute feature="tasks" scope="admin"><AdminTaskDetail /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/reports" element={<ProtectedRoute type="admin"><FeatureRoute feature="tracking" scope="admin"><AdminReports /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/tracker" element={<ProtectedRoute type="admin"><FeatureRoute feature="tracking" scope="admin"><AdminTracker /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/evaluations" element={<ProtectedRoute type="admin"><FeatureRoute feature="hr" scope="admin"><AdminEvaluations /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/knowledge-base" element={<ProtectedRoute type="admin"><FeatureRoute feature="knowledge-base" scope="admin"><AdminKnowledgeBase /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/knowledge-base/announcements/new" element={<ProtectedRoute type="admin"><FeatureRoute feature="knowledge-base" scope="admin"><AdminAnnouncementForm /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/knowledge-base/announcements/:entryId/edit" element={<ProtectedRoute type="admin"><FeatureRoute feature="knowledge-base" scope="admin"><AdminAnnouncementForm /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/knowledge-base/products/new" element={<ProtectedRoute type="admin"><FeatureRoute feature="knowledge-base" scope="admin"><AdminProductForm /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/knowledge-base/products/:entryId/edit" element={<ProtectedRoute type="admin"><FeatureRoute feature="knowledge-base" scope="admin"><AdminProductForm /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/knowledge-base/*" element={<ProtectedRoute type="admin"><FeatureRoute feature="knowledge-base" scope="admin"><AdminKnowledgeBase /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/media" element={<ProtectedRoute type="admin"><FeatureRoute feature="media" scope="admin"><AdminMedia /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/messages" element={<ProtectedRoute type="admin"><FeatureRoute feature="messages" scope="admin"><Messages /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/payroll" element={<ProtectedRoute type="admin"><FeatureRoute feature="payroll" scope="admin"><PayrollPage /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/payrollCompute" element={<ProtectedRoute type="admin"><FeatureRoute feature="payroll" scope="admin"><PayrollComputePage /></FeatureRoute></ProtectedRoute>} />
          <Route path="/admin/credentials" element={<ProtectedRoute type="admin"><FeatureRoute feature="credentials" scope="admin"><Credentials /></FeatureRoute></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
    </Suspense>
  )
}

function App() {
  return (
    <BrowserRouter>
      <EmployeeLiveShareProvider>
        <EmployeeVoiceCall />
        <RoutedApp />
      </EmployeeLiveShareProvider>
    </BrowserRouter>
  )
}

export default App
