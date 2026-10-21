# Meridian Charters v1 — Build Spec (contract between backend and frontend)

Members-only, quote-based whole-aircraft charter system for a licensed Indian operator flying ~20 partner-owned jets on domestic routes.
Stack mirrors gundam-labs/erp-app: **frontend** React 18 + Vite + react-router-dom 6 + axios, plain CSS with CSS variables (no UI framework), deployed to **Vercel**; **backend** Node 22 + Express 4 + `pg` (raw parameterised SQL, no ORM) + jsonwebtoken + bcryptjs + helmet + cors + express-rate-limit + express-validator + pdfkit, deployed to **Railway** with Railway Postgres. Plain JavaScript (CommonJS in backend, ESM/JSX in frontend). No TypeScript.

## Repo layout
```
meridian-charters/
  SPEC.md  README.md  vercel.json (root, builds frontend)  .gitignore
  backend/  package.json  railway.toml  .env.example
    src/index.js            express app, /health (checks DB), mounts /api/*
    src/db/index.js         pool + initDB() (CREATE TABLE IF NOT EXISTS ..., idempotent)
    src/db/migrate.js       runs initDB, ends pool, exits (Railway preDeployCommand)
    src/db/seed.js          demo seed (idempotent; refuses unless SEED_DEMO=true or NODE_ENV=development)
    src/db/seed-data/members.csv
    src/middleware/auth.js  authenticate, requireRole(...roles)
    src/lib/pricing.js      pure pricing function (unit-testable, no DB)
    src/lib/email.js        SendGrid via fetch when SENDGRID_API_KEY, else console log; always logs to email_log
    src/lib/numbers.js      document numbering via sequences table
    src/lib/events.js       logEvent()
    src/routes/*.js
    tests/pricing.test.js   node:test unit tests for pricing
    tests/lifecycle.test.js node:test integration test hitting a running API (BASE_URL) through the full lifecycle
  frontend/ package.json vite.config.js index.html .env.example
    src/main.jsx App.jsx index.css api/index.js context/AuthContext.jsx components/* pages/*
```

## Conventions
- All times are IST. Store timestamps as `TIMESTAMPTZ`; API accepts and returns ISO 8601 strings. Leg departure input from the UI is a local IST datetime `YYYY-MM-DDTHH:mm`; backend interprets it as Asia/Kolkata (+05:30). DATE columns returned as `YYYY-MM-DD` strings (`types.setTypeParser(1082, v => v)`).
- Money: INR, stored as `NUMERIC(14,2)`, returned as numbers (parse in SQL with `::float8` or in JS). Frontend formats with `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR', maximumFractionDigits:0})`.
- Errors: `{ "error": "message" }` with proper status (400 validation, 401 unauthenticated, 403 wrong role/not your record, 404, 409 conflict/invalid state transition).
- List endpoints return plain arrays (data is small; no pagination in v1).
- Auth header `Authorization: Bearer <jwt>`. JWT payload `{ id, role }`, 12h expiry, secret `JWT_SECRET` (server refuses to start in NODE_ENV=production without it).
- CORS: allow origins from `CORS_ORIGINS` (comma-separated) plus http://localhost:5173.
- Every state change writes an `events` row.

## Roles
`admin`, `sales`, `ops`, `pilot`, `member`, `lister` (v1.3). Admin can do everything staff can. A `member` user is linked to one `members` row and only ever sees that member's records. A `lister` user is linked to one `listers` row and only ever sees that lister's flights and requests.

## Data model (Postgres, all ids UUID `gen_random_uuid()`, all tables have created_at TIMESTAMPTZ DEFAULT now())
- **members**: member_no TEXT UNIQUE (`MC-1001`…, from sequence), member_type (individual|corporate|agent), contact_name, company NULL, city, email UNIQUE, phone, gstin NULL, tier (silver|gold|platinum), status (active|inactive), member_since TEXT (`YYYY-MM`), past_charters INT DEFAULT 0, notes.
- **users**: email UNIQUE, name, role, member_id NULL FK members, password_hash NULL, is_active BOOL DEFAULT true, invite_token_hash NULL, invite_expires_at NULL, last_login_at NULL.
- **airports**: code TEXT PK (IATA, e.g. `BOM`), name, city, lat NUMERIC, lon NUMERIC, landing_fee_inr, handling_fee_inr.
- **aircraft**: registration UNIQUE (`VT-MCA`), type, seats INT, home_base FK airports.code, cruise_speed_kts INT, hourly_rate_inr, partner_name, status (active|inactive), notes.
- **crew_members**: name, crew_role (captain|first_officer|cabin_crew), base FK airports.code, licence_no NULL, user_id NULL FK users (links a pilot login), is_active.
- **quote_requests**: request_no (`RQ-2026-0001`), member_id, legs JSONB `[{from, to, depart_at}]` (1–6 legs), pax INT, notes, status (open|quoted|closed|cancelled), created_by user.
- **quotes**: quote_no (`Q-2026-0001`), request_id, member_id, aircraft_id, legs JSONB (request legs enriched with distance_nm, flight_hours, arrive_at), positioning JSONB (same shape, for positioning legs), line_items JSONB `[{code, description, qty, unit, rate, amount}]`, adjustment_inr NUMERIC DEFAULT 0, adjustment_note, subtotal, gst_rate_pct, gst_amount, total, valid_until TIMESTAMPTZ, status (draft|sent|accepted|declined|expired|withdrawn), sent_at, decided_at, created_by.
- **charters**: charter_no (`CH-2026-0001`), quote_id UNIQUE, member_id, aircraft_id, legs JSONB (from the quote; on flown each leg gets block_off, block_on), starts_on DATE (first departure date IST), ends_on DATE (last arrival date IST, incl. positioning back), pax, status (accepted|confirmed|manifest_complete|flown|closed|cancelled), captain_id NULL FK crew_members, first_officer_id NULL, cabin_crew_id NULL, ops_notes, defects TEXT NULL, confirmed_at, flown_at, closed_at, cancelled_at, cancel_reason.
- **passengers**: charter_id FK ON DELETE CASCADE, full_name, id_type (passport|aadhaar|driving_licence|voter_id|pan), id_number, nationality DEFAULT 'Indian', phone NULL.
- **invoices**: invoice_no (`INV-2026-0001`), charter_id UNIQUE, member_id, subtotal, gst_rate_pct, gst_amount, total, issued_on DATE, due_on DATE, status (unpaid|paid|cancelled), paid_on DATE NULL, payment_ref NULL.
- **maintenance_blocks**: aircraft_id, starts_on DATE, ends_on DATE (inclusive), reason, created_by.
- **settings**: key TEXT PK, value TEXT. Seeded defaults (insert if missing): `gst_rate_pct`=`12` (PLACEHOLDER — confirm with accountant), `night_halt_fee_inr`=`25000`, `quote_validity_hours`=`48`, `invoice_due_days`=`7`, `positioning_rate_pct`=`100`, `taxi_allowance_hours`=`0.3`, `manifest_cutoff_hours`=`24`.
- **sequences**: name PK, year INT, next INT — `nextNumber(prefix)` → `PREFIX-YYYY-0001`, atomic via `UPDATE … RETURNING` in a transaction. Members use their own counter starting at 1001 (`MC-1001`).
- **events**: entity_type, entity_id UUID, action TEXT, actor_user_id NULL, detail JSONB.
- **email_log**: to_email, subject, type, status (sent|logged|failed), error NULL.

