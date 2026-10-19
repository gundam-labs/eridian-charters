import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, homeFor } from '../context/AuthContext';
import { errText } from '../api';
import { ErrorAlert } from '../components/ui';
import Wordmark from '../components/Wordmark';

const DEMO = [
  ['admin@meridian.test', 'Admin'],
  ['sales@meridian.test', 'Sales'],
  ['ops@meridian.test', 'Ops'],
  ['pilot1@meridian.test', 'Pilot'],
  ['pilot2@meridian.test', 'Pilot'],
  ['arjun.mehra@example.in', 'Member · MC-1001'],
  ['rajiv.malhotra@example.in', 'Member · MC-1011'],
];
const DEMO_PASSWORD = 'Meridian@2026';
const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_ACCOUNTS === 'true';

export function AuthArt() {
  return (
    <div className="auth-art">
      <div className="auth-arc" /><div className="auth-arc two" />
      <Wordmark />
      <div>
        <h2>Whole-aircraft charter, <em>quietly</em> arranged.</h2>
        <p className="hide-sm" style={{ marginTop: 16 }}>
          A members-only service across India’s domestic network — Challenger, Praetor and Gulfstream jets,
          quoted per trip and flown on your schedule.
        </p>
      </div>
      <div className="hide-sm xs" style={{ color: '#7f8fa8', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
        DEL · BOM · BLR · HYD · MAA · GOI
      </div>
    </div>
  );
}

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const u = await login(email.trim(), password);
      const returnTo = params.get('returnTo');
      nav(returnTo && returnTo.startsWith(homeFor(u.role)) ? returnTo : homeFor(u.role), { replace: true });
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="auth">
      <AuthArt />
      <div className="auth-panel">
        <div className="auth-card">
          <div className="eyebrow">Members &amp; staff</div>
          <h1>Sign in</h1>
          <p className="muted small">Use the email address registered with Meridian Charters.</p>
          {params.get('expired') && <div className="alert alert-warn">Your session has ended. Please sign in again.</div>}
          <form className="stack-form" onSubmit={submit} style={{ marginTop: 20 }}>
            <ErrorAlert error={error} />
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-block" disabled={saving}>{saving ? 'Signing in…' : 'Sign in'}</button>
          </form>
          {SHOW_DEMO && (
            <details className="demo">
              <summary>Demo accounts</summary>
              <div className="demo-list">
                <div className="xs muted" style={{ padding: '0 8px 6px' }}>Password for all: <code>{DEMO_PASSWORD}</code> — click to fill.</div>
                {DEMO.map(([em, r]) => (
                  <button type="button" key={em} className="demo-row" onClick={() => { setEmail(em); setPassword(DEMO_PASSWORD); }}>
                    <span>{em}</span><span className="r">{r}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
