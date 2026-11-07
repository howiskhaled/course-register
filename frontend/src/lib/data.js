async function getJson(path) {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status})`);
  return res.json();
}

/** terms.json lists every scraped term. Falls back to a lone courses.json from older scrapes. */
export async function loadTerms() {
  try {
    const idx = await getJson("data/terms.json");
    if (Array.isArray(idx.terms) && idx.terms.length) return idx;
  } catch {
    /* fall through */
  }
  const doc = await getJson("courses.json");
  const m = doc.meta;
  return {
    default: m.term,
    terms: [{ code: m.term, description: m.termDescription, file: "courses.json", count: m.count, scrapedAt: m.scrapedAt }],
    _preloaded: { [m.term]: doc },
  };
}

const termCache = new Map();
/** Forget downloaded terms (after the app re-scrapes). */
export function clearTermCache() {
  termCache.clear();
}
export async function loadTerm(entry, preloaded) {
  if (preloaded?.[entry.code]) return preloaded[entry.code];
  if (!termCache.has(entry.code)) termCache.set(entry.code, getJson(entry.file));
  const doc = await termCache.get(entry.code);
  if (!doc || !Array.isArray(doc.sections)) throw new Error(`${entry.file} has an unexpected shape`);
  return doc;
}

/** Stable pastel-ish colour per course code, e.g. "ICS 104". */
export function courseColor(course) {
  let h = 0;
  for (const ch of course) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return { bg: `hsl(${h} 70% 92%)`, border: `hsl(${h} 55% 45%)`, text: `hsl(${h} 60% 22%)` };
}

export function exportPlan(sections, format, term, current = []) {
  const crns = sections.map((s) => s.crn);
  if (format === "commas") return crns.join(", ");
  // register.py reads this: `crns` = the schedule you want, `current` = what you're registered in now
  if (format === "json") return JSON.stringify(current.length ? { term, current, crns } : { term, crns }, null, 2);
  return crns.join("\n"); // one per line - matches Banner's one-CRN-per-box entry
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function downloadText(filename, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
