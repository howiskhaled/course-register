// Day codes used by KFUPM students (and by scraper.py): U M T W R. Sun–Thu week.
export const DAYS = ["U", "M", "T", "W", "R"];
export const DAY_NAMES = {
  U: "Sunday",
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  R: "Thursday",
  F: "Friday",
  S: "Saturday",
};
export const DAY_SHORT = { U: "Sun", M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat" };

/** "0830" -> 510 (minutes since midnight). */
export function toMin(hhmm) {
  if (!hhmm || hhmm.length !== 4) return null;
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10);
}

/** "1330" -> "1:30 PM" */
export function fmtTime(hhmm) {
  const m = toMin(hhmm);
  if (m == null) return "TBA";
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

/** 780 -> "1 PM" */
export function fmtMinutes(m) {
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1} ${h >= 12 ? "PM" : "AM"}`;
}

/** Flatten a section into one block per (meeting, day) with numeric minutes. */
export function blocksOf(section) {
  const out = [];
  for (const m of section.meetings || []) {
    const s = toMin(m.start);
    const e = toMin(m.end);
    if (s == null || e == null) continue;
    for (const day of m.days) out.push({ day, start: s, end: e, meeting: m });
  }
  return out;
}

export function blocksOverlap(a, b) {
  return a.day === b.day && a.start < b.end && b.start < a.end;
}

export function sectionsConflict(a, b) {
  if (a.crn === b.crn) return false;
  const bb = blocksOf(b);
  return blocksOf(a).some((x) => bb.some((y) => blocksOverlap(x, y)));
}

/** All conflicting pairs among `sections`, plus the set of CRNs involved. */
export function findConflicts(sections) {
  const pairs = [];
  const crns = new Set();
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      if (sectionsConflict(sections[i], sections[j])) {
        pairs.push([sections[i], sections[j]]);
        crns.add(sections[i].crn);
        crns.add(sections[j].crn);
      }
    }
  }
  return { pairs, crns };
}

/** Does `candidate` clash with anything already in `plan`? Returns the clashing sections. */
export function clashesWith(candidate, plan) {
  return plan.filter((p) => sectionsConflict(candidate, p));
}

export function meetingSummary(section) {
  const ms = (section.meetings || []).filter((m) => m.days.length && m.start);
  if (!ms.length) return "Time TBA";
  return ms.map((m) => `${m.days.join("")} ${fmtTime(m.start)}–${fmtTime(m.end)}`).join("  ·  ");
}

export function placeSummary(section) {
  const places = [
    ...new Set(
      (section.meetings || [])
        .filter((m) => m.building || m.room)
        .map((m) => [m.building && `B${m.building}`, m.room].filter(Boolean).join("-")),
    ),
  ];
  return places.join(", ");
}
