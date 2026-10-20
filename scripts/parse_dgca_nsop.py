"""
Usage: python3 scripts/parse_dgca_nsop.py <dgca-list.pdf> backend/src/db/seed-data/dgca-nsop-operators-<as-of>.json
(needs pdfplumber). Then update DGCA_FILE in backend/src/db/import-operators.js.

Parse the DGCA "List of Non-Scheduled Operators" PDF (an Excel print) into JSON.

Quirk handled: every page after the first carries a hidden copy of operator #1's first row (the
Excel print-title rows), painted over by cell fills. Its characters sit at exactly the same positions
as on page 1, so they are removed one-for-one before reading the page.
"""
import json, re, sys
from collections import Counter
import pdfplumber

SRC = sys.argv[1]
OUT = sys.argv[2]

# Column x-boundaries (pt), from the ruled cells of the header.
COLS = [('sno', 51, 81), ('name', 81, 187), ('contact', 187, 293), ('aop', 293, 338), ('valid', 338, 379),
        ('count', 379, 421), ('fleet', 421, 463), ('type', 463, 530), ('model', 530, 630), ('reg', 630, 684), ('seats', 684, 731)]
BODY_TOP = 140
BODY_BOTTOM = 590


def col_of(x):
    for name, a, b in COLS:
        if a - 0.5 <= x < b:
            return name
    return None


pdf = pdfplumber.open(SRC)
first = pdf.pages[0]
# Template = page-1 characters of the first data row band (operator #1, up to the start of operator #2).
op2_top = min(w['top'] for w in first.extract_words() if w['text'] == '2' and w['x0'] < 81 and w['top'] > BODY_TOP)
template = Counter((c['text'], round(c['x0'], 1), round(c['top'], 1)) for c in first.chars if BODY_TOP <= c['top'] < op2_top - 1)


def clean_page(page, pn):
    if pn == 0:
        return page
    budget = Counter(template)

    def keep(obj):
        if obj.get('object_type') != 'char':
            return True
        k = (obj['text'], round(obj['x0'], 1), round(obj['top'], 1))
        if budget[k] > 0:
            budget[k] -= 1
            return False
        return True
    return page.filter(keep)


# Collect body words (page, top, col, text, bold) in reading order across the whole document.
items = []
for pn, page in enumerate(pdf.pages):
    p = clean_page(page, pn)
    words = p.extract_words(extra_attrs=['fontname'], keep_blank_chars=False, use_text_flow=False, x_tolerance=1.5)
    # The bold face (operator names) is whatever font the header "OPERATOR'S" uses on this page.
    bold_font = next(w['fontname'] for w in words if w['text'] == "OPERATOR'S")
    for w in words:
        if not (BODY_TOP <= w['top'] < BODY_BOTTOM):
            continue
        c = col_of(w['x0'])
        if not c:
            continue
        items.append({'page': pn, 'top': round(w['top'], 1), 'x0': w['x0'], 'col': c, 'text': w['text'],
                      'bold': w.get('fontname') == bold_font})

# Global vertical ordinal so a record can spill onto the next page.
for it in items:
    it['y'] = it['page'] * 1000 + it['top']
items.sort(key=lambda i: (i['y'], i['x0']))

starts = [i for i in items if i['col'] == 'sno' and re.fullmatch(r'\d{1,3}', i['text'])]
ops = []
for idx, s in enumerate(starts):
    y0 = s['y'] - 3  # first line sits ~same top as the S.No
    y1 = starts[idx + 1]['y'] - 3 if idx + 1 < len(starts) else 10 ** 9
    ops.append({'sno': int(s['text']), 'y0': y0, 'y1': y1, 'page': s['page'] + 1})


