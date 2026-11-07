import { useState } from "react";
import { copyText, downloadText, exportPlan } from "../lib/data.js";
import { meetingSummary } from "../lib/time.js";
import { genderOf } from "../lib/filters.js";
import { plural } from "../lib/format.js";
import { Button, Notice, SectionLabel, Select, cx } from "./ui.jsx";

function PlanSwitcher({ plans, activePlan, actions }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select aria-label="Plan" className="min-w-0 flex-1" value={activePlan?.id ?? ""} onChange={(e) => actions.setActivePlanId(e.target.value)}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button variant="outline" onClick={() => actions.addPlan()}>
          New
        </Button>
      </div>
      <div className="flex gap-4 px-1 text-[12px] font-medium text-fg-3">
        <button
          type="button"
          className="hover:text-fg"
          onClick={() => {
            const n = window.prompt("Rename plan", activePlan.name);
            if (n && n.trim()) actions.renamePlan(activePlan.id, n.trim());
          }}
        >
          Rename
        </button>
        <button type="button" className="hover:text-fg" onClick={() => actions.addPlan(`${activePlan.name} copy`, activePlan.crns)}>
          Duplicate
        </button>
        <button
          type="button"
          className="hover:text-danger"
          onClick={() => {
            if (plans.length === 1 || window.confirm(`Delete “${activePlan.name}”?`)) actions.deletePlan(activePlan.id);
          }}
        >
          {plans.length === 1 ? "Clear" : "Delete"}
        </button>
      </div>
    </div>
  );
}

function CurrentSchedule({ currentSections, currentMissing, onEdit }) {
  return (
    <div className="rounded-[6px] border border-line">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[13px] font-medium text-fg">Current schedule</span>
        <Button size="sm" variant={currentSections.length ? "ghost" : "outline"} onClick={onEdit}>
          {currentSections.length ? "Edit" : "Set"}
        </Button>
      </div>
      {currentSections.length > 0 ? (
        <p className="tnum border-t border-line px-3 py-2.5 text-[12px] leading-relaxed text-fg-2">
          {currentSections.map((s) => `${s.course}-${s.section}`).join(", ")}
        </p>
      ) : (
        <p className="border-t border-line px-3 py-2.5 text-[12px] leading-relaxed text-fg-3">What you're registered in now — so auto-register only goes after what's new.</p>
      )}
      {currentMissing.length > 0 && <p className="border-t border-line px-3 py-2 text-[11.5px] text-warn">Not in this term: {currentMissing.join(", ")}</p>}
    </div>
  );
}

function DiffRow({ label, items, tone }) {
  if (!items.length) return null;
  return (
    <div className="flex gap-3 text-[12px]">
      <span className={cx("w-10 shrink-0 font-medium", tone)}>{label}</span>
      <span className="tnum text-fg-2">{items.map((s) => `${s.course}-${s.section}`).join(", ")}</span>
    </div>
  );
}

export default function PlanSidebar({
  plans,
  activePlan,
  planActions,
  planSections,
  conflicts,
  duplicates,
  mixedGender,
  missing,
  term,
  current,
  currentSections,
  currentMissing,
  diff,
  onSetCurrent,
  onEditCurrent,
  onRemove,
  onClear,
  notify,
}) {
  const [format, setFormat] = useState("lines");
  const credits = planSections.reduce((n, s) => n + (Number(s.credits) || 0), 0);

  const doCopy = async () => {
    if (!planSections.length) return notify("Your plan is empty.", "warn");
    const ok = await copyText(exportPlan(planSections, format, term, current));
    notify(ok ? `Copied ${plural(planSections.length, "CRN")}` : "Couldn't copy — select and copy manually", ok ? "ok" : "warn");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-5 overflow-y-auto px-5 py-5">
        <PlanSwitcher plans={plans} activePlan={activePlan} actions={planActions} />

        <div>
          <SectionLabel right={<span className="tnum text-[12px] text-fg-3">{plural(credits, "credit hour")}</span>}>
            {plural(planSections.length, "section")}
          </SectionLabel>

          <div className="mt-3 space-y-2">
            {conflicts.pairs.length > 0 && (
              <Notice tone="danger" title="Time conflict">
                {conflicts.pairs.map(([a, b]) => (
                  <p key={a.crn + b.crn}>
                    {a.course}-{a.section} overlaps {b.course}-{b.section}
                  </p>
                ))}
              </Notice>
            )}
            {duplicates.length > 0 && <Notice tone="warn">Two sections of {duplicates.join(", ")}. Lecture + lab is fine.</Notice>}
            {mixedGender && <Notice tone="warn">This plan mixes male and female sections — only valid where the university opened a section to both.</Notice>}
            {missing.length > 0 && (
              <Notice tone="muted">
                Not in this term's data: {missing.join(", ")}.{" "}
                <button className="font-medium text-fg underline-offset-2 hover:underline" onClick={() => missing.forEach(onRemove)}>
                  Remove
                </button>
              </Notice>
            )}
          </div>

          {planSections.length === 0 ? (
            <p className="mt-3 rounded-[6px] border border-dashed border-line px-3 py-6 text-center text-[12.5px] text-fg-3">No sections yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {planSections.map((s) => {
                const bad = conflicts.crns.has(s.crn);
                return (
                  <li key={s.crn} className="group flex items-start gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className={cx("tnum text-[13px] font-medium", bad ? "text-danger" : "text-fg")}>
                          {s.course}-{s.section}
                        </span>
                        <span className="tnum text-[12px] text-fg-3">{s.crn}</span>
                      </div>
                      <p className="truncate text-[12px] text-fg-2">{s.title}</p>
                      <p className="tnum text-[11.5px] text-fg-3">
                        {meetingSummary(s)}
                        {genderOf(s) === "female" ? "  ·  Female" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${s.course}-${s.section}`}
                      onClick={() => onRemove(s.crn)}
                      className="mt-0.5 grid h-6 w-6 place-items-center rounded-full text-[14px] text-fg-3 opacity-0 transition hover:bg-hover hover:text-fg group-hover:opacity-100 focus:opacity-100"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <CurrentSchedule currentSections={currentSections} currentMissing={currentMissing} onEdit={onEditCurrent} />

        {current.length > 0 && (
          <div className="space-y-1.5">
            <SectionLabel>Changes</SectionLabel>
            <DiffRow label="Add" items={diff.add} tone="text-ok" />
            <DiffRow label="Drop" items={diff.drop} tone="text-danger" />
            <DiffRow label="Keep" items={diff.keep} tone="text-fg-3" />
            {!diff.add.length && !diff.drop.length && <p className="text-[12px] text-fg-3">Matches your current schedule.</p>}
          </div>
        )}
      </div>

      <div className="mt-auto space-y-2 border-t border-line px-5 py-4">
        <div className="flex gap-2">
          <Select aria-label="Export format" className="min-w-0 flex-1" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="lines">One CRN per line</option>
            <option value="commas">Comma-separated</option>
            <option value="json">JSON</option>
          </Select>
          <Button variant="primary" className="h-9" onClick={doCopy} disabled={!planSections.length}>
            Copy CRNs
          </Button>
        </div>
        <div className="flex justify-between px-1 text-[12px] font-medium text-fg-3">
          <button type="button" className="hover:text-fg disabled:opacity-40" disabled={!planSections.length} onClick={() => downloadText("plan.json", exportPlan(planSections, "json", term, current))}>
            Save plan.json
          </button>
          <button type="button" className="hover:text-danger disabled:opacity-40" disabled={!planSections.length} onClick={onClear}>
            Clear plan
          </button>
        </div>
      </div>
    </div>
  );
}
