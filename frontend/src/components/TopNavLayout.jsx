import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Wordmark from './Wordmark';

const NAVS = {
  member: [
    { to: '/m', label: 'Home', end: true },
    { to: '/m/request', label: 'Request a quote' },
    { to: '/m/requests', label: 'My requests' },
    { to: '/m/trips', label: 'My trips' },
    { to: '/m/empty-legs', label: 'Empty legs' },
    { to: '/m/invoices', label: 'Invoices' },
  ],
  pilot: [
    { to: '/p', label: 'My flights', end: true },
  ],
};

export default function TopNavLayout({ kind }) {
  const { user, logout } = useAuth();
  const links = NAVS[kind] || [];
  return (
    <div className="tshell">
      <header className="tnav">
        <div className="tnav-inner">
          <Link to={kind === 'pilot' ? '/p' : '/m'}><Wordmark sub={false} /></Link>
          <nav className="tnav-links">
            {links.map(l => <NavLink key={l.to} to={l.to} end={l.end}>{l.label}</NavLink>)}
          </nav>
          <div className="tnav-user">
            <span className="name">{user?.name}{user?.member_no ? ` · ${user.member_no}` : ''}</span>
            <button className="icon-btn" onClick={logout}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="tcontent"><Outlet /></main>
    </div>
  );
}
