import { useState } from 'react';
import { openPdf } from '../api';
import { StatusPill, ErrorAlert } from './ui';
import LineItems from './LineItems';
import LegsTable from './LegsTable';
import { fmtDateTime, inr, aircraftType, aircraftReg } from '../lib/format';

/** Quote summary card with breakdown, PDF and optional action buttons. */
export default function QuoteBreakdown({ quote, actions, staff, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [pdfErr, setPdfErr] = useState('');
  const pdf = async () => { setPdfErr(''); try { await openPdf(`/api/quotes/${quote.id}/pdf`); } catch (e) { setPdfErr(e.message); } };
  const acType = aircraftType(quote);
  return (
    <div className="card" data-testid="quote-card" data-quote-no={quote.quote_no}>
      <div className="card-head">
        <div>
          <div className="actions" style={{ gap: 10 }}>
            <h3>{quote.quote_no}</h3>
            <StatusPill status={quote.status} />
          </div>
          <div className="muted xs" style={{ marginTop: 4 }}>
            {acType}{staff && aircraftReg(quote) ? ` · ${aircraftReg(quote)}` : ''}
            {quote.seats ? ` · ${quote.seats} seats` : ''}
            {quote.valid_until && quote.status === 'sent' ? ` · valid until ${fmtDateTime(quote.valid_until)}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="muted xs">Total incl. GST</div>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: '1.7rem', fontWeight: 600, color: 'var(--navy-900)' }}>{inr(quote.total)}</div>
        </div>
      </div>
      <div className="card-body">
        <div className="actions">
          <button type="button" className="btn btn-sm" onClick={() => setOpen(o => !o)}>{open ? 'Hide breakdown' : 'Show breakdown'}</button>
          {quote.status !== 'draft' && <button type="button" className="btn btn-sm" onClick={pdf}>Quote PDF</button>}
          {actions}
        </div>
        <ErrorAlert error={pdfErr} />
        {open && (
          <div style={{ marginTop: 16 }} className="stack">
            {quote.legs && <LegsTable legs={quote.legs} positioning={quote.positioning} />}
            <LineItems quote={quote} />
          </div>
        )}
      </div>
    </div>
  );
}
