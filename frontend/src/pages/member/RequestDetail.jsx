import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api, { errText } from '../../api';
import { useFetch } from '../../lib/useFetch';
import { normRequest } from '../../lib/normalize';
import { PageHead, ErrorAlert, Loading, Empty, StatusPill, OkAlert } from '../../components/ui';
import QuoteBreakdown from '../../components/QuoteBreakdown';
import LegsTable from '../../components/LegsTable';
import CancelModal from '../../components/CancelModal';
import { fmtDateTime } from '../../lib/format';

export default function RequestDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useFetch(`/api/quote-requests/${id}`);
  const req = normRequest(data);
  const [busy, setBusy] = useState('');
  const [actErr, setActErr] = useState('');
  const [declining, setDeclining] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  const accept = async (q) => {
    if (!window.confirm(`Accept ${q.quote_no}? This books the aircraft and issues your invoice.`)) return;
    setBusy(q.id); setActErr('');
    try {
      const r = await api.post(`/api/quotes/${q.id}/accept`);
      const ch = r.data?.charter;
      nav(ch?.id ? `/m/trips/${ch.id}?booked=1` : '/m/trips');
    } catch (e) { setActErr(errText(e)); } finally { setBusy(''); }
  };

  if (loading && !req) return <Loading />;
  if (error) return <ErrorAlert error={error} />;
  if (!req) return null;

  const quotes = (req.quotes || []).filter(q => q.status !== 'draft');
  const canCancel = ['open', 'quoted'].includes(req.status);

  return (
    <>
      <PageHead
        back={<Link to="/m/requests" className="back">← My requests</Link>}
        eyebrow={req.request_no}
        title={<>{req.legs?.[0]?.from} → {req.legs?.[req.legs.length - 1]?.to}</>}
        sub={<>{req.pax} passengers · submitted {fmtDateTime(req.created_at)} · <StatusPill status={req.status} /></>}
        actions={canCancel && <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel request</button>}
      />
      {params.get('created') && <OkAlert>Request received. Our charter desk will send you a quote shortly.</OkAlert>}
      <ErrorAlert error={actErr} />
      <div className="card">
        <div className="card-head"><h2>Itinerary</h2></div>
        <LegsTable legs={req.legs} />
        {req.notes && <div className="card-body small"><span className="label">Notes</span><div>{req.notes}</div></div>}
      </div>

      <h2 style={{ margin: '28px 0 14px' }}>Quotes</h2>
      {quotes.length === 0 ? (
        <div className="card"><Empty title={req.status === 'cancelled' ? 'Request cancelled' : 'Quote in preparation'}>
          {req.status === 'cancelled' ? 'This request was cancelled.' : 'We’re matching aircraft to your itinerary. You’ll receive an email when a quote is ready.'}
        </Empty></div>
      ) : quotes.map(q => (
        <div key={q.id} style={{ marginBottom: 16 }}>
          <QuoteBreakdown quote={q} defaultOpen={q.status === 'sent'}
            actions={q.status === 'sent' && (
              <>
                <button className="btn btn-gold btn-sm" disabled={!!busy} onClick={() => accept(q)}>{busy === q.id ? 'Accepting…' : 'Accept quote'}</button>
                <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => setDeclining(q)}>Decline</button>
              </>
            )}
          />
        </div>
      ))}
      {declining && (
        <CancelModal title={`Decline ${declining.quote_no}`} path={`/api/quotes/${declining.id}/decline`} requireReason={false}
          confirmLabel="Decline quote" onClose={() => setDeclining(null)} onDone={() => { setDeclining(null); reload(); }} />
      )}
      {cancelling && (
        <CancelModal title="Cancel request" path={`/api/quote-requests/${id}/cancel`} requireReason={false}
          confirmLabel="Cancel request" onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); reload(); }} />
      )}
    </>
  );
}
