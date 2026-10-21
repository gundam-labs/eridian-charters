import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, Link } from 'react-router-dom';
import { useAuth, homeFor } from '../context/AuthContext';
import Wordmark from './Wordmark';

const SECTIONS = [
  {
    title: 'Sales', roles: ['sales', 'admin'],
    links: [
      { to: '/s', label: 'Sales dashboard', end: true, roles: ['sales'] },
      { to: '/s/requests', label: 'Requests inbox' },
      { to: '/s/quotes', label: 'Quotes' },
      { to: '/s/empty-legs', label: 'Empty legs' },
      { to: '/s/listers', label: 'Listers' },
      { to: '/s/marketplace-payouts', label: 'Lister payouts' },
      { to: '/admin/operators', label: 'Charter operators', roles: ['sales'] },
      { to: '/s/members', label: 'Members' },
      { to: '/s/invoices', label: 'Invoices' },
      { to: '/s/payments', label: 'Payments' },
    ],
  },
  {
    title: 'Operations', roles: ['ops', 'admin', 'sales'],
    links: [
      { to: '/o', label: 'Ops dashboard', end: true, roles: ['ops'] },
      { to: '/o/calendar', label: 'Fleet calendar', roles: ['ops', 'admin'] },
      { to: '/o/charters', label: 'Charters' },
      { to: '/o/maintenance', label: 'Maintenance', roles: ['ops', 'admin'] },
      { to: '/o/crew', label: 'Crew', roles: ['ops', 'admin'] },
      { to: '/o/aircraft', label: 'Aircraft', roles: ['ops', 'admin'] },
      { to: '/o/empty-legs', label: 'Empty legs', roles: ['ops'] },
      { to: '/s/members', label: 'Members', roles: ['ops'] },
      { to: '/s/invoices', label: 'Invoices', roles: ['ops'] },
    ],
  },
  {
    title: 'Administration', roles: ['admin'],
    links: [
      { to: '/admin/users', label: 'Users' },
      { to: '/admin/operators', label: 'Charter operators' },
      { to: '/admin/airports', label: 'Airports' },
      { to: '/admin/settings', label: 'Settings' },
    ],
  },
];

export default function StaffLayout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  const role = user?.role;
  const sections = SECTIONS.filter(s => s.roles.includes(role))
    .map(s => ({ ...s, links: s.links.filter(l => !l.roles || l.roles.includes(role)) }));

  return (
    <div className="shell">
      <div className="topbar">
        <Link to={homeFor(role)}><Wordmark sub={false} /></Link>
        <button className="icon-btn" onClick={() => setOpen(o => !o)} aria-label="Menu">☰ Menu</button>
      </div>
      <div className={`overlay ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-brand"><Link to={homeFor(role)}><Wordmark /></Link></div>
        <nav className="sidebar-nav">
          {role === 'admin' && (
            <div className="nav-group">
              <NavLink to="/admin" end className="nav-link">Overview</NavLink>
            </div>
          )}
          {sections.map(s => (
            <div className="nav-group" key={s.title}>
              <div className="nav-group-title">{s.title}</div>
              {s.links.map(l => (
                <NavLink key={l.to + l.label} to={l.to} end={l.end} className="nav-link">{l.label}</NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who">{user?.name}</div>
          <div className="role">{role}</div>
          <div className="muted xs" style={{ margin: '4px 0 10px', wordBreak: 'break-all' }}>{user?.email}</div>
          <button className="icon-btn" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        <div className="content"><Outlet /></div>
      </main>
    </div>
  );
}
