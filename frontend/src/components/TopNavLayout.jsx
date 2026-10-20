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
  lister: [
    { to: '/l', label: 'My empty legs', end: true },
    { to: '/l/requests', label: 'Requests' },
    { to: '/l/profile', label: 'Profile' },
    { to: '/empty-legs', label: 'Deals page ↗', external: true },
  ],
};

export default function TopNavLayout({ kind }) {
  const { user, logout } = useAuth();
  const links = NAVS[kind] || [];
  return (
    <div className="tshell">
      <header className="tnav">
        <div className="tnav-inner">
          <Link to={{ pilot: '/p', lister: '/l' }[kind] || '/m'}><Wordmark sub={false} /></Link>
          <nav className="tnav-links">
            {links.map(l => l.external
              ? <a key={l.to} href={l.to} target="_blank" rel="noreferrer">{l.label}</a>
              : <NavLink key={l.to} to={l.to} end={l.end}>{l.label}</NavLink>)}
          </nav>
          <div className="tnav-user">
            <span className="name">{user?.name}{user?.member_no ? ` · ${user.member_no}` : ''}{user?.lister_company ? ` · ${user.lister_company}` : ''}</span>
            <button className="icon-btn" onClick={logout}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="tcontent"><Outlet /></main>
    </div>
  );
}
