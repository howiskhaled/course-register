import { toMin } from "./time.js";

/**
 * KFUPM runs separate male and female sections. In Banner's data the female ones have
 * campus "Female" and an "F"-prefixed section number (F03, F82 …); in the 202620 term these
 * two signals agree on every section. Either one marks a section as female.
 */
export function genderOf(s) {
  if (s.gender) return s.gender; // newer scrapes store it explicitly
  return s.campus === "Female" || /^F/i.test(s.section || "") ? "female" : "male";
}

const GENDER_KEY = "kfupm-gender-v1";
export function savedGender() {
  try {
    const g = localStorage.getItem(GENDER_KEY);
    return g === "male" || g === "female" ? g : "";
  } catch {
    return "";
  }
}
export function saveGender(g) {
  try {
    localStorage.setItem(GENDER_KEY, g || "");
  } catch {
    /* private mode */
  }
}

export const EMPTY_FILTERS = {
  gender: "", // "" = all, "male", "female"
  department: "",
  code: "",
  instructor: "",
  days: [],
  from: "",
  to: "",
  type: "",
  openOnly: false,
};

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function applyFilters(sections, f) {
  const code = norm(f.code);
  const instr = (f.instructor || "").trim().toLowerCase();
  const from = f.from ? toMin(f.from.replace(":", "")) : null;
  const to = f.to ? toMin(f.to.replace(":", "")) : null;
  const timed = f.days.length > 0 || from != null || to != null;

  return sections.filter((s) => {
    if (f.gender && genderOf(s) !== f.gender) return false;
    if (f.department && s.subject !== f.department) return false;
    if (code && !norm(`${s.course}${s.title}${s.crn}`).includes(code)) return false;
    if (instr && !s.instructors.some((n) => n.toLowerCase().includes(instr))) return false;
    if (f.type && s.type !== f.type) return false;
    if (f.openOnly && !(s.seats.available > 0)) return false;
    if (timed) {
      const ms = s.meetings.filter((m) => m.days.length && m.start);
      if (!ms.length) return false; // TBA sections can't satisfy a day/time constraint
      for (const m of ms) {
        if (f.days.length && !m.days.every((d) => f.days.includes(d))) return false;
        if (from != null && toMin(m.start) < from) return false;
        if (to != null && toMin(m.end) > to) return false;
      }
    }
    return true;
  });
}

export function groupByCourse(sections) {
  const map = new Map();
  for (const s of sections) {
    if (!map.has(s.course)) map.set(s.course, { course: s.course, title: s.title, sections: [] });
    map.get(s.course).sections.push(s);
  }
  return [...map.values()];
}
