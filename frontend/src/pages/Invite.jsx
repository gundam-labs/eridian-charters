import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import api, { errText } from '../api';
import { useAuth, homeFor } from '../context/AuthContext';
import { ErrorAlert, Loading } from '../components/ui';
import { AuthArt } from './Login';

export default function Invite() {
  const { token } = useParams();
  const { applySession } = useAuth();
  const nav = useNavigate();
  const [invite, setInvite] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then(r => setInvite(r.data))
      .catch(e => setLoadErr(errText(e)));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (pw.length < 10) { setError('Password must be at least 10 characters.'); return; }
    if (pw !== pw2) { setError('Passwords do not match.'); return; }
    setSaving(true);
    try {
      const r = await api.post('/api/auth/accept-invite', { token, password: pw });
      const u = applySession(r.data);
      nav(homeFor(u.role), { replace: true });
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
          {!invite && !loadErr && <Loading label="Checking your invitation…" />}
          {loadErr && (
            <>
              <div className="eyebrow">Invitation</div>
              <h1>Link not valid</h1>
              <div className="alert alert-error" style={{ marginTop: 16 }}>{loadErr}</div>
              <p className="muted small">Invitation links expire after 72 hours. Ask your Meridian contact to send a fresh one.</p>
              <Link to="/login" className="btn">Go to sign in</Link>
            </>
          )}
          {invite && (
            <>
              <div className="eyebrow">Welcome{invite.name ? `, ${invite.name.split(' ')[0]}` : ''}</div>
              <h1>Set your password</h1>
              <p className="muted small">You’re activating access for <strong>{invite.email}</strong>.</p>
              <form className="stack-form" onSubmit={submit} style={{ marginTop: 20 }}>
                <ErrorAlert error={error} />
                <div className="field">
                  <label htmlFor="pw">New password</label>
                  <input id="pw" className="input" type="password" autoComplete="new-password" minLength={10} required value={pw} onChange={e => setPw(e.target.value)} />
                  <span className="hint">At least 10 characters.</span>
                </div>
                <div className="field">
                  <label htmlFor="pw2">Confirm password</label>
                  <input id="pw2" className="input" type="password" autoComplete="new-password" required value={pw2} onChange={e => setPw2(e.target.value)} />
                </div>
                <button className="btn btn-primary btn-block" disabled={saving}>{saving ? 'Activating…' : 'Activate account'}</button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
