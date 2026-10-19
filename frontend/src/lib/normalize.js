// The spec describes some detail responses loosely ("request + its quotes", "charter … includes passengers, invoice, events").
// These helpers accept either a flat object or a wrapped one ({request, quotes} / {charter, passengers, …}).

export function normRequest(d) {
  if (!d) return null;
  if (d.request) return { ...d.request, quotes: d.quotes ?? d.request.quotes ?? [] };
  return { ...d, quotes: d.quotes ?? [] };
}

export function normCharter(d) {
  if (!d) return null;
  const base = d.charter ? { ...d.charter } : { ...d };
  for (const k of ['passengers', 'invoice', 'events', 'aircraft', 'member', 'crew']) {
    if (d[k] !== undefined && d.charter) base[k] = d[k];
  }
  base.passengers = base.passengers || [];
  base.events = base.events || [];
  return base;
}

export function normQuote(d) {
  if (!d) return null;
  return d.quote ? { ...d.quote, conflicts: d.conflicts ?? d.quote.conflicts } : d;
}

export function crewName(c, role) {
  // charter list/detail may provide captain_name or nested captain {name}
  const nested = c?.[role];
  if (nested && typeof nested === 'object') return nested.name;
  return c?.[`${role}_name`] || null;
}

/** GET /settings may return {key: value} or [{key, value}] */
export function normSettings(d) {
  if (!d) return {};
  if (Array.isArray(d)) return Object.fromEntries(d.map(r => [r.key, r.value]));
  if (d.settings) return normSettings(d.settings);
  return d;
}

export function normMember(d) {
  if (!d) return null;
  if (d.member) return { ...d.member, users: d.users ?? [], charters: d.charters ?? d.recent_charters ?? [], quotes: d.quotes ?? d.recent_quotes ?? [] };
  return { ...d, users: d.users ?? [], charters: d.charters ?? d.recent_charters ?? [], quotes: d.quotes ?? d.recent_quotes ?? [] };
}
