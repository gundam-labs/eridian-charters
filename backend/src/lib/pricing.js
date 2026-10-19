/**
 * Pure quote pricing (no DB, no I/O). See SPEC.md "Pricing".
 *
 * priceQuote({ legs, aircraft, airports, settings, adjustment_inr = 0, adjustment_note })
 *   legs:      [{ from, to, depart_at }]  depart_at = 'YYYY-MM-DDTHH:mm' (IST) or ISO with offset
 *   aircraft:  { seats, home_base, cruise_speed_kts, hourly_rate_inr }
 *   airports:  { CODE: { lat, lon, landing_fee_inr, handling_fee_inr } } or an array of airport rows
 *   settings:  { gst_rate_pct, night_halt_fee_inr, positioning_rate_pct, taxi_allowance_hours }
 *   pax:       optional — enables the 'Passengers exceed aircraft seats' warning
 *   adjustment_note: optional label for the ADJUSTMENT line
 * → { legs, positioning, line_items, subtotal, gst_rate_pct, gst_amount, total, starts_on, ends_on, warnings }
 */
const { parseIST, istDate, toISTISO, daysBetween } = require('./time');

const EARTH_RADIUS_NM = 3440.065;
const HOUR_MS = 3600 * 1000;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in nautical miles (haversine). */
function haversineNm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Round UP to one decimal place (epsilon guards float noise like 1.2000000001). */
const ceil10 = (x) => Math.ceil(x * 10 - 1e-9) / 10;
const round1 = (x) => Math.round(x * 10) / 10;
const rupees = (x) => Math.round(x);

function indexAirports(airports) {
  if (Array.isArray(airports)) return Object.fromEntries(airports.map((a) => [a.code, a]));
  return airports || {};
}

function priceQuote({ legs, aircraft, airports, settings = {}, adjustment_inr = 0, adjustment_note = null, pax = null }) {
  if (!Array.isArray(legs) || legs.length === 0) throw badRequest('At least one leg is required');
  if (!aircraft) throw badRequest('Aircraft is required');
  const ap = indexAirports(airports);
  const taxi = Number(settings.taxi_allowance_hours ?? 0.3);
  const speed = Number(aircraft.cruise_speed_kts);
  const rate = Number(aircraft.hourly_rate_inr);
  const home = aircraft.home_base;

  const airport = (code) => {
    const a = ap[code];
    if (!a) throw badRequest(`Unknown airport: ${code}`);
    return a;
  };

  // Build a leg with distance, block hours and arrival. departMs is epoch millis.
  const buildLeg = (from, to, departMs) => {
    const a = airport(from);
    const b = airport(to);
    const nm = haversineNm({ lat: Number(a.lat), lon: Number(a.lon) }, { lat: Number(b.lat), lon: Number(b.lon) });
    const distance_nm = Math.round(nm);
    const flight_hours = ceil10(nm / speed + taxi);
    const arriveMs = departMs + Math.round(flight_hours * HOUR_MS);
    return { from, to, depart_at: toISTISO(departMs), distance_nm, flight_hours, arrive_at: toISTISO(arriveMs), _d: departMs, _a: arriveMs };
  };

  airport(home);
  const pricedLegs = legs.map((l, i) => {
    const d = parseIST(l.depart_at);
    if (!d) throw badRequest(`Leg ${i + 1}: invalid depart_at`);
    return buildLeg(l.from, l.to, d.getTime());
  });

  // Positioning
  const first = pricedLegs[0];
  const last = pricedLegs[pricedLegs.length - 1];
  let posOut = null;
  let posBack = null;
  if (first.from !== home) {
    // Work out the block time first, then depart so it arrives 1h before the first passenger departure.
    const hours = buildLeg(home, first.from, 0).flight_hours;
    posOut = buildLeg(home, first.from, first._d - HOUR_MS - Math.round(hours * HOUR_MS));
  }
  if (last.to !== home) posBack = buildLeg(last.to, home, last._a + HOUR_MS);
  const positioning = [posOut, posBack].filter(Boolean);

  // Line items
  const line_items = [];
  const flightHours = round1(pricedLegs.reduce((s, l) => s + l.flight_hours, 0));
  line_items.push({ code: 'FLIGHT', description: 'Flight time', qty: flightHours, unit: 'hr', rate, amount: rupees(flightHours * rate) });

  const posHours = round1(positioning.reduce((s, l) => s + l.flight_hours, 0));
  if (posHours > 0) {
    const posRate = rate * Number(settings.positioning_rate_pct ?? 100) / 100;
    line_items.push({ code: 'POSITIONING', description: 'Positioning flights', qty: posHours, unit: 'hr', rate: posRate, amount: rupees(posHours * posRate) });
  }

  // Landing: one line per arrival, chronological (positioning out, passenger legs, positioning back)
  const allLegs = [...(posOut ? [posOut] : []), ...pricedLegs, ...(posBack ? [posBack] : [])];
  for (const l of allLegs) {
    const fee = Number(airport(l.to).landing_fee_inr) || 0;
    line_items.push({ code: 'LANDING', description: `Landing fee – ${l.to}`, qty: 1, unit: 'landing', rate: fee, amount: rupees(fee) });
  }

  // Handling: one line per distinct airport touched by passenger legs (first-seen order)
  const touched = [];
  for (const l of pricedLegs) for (const c of [l.from, l.to]) if (!touched.includes(c)) touched.push(c);
  for (const c of touched) {
    const fee = Number(airport(c).handling_fee_inr) || 0;
    line_items.push({ code: 'HANDLING', description: `Handling – ${c}`, qty: 1, unit: 'airport', rate: fee, amount: rupees(fee) });
  }

  // Night halt: IST calendar nights between consecutive passenger legs while away from home base
  let nights = 0;
  for (let i = 1; i < pricedLegs.length; i++) {
    const prev = pricedLegs[i - 1];
    if (prev.to === home) continue; // aircraft is back at base — no halt away
    const n = daysBetween(istDate(prev._a), istDate(pricedLegs[i]._d));
    if (n > 0) nights += n;
  }
  if (nights > 0) {
    const fee = Number(settings.night_halt_fee_inr ?? 25000);
    line_items.push({ code: 'NIGHT_HALT', description: 'Night halt (crew and aircraft)', qty: nights, unit: 'night', rate: fee, amount: rupees(nights * fee) });
  }

  const adj = Number(adjustment_inr) || 0;
  if (adj !== 0) {
    line_items.push({ code: 'ADJUSTMENT', description: adjustment_note || 'Adjustment', qty: 1, unit: 'lump', rate: rupees(adj), amount: rupees(adj) });
  }

  const subtotal = line_items.reduce((s, li) => s + li.amount, 0);
  const gst_rate_pct = Number(settings.gst_rate_pct ?? 12);
  const gst_amount = rupees(subtotal * gst_rate_pct / 100);
  const total = subtotal + gst_amount;

  const startMs = Math.min(...allLegs.map((l) => l._d));
  const endMs = Math.max(...allLegs.map((l) => l._a));

  const warnings = [];
  if (pax != null && Number(pax) > Number(aircraft.seats)) warnings.push('Passengers exceed aircraft seats');

  const strip = ({ _d, _a, ...rest }) => rest;
  return {
    legs: pricedLegs.map(strip),
    positioning: positioning.map(strip),
    line_items,
    subtotal,
    gst_rate_pct,
    gst_amount,
    total,
    starts_on: istDate(startMs),
    ends_on: istDate(endMs),
    warnings,
  };
}

module.exports = { priceQuote, haversineNm, ceil10 };
