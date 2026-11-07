import { useMemo, useState } from "react";
import { DAYS, blocksOf, fmtMinutes, fmtTime, placeSummary } from "../lib/time.js";
import { DAY_NAME } from "../lib/format.js";
import { cx } from "./ui.jsx";

const HOUR_PX = 56;
// the hour gutter already says AM/PM, so blocks use the compact "8:00–8:50"
const short = (hhmm) => fmtTime(hhmm).replace(/ (AM|PM)$/, "");
const MIN_START = 7 * 60;
const MIN_END = 18 * 60;

/** Place overlapping blocks of one day side by side (greedy lanes per overlap cluster). */
function layoutDay(items) {
  const sorted = [...items].sort((x, y) => x.b.start - y.b.start || x.b.end - y.b.end);
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    cluster.forEach((c) => out.push({ ...c, lanes }));
    cluster = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.b.start >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.b.end > it.b.start).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ ...it, lane });
    clusterEnd = Math.max(clusterEnd, it.b.end);
  }
  if (cluster.length) flush();
  return out;
}

function Block({ b, section, conflict, ghost, drop, onRemove, onDragStart, onDragEnd, top0, lane = 0, lanes = 1 }) {
  const top = ((b.start - top0) / 60) * HOUR_PX + 1;
  const height = Math.max(((b.end - b.start) / 60) * HOUR_PX - 3, 20);
  const style = { top, height, left: `calc(${(lane / lanes) * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` };
  const interactive = !ghost && !drop;
  return (
    <div
      draggable={interactive}
      onDragStart={
        interactive
          ? (e) => {
              e.dataTransfer.setData("text/plain", section.crn);
              e.dataTransfer.effectAllowed = "move";
              onDragStart(section.crn, "plan");
            }
          : undefined
      }
      onDragEnd={interactive ? onDragEnd : undefined}
      style={style}
      title={`${drop ? "Registered now — will be dropped\n" : ""}${section.course}-${section.section} · CRN ${section.crn}\n${section.title}\n${fmtTime(b.meeting.start)} – ${fmtTime(b.meeting.end)}`}
      className={cx(
        "group absolute overflow-hidden rounded-[5px] border px-2 py-1 text-[11.5px] leading-[1.35]",
        ghost && "pointer-events-none border-dashed",
        drop && "hatch pointer-events-none border-line text-fg-3",
        interactive && "cursor-grab active:cursor-grabbing",
        conflict
          ? "border-danger/50 bg-danger/[0.12] text-fg"
          : ghost
            ? "border-line-2 bg-transparent text-fg-2"
            : !drop && "border-line-2 bg-white/[0.06] text-fg hover:bg-white/[0.09]",
      )}
    >
      {conflict && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[2px] bg-danger" />}
      <p className="tnum truncate font-medium">
        {drop && <span className="mr-1 font-normal text-fg-3">Drop ·</span>}
        {section.course}-{section.section}
      </p>
      <p className="tnum truncate text-fg-2">
        {short(b.meeting.start)}–{short(b.meeting.end)}
      </p>
      {height > 60 && <p className="truncate text-fg-3">{placeSummary(section)}</p>}
      {interactive && (
        <button
          type="button"
          aria-label={`Remove ${section.course}-${section.section}`}
          onClick={() => onRemove(section.crn)}
          className="absolute right-1 top-1 hidden h-4 w-4 place-items-center rounded-full text-[12px] leading-none text-fg-2 hover:bg-active hover:text-fg group-hover:grid"
        >
          ×
        </button>
      )}
    </div>
  );
}

export default function Calendar({
  planSections,
  droppingSections = [],
  conflictCrns,
  previewSection,
  previewClashes,
  onDropAdd,
  onRemove,
  onDragStart,
  onDragEnd,
  dragging,
}) {
  const [over, setOver] = useState(false);

  // Range grows to fit whatever is scheduled / previewed.
  const { startMin, endMin } = useMemo(() => {
    let lo = MIN_START;
    let hi = MIN_END;
    for (const s of [...planSections, ...droppingSections, ...(previewSection ? [previewSection] : [])]) {
      for (const b of blocksOf(s)) {
        lo = Math.min(lo, Math.floor(b.start / 60) * 60);
        hi = Math.max(hi, Math.ceil(b.end / 60) * 60);
      }
    }
    return { startMin: lo, endMin: hi };
  }, [planSections, droppingSections, previewSection]);

  const hours = [];
  for (let m = startMin; m < endMin; m += 60) hours.push(m);
  const bodyH = ((endMin - startMin) / 60) * HOUR_PX;

  const planBlocks = useMemo(() => planSections.flatMap((s) => blocksOf(s).map((b) => ({ b, s }))), [planSections]);
  const ghostBlocks = previewSection ? blocksOf(previewSection).map((b) => ({ b, s: previewSection })) : [];
  const alreadyIn = previewSection && planSections.some((p) => p.crn === previewSection.crn);
  const offWeek = planSections.filter((s) => s.meetings.some((m) => m.days.some((d) => d === "F" || d === "S"))).map((s) => `${s.course}-${s.section}`);

  return (
    <div
      className={cx("rounded-[6px] border transition-colors", over ? "border-line-2 bg-hover" : "border-line")}
      onDragOver={(e) => {
        if (dragging?.from === "list") {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const crn = e.dataTransfer.getData("text/plain");
        if (crn && dragging?.from === "list") onDropAdd(crn);
      }}
    >
      <div className="grid grid-cols-[3.25rem_repeat(5,minmax(0,1fr))] border-b border-line">
        <div />
        {DAYS.map((d) => (
          <div key={d} className="border-l border-line px-3 py-2.5 text-[12.5px] font-medium text-fg-2">
            {DAY_NAME[d]}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[3.25rem_repeat(5,minmax(0,1fr))]" style={{ height: bodyH }}>
        <div className="relative">
          {hours.map((m, i) =>
            i === 0 ? null : (
              <span key={m} className="tnum absolute right-2 -translate-y-1/2 text-[10.5px] text-fg-3" style={{ top: i * HOUR_PX }}>
                {fmtMinutes(m)}
              </span>
            ),
          )}
        </div>
        {DAYS.map((d) => (
          <div
            key={d}
            className="relative border-l border-line"
            style={{
              backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, rgb(255 255 255 / 0.06) ${HOUR_PX - 1}px, rgb(255 255 255 / 0.06) ${HOUR_PX}px)`,
            }}
          >
            {droppingSections.flatMap((s) =>
              blocksOf(s)
                .filter((b) => b.day === d)
                .map((b, i) => <Block key={`d-${s.crn}-${i}`} b={b} section={s} top0={startMin} drop />),
            )}
            {layoutDay(planBlocks.filter(({ b }) => b.day === d)).map(({ b, s, lane, lanes }, i) => (
              <Block
                key={`${s.crn}-${i}`}
                b={b}
                section={s}
                top0={startMin}
                lane={lane}
                lanes={lanes}
                conflict={conflictCrns.has(s.crn)}
                onRemove={onRemove}
                onDragStart={(crn) => onDragStart(crn, "plan")}
                onDragEnd={onDragEnd}
              />
            ))}
            {!alreadyIn &&
              ghostBlocks
                .filter(({ b }) => b.day === d)
                .map(({ b, s }, i) => <Block key={`g-${s.crn}-${i}`} b={b} section={s} top0={startMin} ghost conflict={previewClashes.length > 0} />)}
          </div>
        ))}
      </div>

      {offWeek.length > 0 && <p className="border-t border-line px-4 py-2.5 text-[12px] text-fg-2">Not shown — meets on Friday/Saturday: {offWeek.join(", ")}</p>}
      {planSections.length === 0 && !previewSection && (
        <p className="border-t border-line px-4 py-3 text-center text-[12.5px] text-fg-3">Drag a section here, or choose Add. Hover any section to preview it.</p>
      )}
    </div>
  );
}
