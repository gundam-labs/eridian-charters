/**
 * Quote and GST tax invoice PDFs (pdfkit). Simple, clean, A4.
 * Built-in Helvetica has no ₹ glyph, so amounts render as "Rs 1,23,456" (en-IN grouping).
 */
const PDFDocument = require('pdfkit');
const { fmtIST } = require('./time');

const NAVY = '#0b1b33';
const GOLD = '#c9a24a';
const GREY = '#64748b';

const inr = (n) => {
  const v = Math.round(Number(n) || 0);
  return `${v < 0 ? '-' : ''}Rs ${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(v))}`;
};
const qtyFmt = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(Number(n) || 0);
const dateFmt = (d) => (d ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) : '—');

function header(doc, title, number) {
  doc.rect(0, 0, doc.page.width, 90).fill(NAVY);
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(22).text('Meridian Charters', 50, 30);
  doc.fillColor('#ffffff').font('Helvetica').fontSize(9).text('Members-only private aviation · Domestic India', 50, 58);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(14).text(title, 300, 30, { width: 245, align: 'right' });
  doc.font('Helvetica').fontSize(10).text(number, 300, 52, { width: 245, align: 'right' });
  doc.fillColor(NAVY).moveDown();
  doc.y = 110;
}

function kv(doc, x, y, pairs, width = 240) {
  let yy = y;
  for (const [k, v] of pairs) {
    doc.font('Helvetica').fontSize(8).fillColor(GREY).text(k.toUpperCase(), x, yy, { width });
    doc.font('Helvetica').fontSize(10).fillColor(NAVY).text(v ?? '—', x, yy + 10, { width });
    yy = doc.y + 6;
  }
  return yy;
}

function table(doc, cols, rows, { y } = {}) {
  const left = 50;
  let yy = y ?? doc.y;
  const totalW = cols.reduce((s, c) => s + c.w, 0);
  doc.rect(left, yy, totalW, 18).fill('#eef1f6');
  let x = left;
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8);
  for (const c of cols) { doc.text(c.label, x + 4, yy + 5, { width: c.w - 8, align: c.align || 'left' }); x += c.w; }
  yy += 20;
  doc.font('Helvetica').fontSize(9);
  for (const r of rows) {
    if (yy > doc.page.height - 120) { doc.addPage(); yy = 50; }
    x = left;
    let rowH = 14;
    for (const [i, c] of cols.entries()) {
      const h = doc.heightOfString(String(r[i] ?? ''), { width: c.w - 8 });
      rowH = Math.max(rowH, h + 4);
    }
    for (const [i, c] of cols.entries()) { doc.fillColor(NAVY).text(String(r[i] ?? ''), x + 4, yy + 2, { width: c.w - 8, align: c.align || 'left' }); x += c.w; }
    yy += rowH;
    doc.moveTo(left, yy).lineTo(left + totalW, yy).lineWidth(0.5).strokeColor('#e2e8f0').stroke();
  }
  doc.y = yy + 8;
  return doc.y;
}

function totals(doc, { subtotal, gst_rate_pct, gst_amount, total }, gstLabel = 'GST') {
  const x = 330;
  let y = doc.y + 4;
  const line = (label, value, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor(NAVY);
    doc.text(label, x, y, { width: 120 });
    doc.text(value, x + 120, y, { width: 95, align: 'right' });
    y += bold ? 18 : 15;
  };
  line('Subtotal', inr(subtotal));
  line(`${gstLabel} @ ${qtyFmt(gst_rate_pct)}%`, inr(gst_amount));
  doc.moveTo(x, y).lineTo(x + 215, y).lineWidth(1).strokeColor(GOLD).stroke();
  y += 4;
  line('Total', inr(total), true);
  doc.y = y + 6;
}

function legRows(legs, withBlock = false) {
  return (legs || []).map((l, i) => {
    const row = [String(i + 1), `${l.from} – ${l.to}`, fmtIST(l.depart_at), l.arrive_at ? fmtIST(l.arrive_at) : '—', l.distance_nm != null ? `${l.distance_nm} nm` : '—', l.flight_hours != null ? `${qtyFmt(l.flight_hours)} h` : '—'];
    if (withBlock) row.push(l.block_off ? `${fmtIST(l.block_off)} – ${fmtIST(l.block_on).slice(-5)}` : '');
    return row;
  });
}

const LEG_COLS = [
  { label: '#', w: 22 }, { label: 'Route', w: 85 }, { label: 'Departs (IST)', w: 110 }, { label: 'Arrives (IST)', w: 110 },
  { label: 'Distance', w: 83, align: 'right' }, { label: 'Block', w: 85, align: 'right' },
];
const LINE_COLS = [
  { label: 'Description', w: 235 }, { label: 'Qty', w: 55, align: 'right' }, { label: 'Unit', w: 50 },
  { label: 'Rate', w: 75, align: 'right' }, { label: 'Amount', w: 80, align: 'right' },
];
const lineRows = (items) => (items || []).map((li) => [li.description, qtyFmt(li.qty), li.unit, inr(li.rate), inr(li.amount)]);

