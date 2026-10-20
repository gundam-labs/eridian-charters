import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import api, { errText } from '../api';
import { useAuth, homeFor } from '../context/AuthContext';
import { ErrorAlert } from '../components/ui';
import Wordmark from '../components/Wordmark';

export const LISTER_TYPES = [
  { value: 'operator', label: 'Charter operator', hint: 'You hold a DGCA NSOP permit and fly the aircraft.' },
  { value: 'agent', label: 'Travel agent', hint: 'You sell charters for operators and clients.' },
  { value: 'flyer', label: 'Private flyer', hint: 'You booked a charter and its return or positioning leg is empty.' },
];

export const LISTER_TERMS = 'I confirm the flights I list are real and that I have the right to sell them. I will honour bookings I confirm, '
  + 'and I understand that payment, passenger details and the flight itself are arranged between me (or my operator) and the customer.';

function ListerArt() {
  return (
    <div className="auth-art">
      <div className="auth-arc" /><div className="auth-arc two" />
      <Wordmark />
      <div>
        <h2>Fill the <em>empty</em> leg.</h2>
        <p className="hide-sm" style={{ marginTop: 16 }}>
          Operators, travel agents and private flyers list one-way and positioning flights for free.
          Travellers find them on our empty-leg deals page and send you a booking request.
        </p>
        <ul className="hide-sm reg-points">
          <li>Post a flight in two minutes</li>
          <li>You approve every booking</li>
          <li>Customer contact shared when you confirm</li>
        </ul>
      </div>
      <div className="hide-sm xs" style={{ color: '#7f8fa8', letterSpacing: '0.14em', textTransform: 'uppercase' }}>
        Verified listers only · DGCA NSOP operators
      </div>
    </div>
  );
}

export default function Register() {
  const { user, applySession } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({
    lister_type: '', name: '', email: '', phone: '', company: '', city: '', nsop_permit_no: '', gstin: '', pan: '', tan: '', password: '', password2: '', website: '',
  });
  const [agree, setAgree] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));
  const needsCompany = ['operator', 'agent'].includes(f.lister_type);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!f.lister_type) { setError('Choose whether you are a charter operator, travel agent or private flyer.'); return; }
    if (needsCompany && !f.pan.trim()) { setError('Please enter your company’s PAN.'); return; }
    if (f.password.length < 10) { setError('Password must be at least 10 characters.'); return; }
    if (f.password !== f.password2) { setError('Passwords do not match.'); return; }
    if (!agree) { setError('Please accept the lister terms.'); return; }
    setSaving(true);
    try {
      const { password2, ...body } = f;
      const r = await api.post('/api/auth/register', {
        ...body,
        email: f.email.trim(),
        company: needsCompany ? f.company : '',
        nsop_permit_no: f.lister_type === 'operator' ? f.nsop_permit_no : '',
        accept_terms: true,
      });
      if (!r.data?.token) { setError('Registration could not be completed. Please try again.'); return; }
      applySession(r.data);
      nav('/l?welcome=1', { replace: true });
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="auth">
      <ListerArt />
      <div className="auth-panel">
        <div className="auth-card reg-card">
          <div className="eyebrow">List your empty legs</div>
          <h1>Create a lister account</h1>
          <p className="muted small">Free to join. We verify every account before its listings go live.</p>
          <form className="stack-form" onSubmit={submit} style={{ marginTop: 20 }} noValidate>
            <fieldset className="reg-types">
              <legend>I am a…</legend>
              {LISTER_TYPES.map(t => (
                <label key={t.value} className={`reg-type ${f.lister_type === t.value ? 'on' : ''}`}>
                  <input type="radio" name="lister_type" value={t.value} checked={f.lister_type === t.value} onChange={set('lister_type')} />
                  <span className="t">{t.label}</span>
                  <span className="h">{t.hint}</span>
                </label>
              ))}
            </fieldset>

            <div className="form-grid">
              <div className="field span-2">
                <label htmlFor="r-name">Your full name</label>
                <input id="r-name" className="input" autoComplete="name" required value={f.name} onChange={set('name')} />
              </div>
              {needsCompany && (
                <div className="field span-2">
                  <label htmlFor="r-company">{f.lister_type === 'operator' ? 'Operator (company) name' : 'Agency name'}</label>
                  <input id="r-company" className="input" autoComplete="organization" required value={f.company} onChange={set('company')} />
                </div>
              )}
              {f.lister_type === 'operator' && (
                <div className="field span-2">
                  <label htmlFor="r-nsop">DGCA NSOP permit number</label>
                  <input id="r-nsop" className="input" required value={f.nsop_permit_no} onChange={set('nsop_permit_no')} placeholder="e.g. 07/2019, as on your AOP" />
                  <span className="hint">We check it against the DGCA list of non-scheduled operators.</span>
                </div>
              )}
              <div className="field">
                <label htmlFor="r-email">Email</label>
                <input id="r-email" className="input" type="email" autoComplete="email" required value={f.email} onChange={set('email')} />
              </div>
              <div className="field">
                <label htmlFor="r-phone">Mobile</label>
                <input id="r-phone" className="input" type="tel" autoComplete="tel" required value={f.phone} onChange={set('phone')} placeholder="+91 98765 43210" />
              </div>
              <div className="field">
                <label htmlFor="r-city">City <span className="muted">— optional</span></label>
                <input id="r-city" className="input" autoComplete="address-level2" value={f.city} onChange={set('city')} />
              </div>
              <div className="field">
                <label htmlFor="r-pan">PAN{!needsCompany && <span className="muted"> — optional</span>}</label>
                <input id="r-pan" className="input" value={f.pan} onChange={set('pan')} maxLength={10} required={needsCompany}
                  placeholder="ABCDE1234F" style={{ textTransform: 'uppercase' }} />
                <span className="hint">{needsCompany ? 'Your company’s PAN.' : 'Your PAN.'}</span>
              </div>
              <div className="field">
                <label htmlFor="r-tan">TAN <span className="muted">— optional</span></label>
                <input id="r-tan" className="input" value={f.tan} onChange={set('tan')} maxLength={10}
                  placeholder="MUMA12345B" style={{ textTransform: 'uppercase' }} />
                <span className="hint">If you deduct TDS.</span>
              </div>
              <div className="field">
                <label htmlFor="r-gstin">GSTIN <span className="muted">— optional</span></label>
                <input id="r-gstin" className="input" value={f.gstin} onChange={set('gstin')} maxLength={15} style={{ textTransform: 'uppercase' }} />
              </div>
              <div className="field">
                <label htmlFor="r-pw">Password</label>
                <input id="r-pw" className="input" type="password" autoComplete="new-password" minLength={10} required value={f.password} onChange={set('password')} />
                <span className="hint">At least 10 characters.</span>
              </div>
              <div className="field">
                <label htmlFor="r-pw2">Confirm password</label>
                <input id="r-pw2" className="input" type="password" autoComplete="new-password" required value={f.password2} onChange={set('password2')} />
              </div>
            </div>
            {/* Honeypot — hidden from people, filled in by bots */}
            <input type="text" name="website" value={f.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hp" />
            <label className="check el-terms">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />
              <span>{LISTER_TERMS}</span>
            </label>
            <ErrorAlert error={error} />
            <button className="btn btn-primary btn-block" disabled={saving}>{saving ? 'Creating account…' : 'Create account'}</button>
            <p className="small muted center">Already registered? <Link to="/login">Sign in</Link></p>
          </form>
        </div>
      </div>
    </div>
  );
}