## Pricing (src/lib/pricing.js, pure)
`priceQuote({ legs, aircraft, airports, settings, adjustment_inr=0 })` → `{ legs, positioning, line_items, subtotal, gst_rate_pct, gst_amount, total, starts_on, ends_on, warnings }`.
1. Per leg (passenger and positioning): great-circle distance (haversine, Earth radius 3440.065 nm) between airport lat/lon; `flight_hours = ceil10(distance_nm / cruise_speed_kts + taxi_allowance_hours)` where ceil10 rounds UP to 0.1. `arrive_at = depart_at + flight_hours`.
2. Positioning out: if legs[0].from ≠ aircraft.home_base → leg home_base→legs[0].from departing so it arrives 1h before legs[0].depart_at. Positioning back: if last leg's to ≠ home_base → leg last.to→home_base departing 1h after last arrival.
3. Line items (each `{code, description, qty, unit, rate, amount}`, amounts rounded to whole rupees):
   - `FLIGHT` — "Flight time", qty = sum passenger-leg hours, unit "hr", rate = hourly_rate_inr.
   - `POSITIONING` — "Positioning flights", qty = sum positioning hours, rate = hourly_rate × positioning_rate_pct/100 (omit if 0 hours).
   - `LANDING` — "Landing fees", one line per arrival airport across all legs incl. positioning (qty 1, rate = that airport's landing_fee_inr), description "Landing fee – BOM".
   - `HANDLING` — "Ground handling", one line per distinct airport touched by passenger legs (qty 1, rate = handling_fee_inr), description "Handling – BOM".
   - `NIGHT_HALT` — "Night halt (crew and aircraft)", qty = number of nights the aircraft is away from home base between consecutive passenger legs (difference in IST calendar dates between previous leg arrival and next leg departure, summed), rate = night_halt_fee_inr (omit if 0).
   - `ADJUSTMENT` — adjustment_note or "Adjustment", only if adjustment_inr ≠ 0, amount = adjustment_inr (may be negative).
4. subtotal = sum amounts; gst_amount = round(subtotal × gst_rate_pct/100); total = subtotal + gst_amount.
5. starts_on = IST date of first departure (positioning included); ends_on = IST date of final arrival (positioning back included).
6. warnings: `pax > seats` → "Passengers exceed aircraft seats"; unknown airport → throw 400.

## Availability
An aircraft is **busy** on a date if any charter with status in (accepted, confirmed, manifest_complete, flown) has starts_on ≤ date ≤ ends_on, or any maintenance block covers it, or aircraft.status = inactive. `conflicts(aircraft_id, starts_on, ends_on, excludeCharterId)` returns list `{kind:'charter'|'maintenance', ref, starts_on, ends_on}`.
- Creating/sending a quote with conflicts → allowed but response includes `conflicts`; **accepting** a quote whose aircraft now conflicts → 409 "Aircraft no longer available for these dates — contact sales". **Confirming** a charter with conflicts → 409.
- A crew member is busy if assigned to another non-cancelled, non-closed charter overlapping the dates → confirm returns 409 naming the crew member.

## State machine
quote_request: open → quoted (first quote sent) → closed (a quote accepted) | cancelled (member/sales).
quote: draft → sent → accepted | declined | expired (valid_until passed; evaluate lazily on read and on accept) | withdrawn (sales). Only draft quotes are editable (aircraft, adjustment, valid_until). Sending recomputes the price.
charter: accepted (on quote accept; invoice issued) → confirmed (ops; requires captain + first_officer assigned, no conflicts) → manifest_complete (member or ops submits manifest; requires 1..seats passengers, and passengers ≤ aircraft seats) → flown (pilot assigned to it, or ops; requires block_off/block_on for every passenger leg) → closed (automatically when its invoice is marked paid AND status is flown; also marking paid on a flown charter closes it). cancelled: from accepted|confirmed|manifest_complete by member (own) or ops/admin, with reason; invoice → cancelled.
Manifest may be edited while status is accepted or confirmed (and by ops also in manifest_complete).

## API (all under /api; JSON)
### Auth
- `POST /auth/login {email,password}` → `{token, user}` (user = `{id,email,name,role,member_id,member_no?}`); rate limited 10/15min/IP outside development.
- `GET /auth/me` → user.
- `POST /auth/accept-invite {token, password}` (password ≥ 10 chars) → `{token, user}`.
- `GET /auth/invite/:token` → `{email, name}` if valid (for the set-password page).
### Members (admin, sales; ops read)
- `GET /members?q=&type=&status=` → list with `user_status` ('none'|'invited'|'active').
- `GET /members/:id` → member + users + recent charters/quotes.
- `POST /members` → create (member_no auto). `PATCH /members/:id`.
- `POST /members/:id/invite` (admin, sales) → creates/refreshes member user with invite token (72h), emails link `${FRONTEND_URL}/invite/<token>`, returns `{invite_url}`.
### Users (admin)
- `GET /users`, `POST /users {email,name,role}` (staff roles only) → `{user, invite_url}`, `PATCH /users/:id {name, role, is_active}`, `POST /users/:id/invite`.
### Reference data
- `GET /airports` (any authed). `POST /airports`, `PATCH /airports/:code` (admin).
- `GET /aircraft` (staff; members get `GET /aircraft` too but only type/seats/home_base fields — no rates/partner). `POST /aircraft`, `PATCH /aircraft/:id` (admin, ops).
- `GET /aircraft/availability?from=YYYY-MM-DD&to=YYYY-MM-DD` (staff) → `{ days:[...dates], aircraft:[{id, registration, type, seats, home_base, status, cells:[{date, state:'free'|'charter'|'maintenance'|'inactive', ref?, label?}]}] }`. Max 62 days.
- `GET /crew` (staff), `POST /crew`, `PATCH /crew/:id` (admin, ops).
- `GET /maintenance?aircraft_id=` (staff), `POST /maintenance` (admin, ops; 409 if it overlaps a non-cancelled charter, unless `force:true`), `DELETE /maintenance/:id`.
- `GET /settings` (staff), `PATCH /settings {key:value,...}` (admin).
### Quote requests
- `POST /quote-requests {legs, pax, notes, member_id?}` — member creates for self; sales/admin may pass member_id. Validates: 1–6 legs, airports exist, from≠to, departures in the future and in order, pax 1..20.
- `GET /quote-requests?status=` — member sees own; sales/admin/ops all (with member name, quote count).
- `GET /quote-requests/:id` → request + its quotes (members see only sent/accepted/declined/expired quotes).
- `POST /quote-requests/:id/cancel` (owner member, sales, admin) — only if open|quoted.
### Quotes (sales, admin; member read/decide own)
- `POST /quotes/preview {request_id, aircraft_id, adjustment_inr?, adjustment_note?}` → priced result + `conflicts` (no write).
- `POST /quotes {request_id, aircraft_id, adjustment_inr?, adjustment_note?, valid_hours?}` → draft quote (priced).
- `PATCH /quotes/:id` (draft only) → re-price.
- `POST /quotes/:id/send` → status sent, sent_at, valid_until = now + valid_hours (default setting), request → quoted, email member.
- `POST /quotes/:id/withdraw` (sales/admin; sent or draft).
- `GET /quotes?status=&member_id=` — member: own non-draft only.
- `GET /quotes/:id` — member: own non-draft only. Members never see aircraft hourly rate or partner name, but do see line items.
- `POST /quotes/:id/accept` (member owner, or sales/admin on member's behalf) — must be sent and not expired; checks conflicts; in ONE transaction: quote accepted, other sent quotes on same request → withdrawn, request → closed, charter created (status accepted, legs = quote legs, starts/ends, pax), invoice created (unpaid, issued today, due today + invoice_due_days); emails member + logs events. → `{charter, invoice}`.
- `POST /quotes/:id/decline {reason?}` (member owner or sales/admin).
- `GET /quotes/:id/pdf` → application/pdf quote document (pdfkit) "Meridian Charters" header.
### Charters
- `GET /charters?status=&from=&to=` — member: own; pilot: only charters where they are captain/FO/cabin (via crew_members.user_id); sales/ops/admin: all. Include member name, aircraft registration/type, crew names, passenger count.
- `GET /charters/:id` — same visibility; includes passengers (member and pilot see id_number masked to last 4: `XXXX1234`; ops/admin/sales see full), invoice, events.
- `POST /charters/:id/assign {aircraft_id?, captain_id, first_officer_id, cabin_crew_id?}` (ops, admin) — allowed in accepted|confirmed|manifest_complete; changing aircraft re-checks seats and conflicts (does not re-price).
- `POST /charters/:id/confirm` (ops, admin) — accepted → confirmed (rules above), email member.
- `PUT /charters/:id/passengers {passengers:[{full_name,id_type,id_number,nationality?,phone?}]}` — replaces the list. Member owner (status accepted|confirmed) or ops/admin (also manifest_complete). Validates count ≤ seats, each field present. id_number entered in full; if an incoming id_number is masked (`XXXX…`) and matches an existing passenger by name, keep the stored number.
- `POST /charters/:id/manifest/submit` (member owner, ops, admin) — requires status confirmed (or accepted — allowed, moves to manifest_complete only after confirmed; if accepted return 409 "Ops must confirm the flight first"), 1..seats passengers → manifest_complete.
- `POST /charters/:id/flight-log {legs:[{index, block_off, block_on}], defects?}` (assigned pilot, ops, admin) — status manifest_complete → flown. block_on > block_off.
- `POST /charters/:id/cancel {reason}` — rules above.
### Pilot
- `GET /pilot/flights` → charters assigned to the current user's crew record, upcoming first, with legs, aircraft, pax count, passenger names (no id numbers), crew names.
### Invoices
- `GET /invoices?status=` — member own; sales/admin all; ops read all.
- `GET /invoices/:id/pdf` — GST tax invoice PDF (seller placeholder GSTIN from env `COMPANY_GSTIN`, member GSTIN if present).
- `POST /invoices/:id/mark-paid {paid_on, payment_ref}` (sales, admin) → paid; if charter flown → closed.
### Dashboard
- `GET /dashboard` (staff) → `{ open_requests, quotes_sent, quotes_expiring_24h, charters_next_7_days:[...], awaiting_confirmation, awaiting_manifest, unpaid_invoices_total, aircraft_in_maintenance_today, fleet_utilisation_30d_pct }`.
- `GET /dashboard/member` (member) → `{ upcoming_charters, open_requests, quotes_awaiting_decision, unpaid_invoices }`.
### Health
- `GET /health` (no /api prefix) → `{status:'ok', db:'ok', version}`; 503 if DB unreachable.

## Frontend screens (React Router; one SPA, role-based navigation, sidebar layout like erp-app; brand: deep navy #0b1b33 + gold accent #c9a24a; "Meridian Charters" wordmark text, no logo image)
Public: `/login`, `/invite/:token` (set password).
Member (`/m/...`): Home dashboard; **Request a quote** (multi-leg form: from/to airport selects, date-time, pax; add return leg button); My requests (list + detail with quotes, Accept/Decline buttons, quote breakdown, PDF link); My trips (charters list + detail: status timeline, legs, aircraft type, crew names once confirmed, **manifest editor** with Submit, Cancel trip); Invoices (list + PDF).
Sales (`/s/...`): Dashboard; Requests inbox (open first) → request detail → **Quote builder** (pick aircraft from list filtered to seats ≥ pax and showing availability for the dates, live preview of line items via /quotes/preview, adjustment, validity, Save draft / Send); Quotes list; Members (list, search, create/edit, Send invite → shows copyable invite link); Invoices (mark paid).
Ops (`/o/...`): Dashboard; **Fleet calendar** (aircraft rows × days grid, colour by state, 14/30-day range, click cell shows charter/maintenance); Charters board (by status) → charter detail (assign aircraft and crew dropdowns, Confirm, manifest view/edit, flight log entry, cancel); Maintenance (list, add block); Crew (list/add/edit); Aircraft (list/add/edit).
Pilot (`/p/...`): **My flights** (mobile-first cards: date, route, aircraft reg, pax count, crew; detail with passenger names and a flight-log form: block off/on per leg + defects → Submit).
Admin: everything above + Users (list/create staff/invite/deactivate) + Settings (edit settings keys) + Airports.
A staff user with role admin sees a sidebar with all sections. Status shown as coloured pills. Every list has an empty state. Forms show server error messages. Responsive down to 380px.
API base URL from `import.meta.env.VITE_API_URL` (empty in dev; Vite proxies /api to http://localhost:4000). Token in localStorage key `meridian_token`; 401 → logout and redirect to /login.

## Seed (backend/src/db/seed.js, idempotent upserts)
- Settings defaults; ~14 airports (DEL, BOM, BLR, HYD, MAA, CCU, GOI, COK, AMD, JAI, UDR, PNQ, IXC, LKO) with real lat/lon and plausible fees (landing 8,000–25,000 INR, handling 15,000–40,000 INR).
- 20 aircraft VT-MCA … VT-MCT: mix of "Bombardier Challenger 350" (10 seats, 450 kts, ₹3,40,000/hr), "Embraer Praetor 600" (12 seats, 466 kts, ₹3,60,000/hr), "Gulfstream G280" (10 seats, 459 kts, ₹3,80,000/hr); home bases DEL/BOM/BLR/HYD; partners fictional ("Aravalli Aviation Holdings", "Konkan Air Assets", "Deccan Jet Partners", "Coromandel Leasing").
- 30 crew members (captains, first officers, cabin crew) across bases.
- 25 members from seed-data/members.csv.
- Users (password for all demo users: `Meridian@2026`): admin@meridian.test (admin), sales@meridian.test (sales), ops@meridian.test (ops), pilot1@meridian.test & pilot2@meridian.test (pilot, linked to two captains), arjun.mehra@example.in (member MC-1001), rajiv.malhotra@example.in (member MC-1011).
- Sample flow data relative to today: 2 open requests, 1 sent quote, 1 accepted charter, 1 confirmed charter with manifest, 1 flown charter with unpaid invoice, 1 closed charter, 1 maintenance block.

---

# v1.1 — Empty legs (whole aircraft, public)

An **empty leg** is a positioning flight an aircraft must fly anyway with no passengers (out to the first departure, or back to base after the last arrival). Meridian sells it as a **whole-aircraft charter at a discount**, to members (instant booking) and to the **public** (booking request that sales confirms, which also onboards the buyer as a new member).

## Data model (add to initDB; must migrate an EXISTING production DB idempotently — use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `ALTER TABLE charters ALTER COLUMN quote_id DROP NOT NULL`)
- **empty_legs**: leg_no (`EL-2026-0001`), source_charter_id NULL FK charters (null = created manually), source_leg TEXT NULL ('positioning_out'|'positioning_back'), aircraft_id, from_code, to_code (FK airports), depart_earliest TIMESTAMPTZ, depart_latest TIMESTAMPTZ (the window the flight can leave in; generated legs use scheduled positioning departure −2h / +1h, clamped so it never conflicts with the source charter's passenger legs), flight_hours NUMERIC, distance_nm INT, seats INT (from aircraft), list_price_inr (what this flight would cost as a normal charter: hours × hourly rate + landing at destination + handling at both ends), price_inr (selling price excl. GST), status ('draft'|'published'|'booked'|'withdrawn'|'expired'), notes, published_at, booked_at, withdrawn_reason, created_by, created_at.
- **empty_leg_bookings**: booking_no (`ELB-2026-0001`), empty_leg_id, member_id NULL, channel ('member'|'public'), guest_name, guest_email, guest_phone, guest_company NULL, pax INT, message NULL, status ('requested'|'confirmed'|'rejected'|'cancelled'), charter_id NULL, decided_by NULL, decided_at NULL, reject_reason NULL, created_at.
- **charters**: `quote_id` becomes nullable; add `empty_leg_id UUID NULL REFERENCES empty_legs(id)`. A charter has exactly one of quote_id / empty_leg_id (enforce in code). Charters list/detail show "Empty leg EL-…" as their origin where relevant.
- **members**: add `source TEXT NOT NULL DEFAULT 'invited'` ('invited'|'empty_leg_public').
- settings defaults (insert if missing): `empty_leg_discount_pct`=`60` (price = list × (1 − 60%), rounded to nearest ₹1,000), `empty_leg_auto_publish`=`false`, `empty_leg_min_notice_hours`=`6` (not bookable when depart_latest − now is less than this).

## Rules
- **Generation**: when a charter is confirmed (`POST /charters/:id/confirm`), create `draft` empty legs for each positioning leg on its quote (if not already generated for that charter + source_leg). If `empty_leg_auto_publish` is true, publish them immediately. Also `POST /empty-legs/generate/:charterId` (sales/ops/admin) to (re)generate missing ones for an existing charter in accepted|confirmed|manifest_complete.
- **Manual**: sales/ops/admin may create one with aircraft, from, to, window, price (list_price computed via the pricing lib for one leg).
- **Publish/withdraw**: only draft → published; published|draft → withdrawn (reason). Editing (price, window within ±limits, notes) allowed while draft|published. A published leg whose `depart_latest − now < min_notice` reads as status `expired` (persist lazily on read).
- **Source charter cancelled** → its non-booked empty legs become withdrawn ("Source charter cancelled"); pending requests on them → cancelled + email guest. If an empty leg was already booked, do NOT cancel the derived charter automatically: add an event + ops_notes warning on the derived charter ("Source charter CH-… was cancelled — confirm this flight is still operating") and email sales.
- **Member booking** (instant): `POST /empty-legs/:id/book {pax}` (role member): leg must be published, not expired, pax 1..seats. In ONE transaction (lock the leg row `FOR UPDATE`): create booking (confirmed), create charter (status `accepted`, member, aircraft, legs = one leg {from,to,depart_at: depart_earliest, arrive_at, distance_nm, flight_hours}, starts_on/ends_on from that, pax, empty_leg_id, crew copied from the source charter if any), create invoice (price_inr + GST at the current gst_rate_pct, due per invoice_due_days), leg → booked, other `requested` bookings on the leg → rejected ("Booked by another customer") with email. 409 if already booked.
- **Public booking request**: `POST /public/empty-legs/:id/request {name, email, phone, company?, pax, message?, accept_terms:true, website:""}` (no auth; `website` is a honeypot — if non-empty, return 202 and do nothing). Validates email/phone/name, pax 1..seats, leg published and bookable, accept_terms true. Creates booking `requested`, emails the requester an acknowledgement and emails `SALES_EMAIL` (env; fallback: all active sales/admin users). Returns `{booking_no}`. Rate limit 5 per hour keyed by IP + email. Multiple requests per leg allowed; first confirmed wins.
- **Confirm a public request** (sales/admin): `POST /empty-legs/bookings/:id/confirm`. In one transaction: find member by email (case-insensitive) or create one (member_type individual or corporate if company given, tier silver, status active, source empty_leg_public, member_since current YYYY-MM), then same as member booking (charter + invoice + leg booked + reject other requests), then create/refresh the member's invite (72h) and email the invite link + booking confirmation. Response includes `{charter, invoice, member, invite_url}`.
- **Reject**: `POST /empty-legs/bookings/:id/reject {reason}` → email guest.
- **Conflicts**: the derived charter flies inside the source charter's dates on the same aircraft. `conflicts()` and crew-busy checks must ignore the pair (source charter ↔ charters with empty_leg_id whose empty leg has that source_charter_id) in both directions. Manual legs check normally.
- Confirming the derived charter (ops) works like any charter (needs crew; copies from source when present).

## API additions
Public (no auth, no rates/partner/registration/aircraft id exposed — only aircraft type, seats, from/to code + city + airport name, window, flight_hours, price_inr, list_price_inr, savings_pct, leg_no, id):
- `GET /api/public/empty-legs?from=&to=&month=YYYY-MM` → published & bookable, soonest first.
- `GET /api/public/empty-legs/:id` → one (404 if not published/bookable).
- `POST /api/public/empty-legs/:id/request` (above).
Authenticated:
- `GET /api/empty-legs?status=` — staff: all with source charter no, bookings count, pending requests count; member: published & bookable only (same shape as public plus `can_book`).
- `GET /api/empty-legs/:id` — staff: with bookings and source charter; member: published only.
- `POST /api/empty-legs` (manual), `PATCH /api/empty-legs/:id`, `POST /api/empty-legs/:id/publish`, `POST /api/empty-legs/:id/withdraw {reason}`, `POST /api/empty-legs/generate/:charterId` — sales, ops, admin.
- `POST /api/empty-legs/:id/book {pax}` — member.
- `GET /api/empty-legs/bookings?status=` — sales/ops/admin (with leg summary). `POST /api/empty-legs/bookings/:id/confirm`, `POST /api/empty-legs/bookings/:id/reject {reason}` — sales, admin.
- `GET /api/charters/:id` additionally returns `empty_legs` (legs generated from it, staff only) and `empty_leg` (if derived).
- `GET /api/dashboard` adds `empty_legs: { published, pending_requests, booked_90d, revenue_recovered_90d_inr, positioning_hours_sold_pct_90d }` (sold = booked legs' flight_hours / all generated legs' flight_hours with source charters starting in the last 90 days).

## Frontend additions
- **Public page `/empty-legs`** (no login; linked from the login page: "Empty-leg deals — no membership needed"): Meridian-branded header with "Member sign in" link; filters (from, to, month); cards showing route with city names, date + departure window in IST, aircraft type and seats, flight time, price incl. "+ GST", struck-through list price and "Save N%"; detail `/empty-legs/:id` with a booking-request form (name, email, phone, company optional, passengers select up to seats, message, terms checkbox: "Empty legs depend on the operator's main charter and may be retimed or withdrawn; the booking is confirmed only when Meridian Charters confirms it", hidden honeypot field `website`). On success show the booking number and what happens next. Mobile-first, looks premium (this is the marketing page an investor will see). Empty state when nothing is listed. Page `<title>` set.
- **Member**: nav item "Empty legs" (`/m/empty-legs`) listing the same cards with a "Book now" button → confirm dialog with pax → on success navigate to the new trip.
- **Sales & ops**: nav item "Empty legs" (`/s/empty-legs`, `/o/empty-legs`, both same page) with tabs: Listings (table: leg no, route, window, aircraft reg, list price, price, discount %, status pill, source charter link, requests count; actions publish / edit price & window / withdraw; "New empty leg" form) and Requests (table of public/member bookings with Confirm / Reject; confirm shows the invite link with a copy button).
- **Ops charter detail**: section "Empty legs from this charter" with status and a "Generate" button if none.
- **Staff dashboard**: an "Empty legs" card with the dashboard numbers (published, pending requests, revenue recovered 90d, % positioning hours sold).

## Seed additions (idempotent)
- For the seeded confirmed charter(s) with positioning: generated empty legs; publish them so the public page is never empty. Plus 2 manual published legs on popular routes (e.g. DEL→JAI, BOM→GOI) 1–3 weeks out, 1 draft leg, and 1 public pending request from a fictional person (example.in email) on a published leg.

---

# v1.2 — Payments (Razorpay)

Decided by Krishna, 20 Oct 2026: Razorpay; full payment due **24 hours before the first departure**; Meridian **absorbs** gateway fees (no surcharge); refunds on cancellation by the member: **100% if more than 7 days before first departure, 50% from 48 hours to 7 days, 0% inside 48 hours**; **no corporate credit** (everyone pays before flying).

## Principles
- The **server** sets every amount (from the invoice balance). Money is in **paise** (integer) at the provider boundary and in rupees (NUMERIC(14,2)) in our tables.
- A payment counts only when the **provider confirms it server-side**: a verified webhook (HMAC-SHA256 of the RAW body with the webhook secret, header `X-Razorpay-Signature`) or a verified Checkout signature (HMAC-SHA256 of `order_id + "|" + payment_id` with the key secret) followed by fetching the payment from the API and checking `status = captured` and amount. Browser "success" alone never marks anything paid.
- **Idempotent**: webhook events stored by `x-razorpay-event-id` (unique); payments unique by provider payment id. Replays are no-ops.
- Meridian never sees or stores card data.
- Secrets only from env: `PAYMENTS_PROVIDER` (`razorpay` | `mock`, default `mock`), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. With `PAYMENTS_PROVIDER=razorpay` the server refuses to start unless all three are set.

## Provider abstraction (`src/lib/payments/`)
`index.js` exports `provider()` returning one of:
- **razorpay.js** — calls `https://api.razorpay.com/v1` with Basic auth (`key_id:key_secret`) using `fetch` (no SDK): `createOrder({amount_paise, receipt, notes})` → `POST /orders` (`currency:'INR'`, `payment_capture: 1`); `fetchPayment(id)` → `GET /payments/:id` (returns `amount`, `status`, `method`, `fee`, `tax`, `order_id`); `createVirtualAccount({name, notes})` → `POST /virtual_accounts` with `receivers:{types:['bank_account']}` (response `receivers[]` entity `bank_account`: `account_number`, `ifsc`, `name`, `bank_name`); `refund(payment_id, amount_paise, notes)` → `POST /payments/:id/refund`; `verifyWebhook(rawBody, signature)`; `verifyCheckout(order_id, payment_id, signature)`. All HTTP errors → our `HttpError(502, 'Payment provider error: …')` without leaking secrets.
- **mock.js** — same interface, no network, for local dev, tests and the live demo until Razorpay keys exist: ids like `order_mock_…`, `pay_mock_…`, `va_mock_…`; virtual account numbers `2223330` + 9 digits, IFSC `RATN0VAAPIS`; fees computed as 2% + 18% GST of the fee for card/UPI/netbanking, 0 for bank transfer; webhook secret `mock_webhook_secret` (or env) and the same HMAC verification as Razorpay so the webhook path is exercised for real. Mock checkout = an in-app simulated payment screen (frontend) that calls `POST /api/payments/mock/complete` (only when provider is mock) which builds a Razorpay-shaped `payment.captured` event, signs it, and feeds it through the SAME webhook handler. Likewise `POST /api/payments/mock/bank-transfer {invoice_id, amount}` (admin/sales only, mock only) simulates a `virtual_account.credited` event.

## Data model (idempotent migration, like v1.1)
- **payment_orders**: invoice_id, provider, provider_order_id UNIQUE, amount (₹), status (created|paid|expired|failed), created_by, created_at.
- **payments**: invoice_id, provider, provider_payment_id UNIQUE, provider_order_id NULL, virtual_account_id NULL, method (card|upi|netbanking|wallet|bank_transfer|emi|other), amount (₹), fee (₹, provider fee incl. GST, absorbed by Meridian), status (captured|refunded|partially_refunded), captured_at, raw JSONB (provider entity, minus anything card-sensitive — keep id, method, amount, fee, tax, status, bank/vpa reference only).
- **refunds**: payment_id FK, provider_refund_id UNIQUE, amount (₹), reason, policy_pct, status (pending|processed|failed), created_by, created_at.
- **webhook_events**: provider, event_id UNIQUE, event_type, received_at, processed_at, error NULL.
- **virtual_accounts**: member_id UNIQUE, provider, provider_va_id UNIQUE, account_number, ifsc, bank_name, account_name, status (active|closed), created_at.
- **invoices**: add `amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0`, `due_at TIMESTAMPTZ` (= first departure − 24h, from the charter legs), extend status CHECK to (unpaid|partially_paid|paid|cancelled|refunded). Existing `paid_on`/`payment_ref` stay; manual "mark paid" by sales still works (records a `payments` row with method `bank_transfer`, provider `manual`).
- **charters**: add `payment_status` is NOT stored — derive from the invoice.
- settings defaults: `payment_due_hours_before_departure`=`24`, `refund_full_days`=`7`, `refund_half_hours`=`48`, `refund_half_pct`=`50`, `empty_leg_payment_window_hours`=`2`.

## Rules
- **Invoice due_at** = first departure (positioning included? NO — first PASSENGER departure) − 24h. Set when the invoice is created (quote accept, empty-leg booking/confirm). Migration back-fills existing unpaid invoices.
- **Empty legs**: due_at = min(first departure − 24h, booking time + 2h); if first departure − 24h is already in the past at booking, due_at = booking time + 2h (late bookings must pay within 2 hours).
- **Payment applied** (webhook `payment.captured` or `order.paid`, or `virtual_account.credited`): find the invoice via order notes `invoice_id` (orders) or via the virtual account's member → oldest unpaid/partially_paid invoice of that member (bank transfers); insert payment (idempotent), add to `amount_paid`; status → `partially_paid` or `paid` (paid when amount_paid ≥ total − ₹1); set paid_on; log events; email the member a receipt; if the charter is `flown` and invoice paid → close the charter (existing rule). Over-payment: record it, status paid, flag an event `overpaid` for sales.
- **Deadline enforcement**: a job every 5 minutes (setInterval in the server, plus on charter/invoice reads) auto-cancels charters in accepted|confirmed|manifest_complete whose invoice is not fully paid and `due_at` has passed: charter → cancelled (`cancel_reason` "Not paid by the deadline"), aircraft released (existing cancel side-effects, including empty-leg cascade), any part payment refunded in full, member emailed. Reminder emails at due_at − 48h and due_at − 6h (once each; track in events).
- **Pilot flight log** and **ops confirm**: ops may confirm crew before payment; the **flight log submit is refused (409) unless the invoice is paid** ("Charter not paid"). Charter detail shows payment status for all roles.
- **Cancellation refunds** (on `POST /charters/:id/cancel`): hours = first passenger departure − now. Cancelled by the **member**: pct = 100 if hours > 7×24, 50 if hours ≥ 48, else 0. Cancelled by **ops/admin**: pass `refund_pct` (0–100, default 100 — operator cancellation refunds in full). Refund = pct × amount_paid, split across payments newest first, via provider refunds; invoice status → `refunded` (pct>0) or `cancelled`; refunds rows; email. The cancel endpoint's response includes `{refund: {pct, amount}}`; add `GET /api/charters/:id/cancellation-quote` returning `{pct, refund_amount, amount_paid}` so the UI can show it BEFORE confirming.
- Fees are absorbed: record `fee` per payment; dashboard shows payment fees.

## API
- `GET /api/payments/config` (auth) → `{provider:'razorpay'|'mock', key_id}` (key_id only for razorpay; never the secret).
- `POST /api/invoices/:id/pay` (member owner; sales/admin may too) → creates a provider order for the outstanding balance (reuse an existing `created` order with the same amount made < 30 min ago) → `{order_id, amount_paise, currency:'INR', key_id, provider, invoice_no, prefill:{name,email,contact}, description}`. 409 if invoice paid/cancelled or due_at passed.
- `POST /api/payments/verify` `{razorpay_order_id, razorpay_payment_id, razorpay_signature}` (auth) → verifies the Checkout signature, fetches the payment, applies it (same idempotent function as the webhook) → `{invoice}`. (Speeds up UX; the webhook is still the source of truth.)
- `POST /api/payments/webhook/razorpay` — NO auth, raw body (`express.raw({type:'application/json'})` mounted BEFORE `express.json`), verifies signature (401 on mismatch), dedupes by `x-razorpay-event-id`, handles `payment.captured`, `order.paid`, `virtual_account.credited`, `refund.processed`, `refund.failed`; always 200 after a verified, stored event (errors stored in `webhook_events.error`, never retried forever).
- `GET /api/members/me/bank-transfer` (member) → creates the member's virtual account on first call → `{account_name, account_number, ifsc, bank_name}`; staff: `GET /api/members/:id/bank-transfer`.
- `GET /api/invoices/:id` adds `amount_paid`, `balance`, `due_at`, `payments[]` (method, amount, captured_at; fee only for staff), `refunds[]`.
- `GET /api/payments?from=&to=` (sales/admin) → payments with invoice/member, fee; totals.
- Mock-only: `POST /api/payments/mock/complete {order_id, method:'card'|'upi'|'netbanking'}` (the order's owner or staff), `POST /api/payments/mock/bank-transfer {member_id, amount}` (sales/admin).
- Dashboard (staff) adds `payments: {collected_30d, fees_30d, unpaid_due_48h_count, unpaid_due_48h_amount}`.

## Frontend
- **Member trip / invoices**: a payment card on the trip page and invoice list: total, paid, balance, **"Pay by … (date, IST)"** countdown, status pill (Unpaid / Part paid / Paid / Refunded). Two tabs: **Bank transfer (recommended for amounts above ₹5 lakh)** showing the member's account name, number, IFSC with copy buttons and the line "Transfers are matched automatically, usually within minutes"; **Card, UPI or netbanking** → `POST /invoices/:id/pay` → Razorpay Checkout (load `https://checkout.razorpay.com/v1/checkout.js` on demand; options key, amount, currency, order_id, name "Meridian Charters", description, prefill, theme color `#171032`; handler → `POST /payments/verify` → refresh) — or, when provider is `mock`, an in-app "Test payment" modal (clearly labelled TEST MODE) with method choice that calls `/payments/mock/complete`. Note UPI's ₹5 lakh per-payment travel limit in the UI when balance > ₹5 lakh.
- **Cancellation dialog** (member and ops): fetch `cancellation-quote` and show "You will receive ₹X back (N%)" before confirming; ops/admin can choose the refund % (default 100).
- **Sales**: a **Payments** page (`/s/payments`) listing payments with method, amount, fee, invoice, member; a "Simulate bank transfer" action in mock mode on a member's page; invoices list gains Paid/Balance/Due columns.
- **Ops charter detail**: payment status badge; pilot flight-log button disabled with "Awaiting payment" when unpaid.
- **Dashboard**: a payments card (collected 30 days, fees absorbed, unpaid due within 48 h).
- **Public empty-leg confirmation emails/pages** mention payment within 2 hours for late bookings (text only).

## Seed (idempotent)
Back-fill: closed/flown charters' invoices paid via seeded `payments` (method mix: ~70% bank_transfer, 20% card, 10% upi; fees per mock rules); future charters: some paid, some unpaid with due_at in the future; one partially paid. Virtual accounts for the two demo members.

# v1.3 — Listers (empty-leg marketplace)

Charter operators, travel agents and private flyers sign up themselves and post empty legs on aircraft **outside** the Meridian fleet. The public searches and requests them on the existing deals page; the lister confirms. Meridian's own fleet legs work exactly as in v1.1.

## Principles
- **No Meridian charter, invoice or payment for a lister leg.** The lister (or their operator) flies the aircraft and takes payment; the platform introduces the customer. `bookLegTx` refuses lister legs.
- **Verified before live.** A new lister is `pending`: they can sign in and save drafts but cannot publish or confirm until sales/admin approve them.
- **Contact after commitment.** Before confirming, a lister sees the traveller's name, company, party size and message — not their email or phone. Confirming reveals both sides' contact details.
- **Isolation.** Every lister query is scoped to `req.user.lister_id`; listers cannot reach any staff or member endpoint.

## Data model (idempotent migration, like v1.1)
- `users.role` CHECK gains `lister` (constraint rewritten only when it lacks it).
- `listers`: user_id (unique, → users), lister_type `operator|agent|flyer`, company (required for operator/agent), phone, city, gstin (optional, validated), nsop_permit_no (required for operators), about, status `pending|approved|rejected|suspended`, decided_by, decided_at, decision_reason.
- `empty_legs`: `aircraft_id` becomes nullable; adds `lister_id` (→ listers), `ext_aircraft_type`, `ext_registration` (never public), `operator_name`. CHECK `num_nonnulls(aircraft_id, lister_id) = 1`.

## Rules
- Lister legs: route from the airports table; window ≤ 24 h and in the future; seats 1–30; price > 0; optional "usual charter price" (list) — when absent, list = price so no saving is claimed. Flight time given by the lister or estimated at 400 kts + taxi allowance.
- Publish requires an approved lister and the usual minimum notice; expiry is the same lazy expiry as fleet legs.
- Confirm (lister, approved only): locks the leg, marks the booking `confirmed` and the leg `booked`, rejects other pending requests. Emails the customer the operator's contact details.
- Suspend (sales/admin): withdraws the lister's draft/published/expired legs and cancels their pending requests. A rejected lister who edits their profile returns to `pending`.
- Staff can see and withdraw lister legs (the lister is emailed) and reject requests on them, but cannot edit, publish or confirm them.
- Public and member shapes gain `operated_by` (lister's operator name or company; "Meridian Charters" for fleet legs) and `marketplace`. Members get `can_book: false, request_only: true` on lister legs.

## API
- `POST /auth/register` (public, 5/hour/IP, honeypot `website`): {name, email, password ≥10, lister_type, company, phone, city, gstin, nsop_permit_no, about, accept_terms:true} → 201 {token, user}. 409 on an existing email. Emails the lister and `LISTER_REVIEW_EMAIL` (or all admin/sales).
- `/auth/login` and `/auth/me` include `lister_id, lister_type, lister_status, lister_company` for listers.
- Lister (`role=lister`): `GET|PATCH /lister/me`, `GET /lister/airports`, `GET|POST /lister/empty-legs`, `GET|PATCH /lister/empty-legs/:id`, `POST /lister/empty-legs/:id/publish|withdraw`, `GET /lister/bookings?status=`, `POST /lister/bookings/:id/confirm|reject`.
- Review (sales, admin): `GET /listers?status=`, `GET /listers/:id`, `POST /listers/:id/approve|reject|suspend` (reason required for reject/suspend).
- `GET /empty-legs?source=fleet|listers` (staff filter). Public request on a lister leg notifies the lister instead of sales.

## Frontend
- `/register` — "List your empty legs" sign-up (type picker; company and NSOP fields appear by type). Linked from the login page and the public header/footer.
- `/l` lister portal (top nav): **My empty legs** (status banner, stats, post/edit/publish/withdraw), **Requests** (confirm/decline; contact shown after confirming), **Profile**.
- `/s/listers` (sales, admin): review queue with approve/reject/suspend/reinstate.
- Staff empty-legs page: source filter, "Listed by …" on lister legs, no edit/publish/confirm for them.
- Public card and detail show "Operated by …" and marketplace terms on lister legs; member page links lister legs to the public request form.

## Seed (idempotent)
Approved operator `ops@skyhopaviation.example.in` (SkyHop Aviation) with two published legs; pending travel agent `desk@wanderlusttravels.example.in`.

# v1.4 — Charter operator directory

The DGCA "List of Non-Scheduled Operators" (as on 31.08.2026) loaded as a directory of every NSOP holder and its registered aircraft — the starting point for recruiting operators as listers and for verifying the ones who sign up. Read-only for now; enrichment comes later.

## Data
- Source PDF parsed by `scripts/parse_dgca_nsop.py` into `backend/src/db/seed-data/dgca-nsop-operators-2026-08-31.json`: 139 operators, 471 aircraft. Every operator's aircraft rows match the "No. of Aircraft's" column; S.No. 1–139 has no gaps; registrations are unique.
- PDF quirks handled: each page after the first carries a hidden copy of operator #1's first row (removed character-for-character); cell lines split by a page break are printed on both pages (de-duplicated); e-mail addresses wrapped mid-word are re-joined.
- `charter_operators` (aop_no unique, name, address, pincode, phone, fax, emails[], aop_valid_until, fleet_type, aircraft_count, source, source_as_of, source_sno, in_latest_list, website, notes) and `operator_aircraft` (registration unique, kind fixed_wing|rotary_wing|hot_air_balloon, model, seats, role passenger|aerial_work|cargo, seats_raw). `data_imports` records the loaded list version.

## Import
`npm run import:operators` (`src/db/import-operators.js`) runs on every start/deploy after migrate. Idempotent: skipped when the list version is already loaded (`--force` to re-run); upserts operators by AOP number without touching website/notes; operators missing from a newer list are kept with `in_latest_list = false`; aircraft are upserted by registration (they follow the operator that now lists them) and aircraft an operator no longer lists are removed.

## API (admin, sales)
- `GET /operators?q=&fleet_type=&listed=all` → { operators (with fixed/rotary counts, max seats, models), totals, source }. `q` searches name, address, AOP, e-mail, aircraft model and registration.
- `GET /operators/:id` → operator, aircraft, and listers whose NSOP permit matches its AOP number.
- `GET /listers` and `/listers/:id` add `dgca_operator` — the directory entry whose AOP number (number + year) matches the lister's NSOP permit.

## Frontend
- **Administration → Charter operators** (`/admin/operators`, also in the Sales menu): totals, search, fleet filter, AOP validity flags (expired / renewal due within 6 months), detail with full fleet.
- Lister review shows "Match / No match" against the DGCA list, linking to the operator.

# v1.5 — Lister PAN and TAN

- `listers.pan`, `listers.tan` (idempotent `ADD COLUMN IF NOT EXISTS`).
- PAN required for operators and travel agents, optional for private flyers; format `AAAAA9999A` with a valid holder-type 4th letter. TAN optional; format `AAAA99999A`. Spaces are stripped and letters upper-cased.
- When both a GSTIN and a PAN are given, GSTIN characters 3–12 must equal the PAN (checked at sign-up and on profile edits).
- Shown on the sign-up form, the lister's profile and the staff review dialog; never on public pages.

# v1.6 — Marketplace payments, confirmation deadline, route alerts, DGCA aircraft check

Ideas taken from the EchorTech empty-leg platform proposal (Sept 2026): payment hold captured on operator confirmation, split settlement, a confirmation time limit, route alerts, and refund rules for empty legs.

## Payment hold on lister flights
- A public request on a **lister** flight creates the booking as `pending_payment` and a Razorpay order with **manual capture** (`payment.capture = manual`, hold = checkout + confirmation window + 60 min, max 5 days). The traveller lands on `/b/:token` (secret token) and authorises the payment; only then the booking becomes `requested` and the lister is emailed. Meridian fleet flights are unchanged.
- Amount = lister price + GST at `gst_rate_pct`. Shown on the public flight ("Request and hold ₹X").
- Lister **confirms** → the hold is **captured** in the same transaction (a failed capture confirms nothing). Commission = `marketplace_commission_pct` (10%) of the base fare; payout = amount − commission, status `pending`.
- Any request that closes without confirmation (declined, deadline passed, flight withdrawn, lister suspended, another traveller confirmed) releases its hold via a DB trigger (`release_booking_hold`), so no code path can forget. Razorpay has no void call: an uncaptured authorisation is refunded automatically when its hold period ends. A payment that arrives after the checkout expired is recorded and released.
- Unfinished checkouts expire after `marketplace_checkout_minutes` (30).

## Confirmation deadline
- `respond_by` = authorisation time + `lister_confirm_hours` (2), never later than departure − minimum notice. Listers see a countdown; past the deadline confirm returns 409 and the job closes the request ("The operator did not confirm in time") and emails the traveller.

## Cancellations and refunds (lister flights)
- Lister cancels a confirmed flight (`charter_change` | `weather_technical` | `other`) → 100% refund, payout cancelled, reason kept (`cancel_reason_type`, for a future trust score).
- Staff cancel (`/marketplace/bookings/:id/cancel`): traveller → 80% > 72 h, 50% at 24–72 h, 0 < 24 h (`traveller_refund_72h_pct`, `traveller_refund_24h_pct`); operator / charter change / force majeure → 100%; `refund_pct` overrides. Payout re-worked on the amount kept.

## Payouts
- Flown: lister marks it (after departure) or the job completes it 12 h after the departure window → payout `due`.
- With a Razorpay **Route** linked account on the lister (`razorpay_account_id`, set on the Listers page) the payout is transferred automatically (`POST /payments/:id/transfers`); otherwise finance pays by bank transfer and records the UTR (`/s/marketplace-payouts`). Listers see their earnings at `/l/payouts`.

## Route alerts
- Public form on the deals page (from/to, optional dates, email; honeypot; 10/hour/IP; max 10 active per email). Matching flights are emailed when published (fleet publish, auto-published generation, lister publish) and on sign-up for flights already live; once per alert per flight. Unsubscribe at `/alerts/stop/:token`. Staff **Demand** tab on Empty legs lists wanted routes with live-flight counts.

## DGCA aircraft check
- Lister listing form looks the registration up in the DGCA directory (`/lister/aircraft-lookup`) and fills model, seats and "Operated by". Listings store `dgca_check` = own_fleet | other_operator | not_listed, shown to the lister and staff. Aircraft registered for cargo are refused.

## Jobs
- `runMarketplaceJobs` runs with the 5-minute deadline job and (throttled, 30 s) on lister/payout reads.

## Razorpay setup for production
1. Keep `PAYMENTS_PROVIDER=razorpay` with live keys; subscribe the webhook to `payment.authorized`, `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed` (plus the existing events).
2. Manual capture is requested per order; the dashboard's capture settings need not change.
3. For automatic payouts, enable **Route** on the Razorpay account and create a linked account per lister (KYC in the Razorpay dashboard); paste its `acc_…` id on the lister.
4. Confirm the GST treatment of commission and of fares collected on behalf of operators with the accountant.
