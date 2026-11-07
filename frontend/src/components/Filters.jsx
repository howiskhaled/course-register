import { useState } from "react";
import { DAYS } from "../lib/time.js";
import { EMPTY_FILTERS } from "../lib/filters.js";
import { DAY_SHORT, fmtNum } from "../lib/format.js";
import { Check, Select, Segmented, cx, inputCls } from "./ui.jsx";

export default function Filters({ filters, setFilters, departments, types, resultCount }) {
  const [more, setMore] = useState(false);
  const set = (patch) => setFilters({ ...filters, ...patch });
  const toggleDay = (d) => set({ days: filters.days.includes(d) ? filters.days.filter((x) => x !== d) : [...filters.days, d] });
  // Reset keeps the male/female choice - it's a standing preference, not a search term
  const { gender: _a, ...rest } = filters;
  const { gender: _b, ...emptyRest } = EMPTY_FILTERS;
  const dirty = JSON.stringify(rest) !== JSON.stringify(emptyRest);
  const extraActive = filters.instructor || filters.days.length || filters.from || filters.to || filters.type;

  return (
    <div className="space-y-3">
      <div className="relative">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <input
          className={cx(inputCls, "pl-9")}
          placeholder="Search course, title or CRN"
          value={filters.code}
          onChange={(e) => set({ code: e.target.value })}
          aria-label="Search course, title or CRN"
        />
      </div>

      <div className="flex items-center gap-2">
        <Select aria-label="Department" className="min-w-0 flex-1" value={filters.department} onChange={(e) => set({ department: e.target.value })}>
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.code} value={d.code}>
              {d.code} — {d.name}
            </option>
          ))}
        </Select>
        <Segmented
          size="sm"
          value={filters.gender}
          onChange={(gender) => set({ gender })}
          options={[
            ["", "All"],
            ["male", "Male"],
            ["female", "Female"],
          ]}
        />
      </div>

      <div className="flex items-center justify-between">
        <Check checked={filters.openOnly} onChange={(openOnly) => set({ openOnly })}>
          Open seats only
        </Check>
        <button type="button" onClick={() => setMore((m) => !m)} className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg-2 hover:text-fg">
          {extraActive ? <span className="h-1.5 w-1.5 rounded-full bg-fg" aria-hidden="true" /> : null}
          {more ? "Fewer filters" : "More filters"}
        </button>
      </div>

      {more && (
        <div className="space-y-3 rounded-[6px] border border-line p-3">
          <input className={inputCls} placeholder="Instructor" value={filters.instructor} onChange={(e) => set({ instructor: e.target.value })} aria-label="Instructor" />
          <div>
            <p className="mb-1.5 text-[12px] font-medium text-fg-2">Only on</p>
            <div className="flex gap-1">
              {DAYS.map((d) => {
                const on = filters.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(d)}
                    className={cx(
                      "h-7 flex-1 rounded-full border text-[12px] font-medium transition-colors",
                      on ? "border-line-2 bg-active text-fg" : "border-line text-fg-2 hover:text-fg",
                    )}
                  >
                    {DAY_SHORT[d]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-fg-2">Starts after</span>
              <input type="time" className={inputCls} value={filters.from} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-fg-2">Ends before</span>
              <input type="time" className={inputCls} value={filters.to} onChange={(e) => set({ to: e.target.value })} />
            </label>
          </div>
          <Select aria-label="Section type" value={filters.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">Any type</option>
            {types.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className="flex items-center justify-between pt-0.5 text-[12px]">
        <span className="tnum text-fg-3" aria-live="polite">
          {fmtNum(resultCount)} sections
        </span>
        {dirty && (
          <button type="button" onClick={() => setFilters({ ...EMPTY_FILTERS, gender: filters.gender })} className="font-medium text-fg-2 hover:text-fg">
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
