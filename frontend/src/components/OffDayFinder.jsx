import { useMemo, useState } from "react";
import { DAYS, blocksOf, meetingSummary } from "../lib/time.js";
import { findOffDays, scoreCombo } from "../lib/offday.js";
import { DAY_NAME, DAY_SHORT } from "../lib/format.js";
import { Button, Check, Notice, PageHeader, SectionLabel, cx, inputCls } from "./ui.jsx";

function MiniWeek({ combo }) {
  const blocks = combo.flatMap((s) => blocksOf(s).map((b) => ({ b, s })));
  const lo = Math.min(7 * 60, ...blocks.map((x) => x.b.start));
  const hi = Math.max(17 * 60, ...blocks.map((x) => x.b.end));
  const H = 88;
  return (
    <div className="grid grid-cols-5 gap-[3px]" aria-hidden="true">
      {DAYS.map((d) => {
        const dayBlocks = blocks.filter((x) => x.b.day === d);
        return (
          <div key={d}>
            <p className={cx("mb-1 text-center text-[10.5px] font-medium", dayBlocks.length ? "text-fg-3" : "text-fg")}>{DAY_SHORT[d]}</p>
            <div className={cx("relative rounded-[4px] border", dayBlocks.length ? "border-line" : "border-line-2 border-dashed")} style={{ height: H }}>
              {dayBlocks.map(({ b }, i) => (
                <div
                  key={i}
                  className="absolute inset-x-[3px] rounded-[2px] bg-fg/70"
                  style={{ top: ((b.start - lo) / (hi - lo)) * (H - 2), height: Math.max(((b.end - b.start) / (hi - lo)) * (H - 2), 3) }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function OffDayFinder({ sections, termLabel, gender, onUseCombo }) {
  const [courses, setCourses] = useState([]);
  const [text, setText] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [out, setOut] = useState(null);
  const [day, setDay] = useState(null);
  const [shown, setShown] = useState(10);

  const allCourses = useMemo(() => {
    const m = new Map();
    for (const s of sections) m.set(s.course, s.title);
    return [...m].map(([code, title]) => ({ code, title }));
  }, [sections]);

  const suggestions = useMemo(() => {
    const q = text.toLowerCase().replace(/\s+/g, "");
    if (!q) return [];
    return allCourses
      .filter((c) => !courses.includes(c.code) && (c.code.toLowerCase().replace(/\s+/g, "").includes(q) || c.title.toLowerCase().includes(text.toLowerCase())))
      .slice(0, 6);
  }, [text, allCourses, courses]);

  const addCourse = (code) => {
    setCourses((c) => (c.includes(code) ? c : [...c, code]));
    setText("");
    setOut(null);
  };

  const run = () => {
    const res = findOffDays(sections, courses, { openOnly });
    setOut(res);
    const best = DAYS.map((d) => [d, res.result[d].combos.length]).sort((a, b) => b[1] - a[1])[0];
    setDay(best[1] > 0 ? best[0] : "any");
    setShown(10);
  };

  const current = out && day ? out.result[day] : null;

  return (
    <div className="mx-auto max-w-[880px] px-8 py-10">
      <PageHeader title="Off days">
        Add every course you need for {termLabel}. We'll find conflict-free combinations of sections that leave a whole weekday free.
      </PageHeader>

      <div className="mt-8 space-y-4">
        <div className="relative">
          <input
            className={inputCls + " h-10"}
            value={text}
            placeholder="Add a course — e.g. ICS 104, MATH 101, Physics"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && suggestions[0] && addCourse(suggestions[0].code)}
            aria-label="Add a course"
          />
          {suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1.5 w-full overflow-hidden rounded-[8px] border border-line bg-raised py-1">
              {suggestions.map((c) => (
                <li key={c.code}>
                  <button type="button" onClick={() => addCourse(c.code)} className="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-hover">
                    <span className="tnum w-20 shrink-0 text-[13px] font-medium text-fg">{c.code}</span>
                    <span className="truncate text-[13px] text-fg-2">{c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex min-h-8 flex-wrap items-center gap-2">
          {courses.map((c) => (
            <span key={c} className="tnum inline-flex h-7 items-center gap-1 rounded-full border border-line pl-3 pr-1 text-[12.5px] font-medium text-fg">
              {c}
              <button
                type="button"
                aria-label={`Remove ${c}`}
                className="grid h-5 w-5 place-items-center rounded-full text-fg-3 hover:bg-hover hover:text-fg"
                onClick={() => {
                  setCourses((x) => x.filter((y) => y !== c));
                  setOut(null);
                }}
              >
                ×
              </button>
            </span>
          ))}
          {courses.length === 0 && <span className="text-[12.5px] text-fg-3">No courses added.</span>}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
          <div className="flex items-center gap-5">
            <Check
              checked={openOnly}
              onChange={(v) => {
                setOpenOnly(v);
                setOut(null);
              }}
            >
              Open seats only
            </Check>
            <span className="text-[12px] text-fg-3">{gender ? `${gender === "female" ? "Female" : "Male"} sections` : "Male and female sections — set this in Planner filters"}</span>
          </div>
          <Button variant="primary" size="lg" disabled={!courses.length} onClick={run}>
            Find off days
          </Button>
        </div>
      </div>

      {out && (
        <div className="mt-10">
          {out.missing.length > 0 && (
            <Notice tone="warn" className="mb-5">
              No {openOnly ? "open " : ""}sections this term for {out.missing.join(", ")}.{openOnly ? " Turn off “Open seats only” to include full ones." : ""}
            </Notice>
          )}

          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Day to keep free">
            {[...DAYS, "any"].map((d) => {
              const r = out.result[d];
              const n = r.combos.length;
              const label = d === "any" ? "Any schedule" : `${DAY_NAME[d]} free`;
              return (
                <button
                  key={d}
                  role="tab"
                  aria-selected={day === d}
                  onClick={() => {
                    setDay(d);
                    setShown(10);
                  }}
                  className={cx(
                    "h-8 rounded-full border px-3.5 text-[12.5px] font-medium transition-colors",
                    day === d ? "border-line-2 bg-active text-fg" : n ? "border-line text-fg-2 hover:text-fg" : "border-line text-fg-3",
                  )}
                >
                  {label}
                  <span className="tnum ml-1.5 text-fg-3">{n ? `${n}${r.truncated ? "+" : ""}` : "0"}</span>
                </button>
              );
            })}
          </div>

          {current && current.combos.length === 0 && out.missing.length === 0 && (
            <p className="mt-8 text-[13.5px] text-fg-2">
              {day === "any" ? "No conflict-free combination exists for these courses." : `No conflict-free combination leaves ${DAY_NAME[day]} free. Try another day or remove a course.`}
            </p>
          )}

          {current && current.combos.length > 0 && (
            <>
              <SectionLabel className="mt-8">Most compact first{current.truncated ? " · showing the best of the first matches" : ""}</SectionLabel>
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {current.combos.slice(0, shown).map((combo, i) => (
                  <li key={i} className="grid grid-cols-[180px_1fr_auto] items-start gap-6 py-5">
                    <MiniWeek combo={combo} />
                    <div className="min-w-0">
                      <ul className="space-y-1">
                        {[...combo]
                          .sort((a, b) => a.course.localeCompare(b.course))
                          .map((s) => (
                            <li key={s.crn} className="tnum flex items-baseline gap-3 text-[12.5px]">
                              <span className="w-24 shrink-0 font-medium text-fg">
                                {s.course}-{s.section}
                              </span>
                              <span className="w-12 shrink-0 text-fg-3">{s.crn}</span>
                              <span className="truncate text-fg-2">{meetingSummary(s)}</span>
                            </li>
                          ))}
                      </ul>
                      <p className="tnum mt-2 text-[12px] text-fg-3">{(scoreCombo(combo) / 60).toFixed(1)} h on campus across the week</p>
                    </div>
                    <Button
                      onClick={() =>
                        onUseCombo(
                          combo.map((s) => s.crn),
                          day === "any" ? `Schedule ${i + 1}` : `${DAY_SHORT[day]} free · ${i + 1}`,
                        )
                      }
                    >
                      Use as plan
                    </Button>
                  </li>
                ))}
              </ul>
              {shown < current.combos.length && (
                <Button className="mt-4 w-full" onClick={() => setShown((n) => n + 10)}>
                  Show more
                </Button>
              )}
            </>
          )}
          <p className="mt-6 text-[12px] leading-relaxed text-fg-3">
            Each course needs one section of every part it has (lecture, lab…). Banner's public data doesn't say which lab pairs with which lecture — check pairing rules when you register.
          </p>
        </div>
      )}
    </div>
  );
}