function footer(doc, text) {
  doc.font('Helvetica').fontSize(8).fillColor(GREY);
  doc.text(text, 50, doc.page.height - 70, { width: doc.page.width - 100, align: 'center' });
}

/** Stream a quote PDF to `out`. `q` must already be member-safe (no rates/partner on aircraft). */
function quotePdf(q, settings, out) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Quote ${q.quote_no}`, Author: 'Meridian Charters' } });
  doc.pipe(out);
  header(doc, 'CHARTER QUOTATION', q.quote_no);
  const y0 = doc.y;
  kv(doc, 50, y0, [
    ['Prepared for', `${q.member_name}${q.member_company ? `\n${q.member_company}` : ''}`],
    ['Member no.', q.member_no],
    ['Request', q.request_no],
  ]);
  const y1 = kv(doc, 310, y0, [
    ['Aircraft', `${q.aircraft?.type || ''} (${q.aircraft?.seats || '?'} seats)`],
    ['Passengers', String(q.pax ?? '—')],
    ['Valid until', q.valid_until ? `${fmtIST(q.valid_until)} IST` : 'On sending'],
    ['Status', String(q.status || '').toUpperCase()],
  ]);
  doc.y = Math.max(doc.y, y1) + 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Itinerary', 50);
  table(doc, LEG_COLS, legRows(q.legs), { y: doc.y + 4 });
  if (q.positioning?.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY).text('Positioning (aircraft only)', 50);
    table(doc, LEG_COLS, legRows(q.positioning), { y: doc.y + 4 });
  }
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Price breakdown', 50);
  table(doc, LINE_COLS, lineRows(q.line_items), { y: doc.y + 4 });
  totals(doc, q);
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(
    'Whole-aircraft charter. Flight times are estimates (great-circle distance at cruise speed plus taxi allowance); positioning and crew night halts are included where applicable. ' +
    'Subject to aircraft availability at acceptance, operational and regulatory approvals, and weather. All times IST.',
    50, doc.y + 10, { width: 495 });
  footer(doc, 'Meridian Charters · This is a quotation, not a tax invoice.');
  doc.end();
}

/** Stream a GST tax invoice PDF to `out`. */
function invoicePdf(inv, out) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.invoice_no}`, Author: 'Meridian Charters' } });
  doc.pipe(out);
  header(doc, 'TAX INVOICE', inv.invoice_no);
  const sellerGstin = process.env.COMPANY_GSTIN || '27AAAAA0000A1Z5 (placeholder)';
  const sellerAddr = process.env.COMPANY_ADDRESS || 'Meridian Charters Pvt Ltd, Mumbai, Maharashtra';
  const y0 = doc.y;
  kv(doc, 50, y0, [
    ['Supplier', `Meridian Charters\n${sellerAddr}`],
    ['Supplier GSTIN', sellerGstin],
    ['Service', 'Non-scheduled passenger air transport (charter)'],
  ]);
  const y1 = kv(doc, 310, y0, [
    ['Bill to', `${inv.member_company || inv.member_name}${inv.member_company ? `\nAttn: ${inv.member_name}` : ''}${inv.member_city ? `\n${inv.member_city}` : ''}`],
    ['Recipient GSTIN', inv.member_gstin || 'Unregistered'],
    ['Member no.', inv.member_no],
  ]);
  doc.y = Math.max(doc.y, y1) + 4;
  const y2 = doc.y;
  kv(doc, 50, y2, [['Invoice date', dateFmt(inv.issued_on)], ['Due date', dateFmt(inv.due_on)]]);
  const y3 = kv(doc, 310, y2, [
    ['Charter', `${inv.charter_no} (${inv.quote_no ? `quote ${inv.quote_no}` : `empty leg ${inv.empty_leg_no}`})`],
    ['Aircraft', `${inv.aircraft_type} · ${inv.aircraft_registration}`],
  ]);
  doc.y = Math.max(doc.y, y3) + 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Flights', 50);
  table(doc, LEG_COLS, legRows(inv.legs), { y: doc.y + 4 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text('Charges', 50);
  table(doc, LINE_COLS, lineRows(inv.line_items), { y: doc.y + 4 });
  totals(doc, inv);
  const status = String(inv.status || '').toUpperCase();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(inv.status === 'paid' ? '#15803d' : inv.status === 'cancelled' ? '#b91c1c' : GOLD)
    .text(`${status}${inv.status === 'paid' && inv.paid_on ? ` on ${dateFmt(inv.paid_on)}${inv.payment_ref ? ` · Ref ${inv.payment_ref}` : ''}` : ''}`, 50, doc.y + 6);
  doc.font('Helvetica').fontSize(8).fillColor(GREY).text(
    'Amounts in Indian Rupees. GST rate shown is as configured and must be confirmed by the company accountant before use. ' +
    'Place of supply and CGST/SGST vs IGST split to be confirmed. Computer-generated invoice.',
    50, doc.y + 14, { width: 495 });
  footer(doc, `Meridian Charters · GSTIN ${sellerGstin}`);
  doc.end();
}

module.exports = { quotePdf, invoicePdf, inr };
