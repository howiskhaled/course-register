import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { buildIndex, parseSchedule, suggest } from "../lib/parse.js";
import { meetingSummary } from "../lib/time.js";
import { plural } from "../lib/format.js";
import { Button, Check, Modal, cx, inputCls } from "./ui.jsx";

/**
 * "Current schedule" editor: the sections the student is registered in right now.
 * Type a section ("STAT 201-02") or CRN and pick a suggestion, paste a whole list, or
 * (desktop app on macOS) import a screenshot of the schedule - then review and save.
 */
export default function CurrentScheduleDialog({ open, onClose, sections, current, onSave, canOcr, notify }) {
  const [list, setList] = useState([]);
  const [query, setQuery] = useState("");
  const [review, setReview] = useState(null); // { source, found: Section[], picked: Set<crn>, unmatched }
  const [reading, setReading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const inputRef = useRef(null);

  const index = useMemo(() => buildIndex(sections), [sections]);
  const byCrn = index.byCrn;

  useEffect(() => {
    if (open) {
      setList(current.filter((c) => byCrn.has(c)));
      setQuery("");
      setReview(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const looksLikeList = /[,\n;]|\s{2,}/.test(query.trim()) || (query.match(/[A-Za-z]{2,4}\s*\d{3}/g) || []).length > 1;
  const suggestions = useMemo(() => (looksLikeList ? [] : suggest(query, sections).filter((s) => !list.includes(s.crn))), [query, sections, list, looksLikeList]);

  const addOne = (s) => {
    setList((l) => (l.includes(s.crn) ? l : [...l, s.crn]));
    setQuery("");
    inputRef.current?.focus();
  };

  const startReview = (text, source) => {
    const { found, unmatched } = parseSchedule(text, index);
    if (!found.length && !unmatched.length) return notify("No course sections or CRNs found in that.", "warn");
    setReview({ source, found, unmatched, picked: new Set(found.filter((s) => !list.includes(s.crn)).map((s) => s.crn)) });
    setQuery("");
  };

  const submitInput = () => {
    if (!query.trim()) return;
    const { found } = parseSchedule(query, index);
    if (found.length > 1 || looksLikeList) return startReview(query, "paste");
    if (found.length === 1) return addOne(found[0]);
    if (suggestions[0]) return addOne(suggestions[0]);
    notify(`“${query.trim()}” isn't a section in this term.`, "warn");
  };

  const readImage = async (file) => {
    if (!file || !file.type.startsWith("image/")) return notify("Choose an image file.", "warn");
    setReading(true);
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const { lines } = await api.post("/ocr", { image: dataUrl });
      startReview(lines.join("\n"), "screenshot");
    } catch (e) {
      notify(e.message, "warn");
    } finally {
      setReading(false);
    }
  };

  const pickedCount = review ? [...review.picked].length : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="w-[640px]"
      title="Current schedule"
      description="The sections you're registered in right now. Auto-register leaves these alone and only goes after the rest of your plan."
      footer={
        <>
          {canOcr && (
            <>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => (readImage(e.target.files?.[0]), (e.target.value = ""))} />
              <Button variant="ghost" className="mr-auto" disabled={reading} onClick={() => fileRef.current?.click()}>
                {reading ? "Reading screenshot…" : "Import a screenshot"}
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(list);
              notify(list.length ? `Current schedule: ${plural(list.length, "section")}` : "Current schedule cleared");
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div
        className={cx("space-y-4 rounded-[6px] transition-colors", dragOver && "bg-hover outline outline-1 outline-line-2")}
        onDragOver={(e) => {
          if (canOcr && [...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          readImage(e.dataTransfer.files?.[0]);
        }}
      >
        <div className="relative">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              autoFocus
              className={inputCls}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submitInput())}
              onPaste={(e) => {
                // a single-line input would silently drop the line breaks of a pasted list
                const text = e.clipboardData.getData("text");
                if (/[\n,;]/.test(text) || (text.match(/[A-Za-z]{2,4}\s*\d{3}/g) || []).length > 1 || (text.match(/\b\d{5}\b/g) || []).length > 1) {
                  e.preventDefault();
                  startReview(text, "paste");
                }
              }}
              placeholder="Type a section (STAT 201-02) or CRN — or paste a list"
              aria-label="Add a section"
              spellCheck={false}
            />
            <Button className="h-9" disabled={!query.trim()} onClick={submitInput}>
              Add
            </Button>
          </div>
          {suggestions.length > 0 && (
            <ul className="absolute z-10 mt-1.5 max-h-64 w-full overflow-y-auto rounded-[8px] border border-line bg-raised py-1">
              {suggestions.map((s) => (
                <li key={s.crn}>
                  <button type="button" onClick={() => addOne(s)} className="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-hover">
                    <span className="tnum w-24 shrink-0 text-[13px] font-medium text-fg">
                      {s.course}-{s.section}
                    </span>
                    <span className="tnum w-12 shrink-0 text-[12px] text-fg-3">{s.crn}</span>
                    <span className="tnum truncate text-[12px] text-fg-2">
                      {meetingSummary(s)}
                      {s.instructors[0] ? ` · ${s.instructors[0]}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {review && (
          <div className="rounded-[6px] border border-line">
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
              <p className="text-[12.5px] text-fg-2">
                Found {plural(review.found.length, "section")}
                {review.source === "screenshot" ? " in the screenshot" : ""} — keep only the ones you're registered in
              </p>
              <button type="button" className="text-[12px] font-medium text-fg-3 hover:text-fg" onClick={() => setReview(null)}>
                Dismiss
              </button>
            </div>
            <ul className="max-h-60 divide-y divide-line overflow-y-auto">
              {review.found.map((s) => {
                const already = list.includes(s.crn);
                return (
                  <li key={s.crn} className="px-4 py-2">
                    <Check
                      checked={already || review.picked.has(s.crn)}
                      onChange={(v) =>
                        !already &&
                        setReview((r) => {
                          const picked = new Set(r.picked);
                          v ? picked.add(s.crn) : picked.delete(s.crn);
                          return { ...r, picked };
                        })
                      }
                    >
                      <span className="tnum">
                        {s.course}-{s.section} <span className="text-fg-3">· {s.crn} · {meetingSummary(s)}</span>
                        {already && <span className="text-fg-3"> · already in the list</span>}
                      </span>
                    </Check>
                  </li>
                );
              })}
            </ul>
            {review.unmatched.length > 0 && <p className="border-t border-line px-4 py-2 text-[12px] text-warn">Not in this term: {review.unmatched.join(", ")}</p>}
            <div className="flex justify-end border-t border-line px-4 py-2.5">
              <Button
                disabled={!pickedCount}
                onClick={() => {
                  setList((l) => [...l, ...review.found.map((s) => s.crn).filter((c) => review.picked.has(c) && !l.includes(c))]);
                  setReview(null);
                }}
              >
                Add {plural(pickedCount, "section")}
              </Button>
            </div>
          </div>
        )}

        {list.length === 0 ? (
          <p className="rounded-[6px] border border-dashed border-line px-4 py-8 text-center text-[13px] text-fg-3">
            No sections yet.{canOcr ? " You can also drop a screenshot of your schedule here." : ""}
          </p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {list.map((crn) => {
              const s = byCrn.get(crn);
              return (
                <li key={crn} className="group flex items-center gap-4 py-2.5">
                  <span className="tnum w-24 shrink-0 text-[13px] font-medium text-fg">
                    {s.course}-{s.section}
                  </span>
                  <span className="tnum w-12 shrink-0 text-[12px] text-fg-3">{crn}</span>
                  <span className="tnum min-w-0 flex-1 truncate text-[12px] text-fg-2">
                    {meetingSummary(s)} · {s.title}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${s.course}-${s.section}`}
                    onClick={() => setList((l) => l.filter((c) => c !== crn))}
                    className="grid h-6 w-6 place-items-center rounded-full text-[14px] text-fg-3 hover:bg-hover hover:text-fg"
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
