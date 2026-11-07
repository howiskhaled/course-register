import { useMemo, useState } from "react";
import { genderOf, groupByCourse } from "../lib/filters.js";
import { clashesWith, meetingSummary, placeSummary } from "../lib/time.js";
import { Button, Dot, cx } from "./ui.jsx";

const PAGE = 30;

function Seats({ seats }) {
  const n = seats.available;
  const tone = n == null ? "muted" : n <= 0 ? "danger" : n <= 5 ? "warn" : "ok";
  return (
    <span className="tnum flex items-center gap-1.5 text-[12px] text-fg-2" title="Available seats / capacity">
      <Dot tone={tone} />
      {n == null ? "?" : Math.max(n, 0)}/{seats.capacity ?? "?"}
    </span>
  );
}

function SectionRow({ s, inPlan, plan, radar, onAdd, onRemove, onPreview, onDragStart, onDragEnd }) {
  const clash = !inPlan && clashesWith(s, plan);
  const full = !(s.seats.available > 0);
  const watched = radar?.isWatched(s);
  const place = placeSummary(s);
  return (
    <li
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", s.crn);
        e.dataTransfer.effectAllowed = "copy";
        onDragStart(s.crn);
      }}
      onDragEnd={onDragEnd}
      onMouseEnter={() => onPreview(s.crn)}
      onMouseLeave={() => onPreview(null)}
      className={cx("group relative flex items-start gap-3 px-3 py-2.5 transition-colors", inPlan ? "bg-active" : "hover:bg-hover")}
    >
      {inPlan && <span aria-hidden="true" className="absolute inset-y-2 left-0 w-[2px] rounded-full bg-fg" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-fg">Section {s.section}</span>
          <span className="tnum text-[12px] text-fg-3">CRN {s.crn}</span>
        </div>
        <p className="tnum mt-0.5 text-[12.5px] text-fg-2">{meetingSummary(s)}</p>
        <p className="mt-0.5 truncate text-[12px] text-fg-3">
          {[s.type, genderOf(s) === "female" ? "Female" : "Male", s.instructors.join(", ") || "Instructor TBA", place].filter(Boolean).join("  ·  ")}
        </p>
        {clash && clash.length > 0 && (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-danger">
            <Dot tone="danger" />
            Clashes with {clash.map((c) => `${c.course}-${c.section}`).join(", ")}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <Seats seats={s.seats} />
        <div className="flex gap-1">
          {radar && (full || watched) && (
            <Button size="sm" variant={watched ? "outline" : "ghost"} onClick={() => (watched ? radar.onUnwatch(s) : radar.onWatch(s))}>
              {watched ? "Watching" : "Watch"}
            </Button>
          )}
          <Button size="sm" variant={inPlan ? "ghost" : "outline"} onClick={() => (inPlan ? onRemove(s.crn) : onAdd(s.crn))}>
            {inPlan ? "Remove" : "Add"}
          </Button>
        </div>
      </div>
    </li>
  );
}

export default function CourseList({ sections, planSections, radar, onAdd, onRemove, onPreview, onDragStart, onDragEnd }) {
  const [shown, setShown] = useState(PAGE);
  const groups = useMemo(() => groupByCourse(sections), [sections]);
  const planCrns = useMemo(() => new Set(planSections.map((p) => p.crn)), [planSections]);

  // reset pagination whenever the result set changes
  const key = sections.length + (sections[0]?.crn || "");
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) {
    setLastKey(key);
    setShown(PAGE);
  }

  if (!groups.length) return <p className="px-3 py-10 text-center text-[13px] text-fg-3">No sections match these filters.</p>;

  return (
    <div>
      {groups.slice(0, shown).map((g) => (
        <section key={g.course} className="border-t border-line first:border-t-0">
          <header className="sticky top-0 z-[1] flex items-baseline gap-2.5 bg-canvas/95 px-3 pb-1.5 pt-4 backdrop-blur">
            <h3 className="tnum shrink-0 text-[14px] font-semibold tracking-[-0.01em] text-fg">{g.course}</h3>
            <p className="truncate text-[12.5px] text-fg-2">{g.title}</p>
          </header>
          <ul className="pb-2">
            {g.sections.map((s) => (
              <SectionRow
                key={s.crn}
                s={s}
                inPlan={planCrns.has(s.crn)}
                plan={planSections}
                radar={radar}
                onAdd={onAdd}
                onRemove={onRemove}
                onPreview={onPreview}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
              />
            ))}
          </ul>
        </section>
      ))}
      {shown < groups.length && (
        <div className="px-3 py-4">
          <Button className="w-full" onClick={() => setShown((n) => n + PAGE)}>
            Show more · {groups.length - shown} courses
          </Button>
        </div>
      )}
    </div>
  );
}
