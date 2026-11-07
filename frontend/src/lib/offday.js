import { DAYS, blocksOf } from "./time.js";

/**
 * Off-day finder.
 * Given a set of courses, find conflict-free combinations of sections (one "bundle" per
 * course: e.g. lecture + its linked lab) in which a chosen weekday has no class at all.
 */

const cross = (lists) => lists.reduce((acc, list) => acc.flatMap((a) => list.map((x) => [...a, x])), [[]]);

/**
 * All valid ways to take one course: one section of every type it has (lecture + lab ...).
 * Banner's public data labels sections LC/LB ("lecture"/"lab" roles) but does not say which lab
 * pairs with which lecture, so any lecture may be combined with any lab.
 */
export function bundlesForCourse(sections, { openOnly }) {
  const secs = sections.filter((s) => !openOnly || s.seats.available > 0);
  if (!secs.length) return [];
  const byType = new Map();
  for (const s of secs) byType.set(s.type, [...(byType.get(s.type) || []), s]);
  // a type that exists for the course but has no open section means the course can't be completed
  const allTypes = new Set(sections.map((s) => s.type));
  if (byType.size < allTypes.size && sections.some((s) => s.linked)) return [];
  return cross([...byType.values()]).slice(0, 600);
}

function bundleBlocks(bundle) {
  return bundle.flatMap((s) => blocksOf(s));
}

function selfConflict(blocks) {
  for (let i = 0; i < blocks.length; i++)
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      if (a.day === b.day && a.start < b.end && b.start < a.end) return true;
    }
  return false;
}

/** lower = more compact: total hours on campus between first and last class of each day */
export function scoreCombo(sections) {
  const perDay = {};
  for (const s of sections)
    for (const b of blocksOf(s)) {
      const d = (perDay[b.day] ||= { lo: Infinity, hi: -Infinity });
      d.lo = Math.min(d.lo, b.start);
      d.hi = Math.max(d.hi, b.end);
    }
  return Object.values(perDay).reduce((n, d) => n + (d.hi - d.lo), 0);
}

/**
 * @param courseBundles  array (one per course) of bundle arrays
 * @param offDay         day code that must be completely free (or null)
 * @returns {combos: Section[][], truncated: boolean}
 */
export function searchCombos(courseBundles, offDay, { maxResults = 60, budgetMs = 500 } = {}) {
  const prepared = courseBundles.map((bundles) =>
    bundles
      .map((bundle) => ({ bundle, blocks: bundleBlocks(bundle) }))
      .filter(({ blocks }) => !selfConflict(blocks) && (!offDay || !blocks.some((b) => b.day === offDay))),
  );
  if (prepared.some((p) => !p.length)) return { combos: [], truncated: false };
  prepared.sort((a, b) => a.length - b.length); // fewest options first = strongest pruning

  const combos = [];
  const started = performance.now();
  let truncated = false;
  const chosen = [];
  const acc = []; // blocks placed so far

  const dfs = (i) => {
    if (truncated) return;
    if (combos.length >= maxResults || performance.now() - started > budgetMs) {
      truncated = true;
      return;
    }
    if (i === prepared.length) {
      combos.push(chosen.flat());
      return;
    }
    for (const opt of prepared[i]) {
      const clash = opt.blocks.some((b) => acc.some((a) => a.day === b.day && a.start < b.end && b.start < a.end));
      if (clash) continue;
      chosen.push(opt.bundle);
      const before = acc.length;
      acc.push(...opt.blocks);
      dfs(i + 1);
      acc.length = before;
      chosen.pop();
      if (truncated) return;
    }
  };
  dfs(0);
  combos.sort((a, b) => scoreCombo(a) - scoreCombo(b));
  return { combos, truncated };
}

/** Run the search for every weekday; returns { U: {combos, truncated}, ... } */
export function findOffDays(allSections, courses, { openOnly }) {
  const bundles = courses.map((code) =>
    bundlesForCourse(
      allSections.filter((s) => s.course === code),
      { openOnly },
    ),
  );
  const missing = courses.filter((_, i) => !bundles[i].length);
  const result = {};
  for (const d of DAYS) result[d] = searchCombos(bundles, d);
  result.any = searchCombos(bundles, null, { maxResults: 30, budgetMs: 400 });
  return { result, missing };
}