def lines(ws):
    out = []
    for w in sorted(ws, key=lambda i: (i['y'], i['x0'])):
        if out and abs(out[-1][0] - w['y']) < 2.5:
            out[-1][1].append(w)
        else:
            out.append([w['y'], [w]])
    res = []
    for y, ws_ in out:
        t = ' '.join(x['text'] for x in ws_)
        # A cell line cut by a page break is printed on both pages: drop the repeat.
        if res and res[-1][1] == t and int(res[-1][0] // 1000) != int(y // 1000):
            continue
        res.append((y, t))
    return res


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


records = []
for op in ops:
    mine = [i for i in items if op['y0'] <= i['y'] < op['y1']]
    by = lambda c: [i for i in mine if i['col'] == c]
    namew = by('name')
    name_lines = lines([w for w in namew if w['bold']])
    addr_lines = lines([w for w in namew if not w['bold']])
    contact = '\n'.join(t for _, t in lines(by('contact')))
    # Contact parsing: Tel / Fax / E-mail labels, values may wrap.
    flat = contact.replace('\n', ' ')
    m_tel = re.search(r'Tel\s*[:.]?\s*(.*?)(?=Fax|E\s*-?\s*m\s*a\s*i\s*l|$)', flat, re.I)
    m_fax = re.search(r'Fax\s*[:.]?\s*(.*?)(?=E\s*-?\s*m\s*a\s*i\s*l|$)', flat, re.I)
    m_mail = re.search(r'E\s*-?\s*m\s*a\s*i\s*l\s*(?:ID)?\s*[:.]?\s*(.*)$', contact, re.I | re.S)
    emails = []
    if m_mail:
        # Emails wrap at the cell edge mid-address ("…@mspllimited.c" / "om"): glue each line onto the
        # previous one unless both already hold an '@' (a second address). Spaces inside are artefacts.
        buf = []
        for piece in [re.sub(r'\s+', '', x) for x in m_mail.group(1).split('\n')]:
            if not piece:
                continue
            if buf and not ('@' in buf[-1] and '@' in piece):
                buf[-1] += piece
            else:
                buf.append(piece)
        emails = [e for b in buf for e in re.findall(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}', b)]
    aircraft = []
    regs = sorted([i for i in mine if i['col'] == 'reg'], key=lambda i: i['y'])
    reg_rows = []
    for r in regs:
        if reg_rows and abs(reg_rows[-1]['y'] - r['y']) < 2.5:
            reg_rows[-1]['text'] += ' ' + r['text']
        else:
            reg_rows.append({'y': r['y'], 'text': r['text']})
    for k, r in enumerate(reg_rows):
        ya = r['y'] - 3
        yb = reg_rows[k + 1]['y'] - 3 if k + 1 < len(reg_rows) else op['y1']
        cell = lambda c: norm(' '.join(t for _, t in lines([i for i in mine if i['col'] == c and ya <= i['y'] < yb])))
        aircraft.append({'type': cell('type'), 'model': cell('model'), 'registration': norm(r['text']), 'seats': cell('seats')})
    records.append({
        'sno': op['sno'], 'page': op['page'],
        'name': norm(' '.join(t for _, t in name_lines)),
        'address': norm(' '.join(t for _, t in addr_lines)),
        'contact_raw': contact,
        'phone': norm(m_tel.group(1)) if m_tel else '',
        'fax': norm(m_fax.group(1)) if m_fax else '',
        'emails': emails,
        'aop_no': norm(' '.join(t for _, t in lines(by('aop')))),
        'valid_upto': norm(' '.join(t for _, t in lines(by('valid')))),
        'aircraft_count': norm(' '.join(t for _, t in lines(by('count')))),
        'fleet': norm(' '.join(t for _, t in lines(by('fleet')))),
        'aircraft': aircraft,
    })

# ── Normalise ───────────────────────────────────────────────────────────────
FLEET = {'FW': 'fixed_wing', 'RW': 'rotary_wing', 'MF': 'mixed', 'HAB': 'hot_air_balloon', 'B': 'hot_air_balloon'}
KIND = {'FW': 'fixed_wing', 'RW': 'rotary_wing', 'B': 'hot_air_balloon'}
NA = {'', 'N/A', 'NA', 'NIL', '-'}


def clean_contact(v):
    v = norm(v).strip(' ,;')
    return None if v.upper() in NA else v


out = []
for r in records:
    name, address = r['name'], r['address']
    if address.startswith('.'):  # "Pvt. Ltd" + "." that wrapped into the (non-bold) address cell
        name, address = name + '.', address[1:].lstrip(' ,')
    name = name.rstrip(' ,')
    pin = re.findall(r'(?<!\d)(\d{3}\s?\d{3})(?!\d)', address)
    d, m, y = r['valid_upto'].split('.')
    aircraft = []
    for a in r['aircraft']:
        seats_txt = a['seats']
        mm = re.match(r'^(\d+)', seats_txt)
        aircraft.append({
            'registration': a['registration'], 'kind': KIND[a['type']], 'model': a['model'],
            'seats': int(mm.group(1)) if mm else None,
            'role': 'cargo' if seats_txt.lower() == 'cargo' else 'aerial_work' if 'aerial' in seats_txt.lower() else 'passenger',
            'seats_raw': seats_txt,
        })
    out.append({
        'sno': r['sno'], 'name': name, 'address': address, 'pincode': pin[-1].replace(' ', '') if pin else None,
        'phone': clean_contact(r['phone']), 'fax': clean_contact(r['fax']), 'emails': r['emails'],
        'aop_no': re.sub(r'\s+', '', r['aop_no']), 'aop_valid_until': f'{y}-{m}-{d}',
        'fleet_type': FLEET[r['fleet']], 'aircraft_count': int(r['aircraft_count']), 'aircraft': aircraft,
        'source_page': r['page'],
    })
    assert out[-1]['aircraft_count'] == len(aircraft), r['sno']

json.dump({'source': 'DGCA — List of Non-Scheduled Operators', 'as_of': '2026-08-31', 'operators': out},
          open(OUT, 'w'), indent=1, ensure_ascii=False)
print(len(records), 'operators,', sum(len(r['aircraft']) for r in records), 'aircraft')
