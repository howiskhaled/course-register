// Turn anything a student has - typed codes, text copied from Banner, OCR'd screenshot lines -
// into sections of the loaded term.
//   CRNs:            25364
//   course-section:  STAT 201-02 · STAT201-02 · stat 201 - 02 · ICS353-01#24-236-2 · ACCT 110-F03

const CODE_RE = /\b([A-Z]{2,4})\s*(\d{3}[A-Z]?)\s*[-–—]\s*([A-Z]?\d{1,3})(?![\d])/gi;
const CRN_RE = /\b(\d{5})\b/g;

const normSection = (s) => {
  const up = s.toUpperCase();
  return /^\d$/.test(up) ? `0${up}` : up;
};

export function buildIndex(sections) {
  const byCrn = new Map();
  const byCode = new Map();
  for (const s of sections) {
    byCrn.set(s.crn, s);
    byCode.set(`${s.subject}${s.number}-${s.section}`.toUpperCase(), s);
  }
  return { byCrn, byCode };
}

/** -> { found: Section[], unmatched: string[] } (found in order of appearance, de-duplicated) */
export function parseSchedule(text, index) {
  const found = new Map();
  const unmatched = [];
  // OCR sometimes reads 0 as O inside numbers: STAT2O1-O2
  const cleaned = text.replace(/(\d)O|O(\d)/g, (m, a, b) => (a ? `${a}0` : `0${b}`));

  for (const m of cleaned.matchAll(CODE_RE)) {
    const key = `${m[1]}${m[2]}-${normSection(m[3])}`.toUpperCase();
    const s = index.byCode.get(key);
    if (s) found.set(s.crn, s);
    else unmatched.push(`${m[1].toUpperCase()} ${m[2]}-${normSection(m[3])}`);
  }
  for (const m of cleaned.matchAll(CRN_RE)) {
    const s = index.byCrn.get(m[1]);
    if (s) found.set(s.crn, s);
  }
  return { found: [...found.values()], unmatched: [...new Set(unmatched)] };
}

/** Live suggestions for the "add a section" box. */
export function suggest(query, sections, limit = 8) {
  const q = query.toUpperCase().replace(/[\s-]+/g, "");
  if (q.length < 2) return [];
  const out = [];
  for (const s of sections) {
    const code = `${s.subject}${s.number}${s.section}`.toUpperCase();
    if (code.startsWith(q) || s.crn.startsWith(q)) out.push(s);
    if (out.length >= 200) break;
  }
  return out.sort((a, b) => a.course.localeCompare(b.course) || a.section.localeCompare(b.section)).slice(0, limit);
}
