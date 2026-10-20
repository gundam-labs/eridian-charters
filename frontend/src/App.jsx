import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth, homeFor } from './context/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import StaffLayout from './components/StaffLayout';
import TopNavLayout from './components/TopNavLayout';
import { Loading } from './components/ui';

import Login from './pages/Login';
import Invite from './pages/Invite';
import Register from './pages/Register';
import NotFound from './pages/NotFound';

import MemberHome from './pages/member/MemberHome';
import RequestQuote from './pages/member/RequestQuote';
import MyRequests from './pages/member/MyRequests';
import MemberRequestDetail from './pages/member/RequestDetail';
import MyTrips from './pages/member/MyTrips';
import TripDetail from './pages/member/TripDetail';
import Invoices from './pages/shared/Invoices';
import MemberEmptyLegs from './pages/member/EmptyLegs';
import EmptyLegsAdmin from './pages/shared/EmptyLegsAdmin';
import EmptyLegsPublic from './pages/public/EmptyLegsPublic';
import EmptyLegPublicDetail from './pages/public/EmptyLegPublicDetail';

import StaffDashboard from './pages/shared/StaffDashboard';
import RequestsInbox from './pages/sales/RequestsInbox';
import SalesRequestDetail from './pages/sales/RequestDetail';
import Quotes from './pages/sales/Quotes';
import Members from './pages/sales/Members';
import MemberDetail from './pages/sales/MemberDetail';
import Payments from './pages/sales/Payments';

import FleetCalendar from './pages/ops/FleetCalendar';
import Charters from './pages/ops/Charters';
import CharterDetail from './pages/ops/CharterDetail';
import Maintenance from './pages/ops/Maintenance';
import Crew from './pages/ops/Crew';
import Aircraft from './pages/ops/Aircraft';

import MyFlights from './pages/pilot/MyFlights';
import FlightDetail from './pages/pilot/FlightDetail';

import ListerListings from './pages/lister/ListerListings';
import ListerRequests from './pages/lister/ListerRequests';
import ListerProfile from './pages/lister/ListerProfile';
import Listers from './pages/sales/Listers';

import AdminHome from './pages/admin/AdminHome';
import Users from './pages/admin/Users';
import Settings from './pages/admin/Settings';
import Airports from './pages/admin/Airports';
import Operators from './pages/admin/Operators';

const STAFF = ['admin', 'sales', 'ops'];
const guard = (roles, el) => <ProtectedRoute roles={roles}>{el}</ProtectedRoute>;

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route path="/register" element={<Register />} />
      {/* Public marketing pages — no auth, never redirect signed-in users */}
      <Route path="/empty-legs" element={<EmptyLegsPublic />} />
      <Route path="/empty-legs/:id" element={<EmptyLegPublicDetail />} />

      {/* Member */}
      <Route path="/m" element={guard(['member'], <TopNavLayout kind="member" />)}>
        <Route index element={<MemberHome />} />
        <Route path="request" element={<RequestQuote />} />
        <Route path="requests" element={<MyRequests />} />
        <Route path="requests/:id" element={<MemberRequestDetail />} />
        <Route path="trips" element={<MyTrips />} />
        <Route path="trips/:id" element={<TripDetail />} />
        <Route path="empty-legs" element={<MemberEmptyLegs />} />
        <Route path="invoices" element={<Invoices />} />
      </Route>

      {/* Lister — operators, agents and private flyers posting their own empty legs */}
      <Route path="/l" element={guard(['lister'], <TopNavLayout kind="lister" />)}>
        <Route index element={<ListerListings />} />
        <Route path="requests" element={<ListerRequests />} />
        <Route path="profile" element={<ListerProfile />} />
      </Route>

      {/* Pilot */}
      <Route path="/p" element={guard(['pilot'], <TopNavLayout kind="pilot" />)}>
        <Route index element={<MyFlights />} />
        <Route path="flights/:id" element={<FlightDetail />} />
      </Route>

      {/* Staff (sidebar) */}
      <Route element={guard(STAFF, <StaffLayout />)}>
        <Route path="/admin" element={guard(['admin'], <AdminHome />)} />
        <Route path="/admin/users" element={guard(['admin'], <Users />)} />
        <Route path="/admin/settings" element={guard(['admin'], <Settings />)} />
        <Route path="/admin/airports" element={guard(['admin'], <Airports />)} />
        <Route path="/admin/operators" element={guard(['admin', 'sales'], <Operators />)} />

        <Route path="/s" element={guard(['sales', 'admin'], <StaffDashboard title="Sales dashboard" />)} />
        <Route path="/s/requests" element={guard(['sales', 'admin'], <RequestsInbox />)} />
        <Route path="/s/requests/:id" element={guard(['sales', 'admin'], <SalesRequestDetail />)} />
        <Route path="/s/quotes" element={guard(['sales', 'admin'], <Quotes />)} />
        <Route path="/s/members" element={guard(STAFF, <Members />)} />
        <Route path="/s/members/:id" element={guard(STAFF, <MemberDetail />)} />
        <Route path="/s/invoices" element={guard(STAFF, <Invoices />)} />
        <Route path="/s/payments" element={guard(['sales', 'admin'], <Payments />)} />
        <Route path="/s/empty-legs" element={guard(STAFF, <EmptyLegsAdmin />)} />
        <Route path="/s/listers" element={guard(['sales', 'admin'], <Listers />)} />

        <Route path="/o" element={guard(['ops', 'admin'], <StaffDashboard title="Operations dashboard" />)} />
        <Route path="/o/calendar" element={guard(['ops', 'admin'], <FleetCalendar />)} />
        <Route path="/o/charters" element={guard(STAFF, <Charters />)} />
        <Route path="/o/charters/:id" element={guard(STAFF, <CharterDetail />)} />
        <Route path="/o/maintenance" element={guard(['ops', 'admin'], <Maintenance />)} />
        <Route path="/o/crew" element={guard(['ops', 'admin'], <Crew />)} />
        <Route path="/o/aircraft" element={guard(['ops', 'admin'], <Aircraft />)} />
        <Route path="/o/empty-legs" element={guard(STAFF, <EmptyLegsAdmin />)} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
