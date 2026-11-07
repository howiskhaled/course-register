import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Filters from "./components/Filters.jsx";
import CourseList from "./components/CourseList.jsx";
import Calendar from "./components/Calendar.jsx";
import PlanSidebar from "./components/PlanSidebar.jsx";
import OffDayFinder from "./components/OffDayFinder.jsx";
import RegisterPanel from "./components/RegisterPanel.jsx";
import RadarPanel from "./components/RadarPanel.jsx";
import { AccountButton, SignInDialog } from "./components/Account.jsx";
import CurrentScheduleDialog from "./components/CurrentScheduleDialog.jsx";
import { AppMark, Button, Dot, Select, cx } from "./components/ui.jsx";
import { clearTermCache, loadTerm, loadTerms } from "./lib/data.js";
import { EMPTY_FILTERS, applyFilters, genderOf, saveGender, savedGender } from "./lib/filters.js";
import { usePlannerState } from "./lib/state.js";
import { clashesWith, findConflicts } from "./lib/time.js";
import { fmtDate, fmtNum } from "./lib/format.js";
import { useApp } from "./lib/appState.jsx";

function Centered({ children }) {
  return <div className="grid h-full place-items-center p-8 text-center">{children}</div>;
}

export default function App() {
  const app = useApp();
  const appOn = app.enabled;

  const [index, setIndex] = useState(null);
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, gender: savedGender() }));
  const [view, setView] = useState("planner"); // planner | offday | register | radar
  const [previewCrn, setPreviewCrn] = useState(null);
  const [dragging, setDragging] = useState(null); // {crn, from: 'list'|'plan'}
  const [toast, setToast] = useState(null);
  const [signIn, setSignIn] = useState(false);
  const [editCurrent, setEditCurrent] = useState(false);

  const st = usePlannerState();
  const { term, setTerm, plans, activePlan, crns, setCrns, current, setCurrent } = st;

  // 1) which terms exist (re-read after the app refreshes data)
  useEffect(() => {
    if (!st.ready) return;
    if (app.dataVersion > 0) clearTermCache();
    loadTerms()
      .then((idx) => {
        setIndex(idx);
        setError(null);
        if (!term || !idx.terms.some((x) => x.code === term)) setTerm(idx.default || idx.terms[0].code);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.dataVersion, st.ready]);

  // 2) the selected term's sections
  useEffect(() => {
    if (!index || !term) return;
    const entry = index.terms.find((x) => x.code === term);
    if (!entry) return;
    loadTerm(entry, index._preloaded)
      .then(setDoc)
      .catch((e) => setError(e.message));
  }, [index, term]);

  useEffect(() => saveGender(filters.gender), [filters.gender]);

  const notify = useCallback((msg, kind = "ok", ms) => setToast({ msg, kind, ms, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.ms ?? (toast.kind === "alert" ? 9000 : 2800));
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (app.lastAlert) notify(`Seat open — ${app.lastAlert.label} · ${app.lastAlert.seats} available`, "alert");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.lastAlert]);

  // auto-register succeeded: those sections are now part of your current schedule (and replaced ones are gone)
  useEffect(() => {
    const ev = app.lastRegistered;
    if (!ev || ev.term !== term) return;
    if (ev.lost) {
      setCurrent(current.filter((c) => !ev.crns.includes(c)));
      notify(`CRN ${ev.crns.join(", ")} was dropped and couldn't be re-added — register it manually now`, "warn", 30000);
      return;
    }
    setCurrent([...new Set([...current.filter((c) => !(ev.dropped || []).includes(c)), ...ev.crns])]);
    const name = (c) => {
      const s = byCrnRef.current.get(c);
      return s ? `${s.course}-${s.section}` : `CRN ${c}`;
    };
    notify(`Registered ${ev.crns.map(name).join(", ")}`, "alert");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.lastRegistered]);

  const scrapeJob = app.job?.kind === "scrape" ? app.job : null;
  useEffect(() => {
    if (scrapeJob?.status === "done") notify("Course data updated");
    if (scrapeJob?.status === "failed") notify("Couldn't update course data", "warn");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrapeJob?.status]);

  const sections = useMemo(() => (doc && doc.meta.term === term ? doc.sections : []), [doc, term]);
  const byCrn = useMemo(() => new Map(sections.map((s) => [s.crn, s])), [sections]);
  const byCrnRef = useRef(byCrn);
  byCrnRef.current = byCrn;
  const planSections = useMemo(() => crns.map((c) => byCrn.get(c)).filter(Boolean), [crns, byCrn]);
  const missing = useMemo(() => (sections.length ? crns.filter((c) => !byCrn.has(c)) : []), [sections, crns, byCrn]);
  const currentSections = useMemo(() => current.map((c) => byCrn.get(c)).filter(Boolean), [current, byCrn]);
  const currentMissing = useMemo(() => (sections.length ? current.filter((c) => !byCrn.has(c)) : []), [sections, current, byCrn]);

  const diff = useMemo(() => {
    const wanted = new Set(crns);
    const have = new Set(current);
    // A section you're registered in is only dropped when the plan has ANOTHER section of the same
    // course and type (a swap, e.g. STAT 201-02 -> 201-08). Everything else you have is kept - never "drop all".
    const replaced = (c) => !wanted.has(c.crn) && planSections.some((p) => p.course === c.course && p.type === c.type && !have.has(p.crn));
    return {
      add: planSections.filter((s) => !have.has(s.crn)),
      drop: currentSections.filter(replaced),
      keep: [...planSections.filter((s) => have.has(s.crn)), ...currentSections.filter((c) => !wanted.has(c.crn) && !replaced(c))],
    };
  }, [crns, current, planSections, currentSections]);

  const departments = useMemo(() => {
    const m = new Map();
    for (const s of sections) m.set(s.subject, s.subjectName);
    return [...m].map(([code, name]) => ({ code, name })).sort((a, b) => a.code.localeCompare(b.code));
  }, [sections]);
  const types = useMemo(() => [...new Set(sections.map((s) => s.type).filter(Boolean))].sort(), [sections]);
  const filtered = useMemo(() => applyFilters(sections, filters), [sections, filters]);
  const genderSections = useMemo(() => (filters.gender ? sections.filter((s) => genderOf(s) === filters.gender) : sections), [sections, filters.gender]);
  const mixedGender = useMemo(() => new Set(planSections.map(genderOf)).size > 1, [planSections]);
  const conflicts = useMemo(() => findConflicts(planSections), [planSections]);
  const duplicates = useMemo(() => {
    const seen = new Map();
    for (const s of planSections) {
      const k = `${s.course}|${s.type}`;
      seen.set(k, [...(seen.get(k) || []), s]);
    }
    return [...seen.values()].filter((a) => a.length > 1).map((a) => `${a[0].course} (${a[0].type})`);
  }, [planSections]);

  const add = useCallback(
    (crn) => {
      const s = byCrn.get(crn);
      if (!s) return;
      setCrns((p) => (p.includes(crn) ? p : [...p, crn]));
      const clash = clashesWith(s, planSections);
      if (clash.length) notify(`${s.course}-${s.section} conflicts with ${clash.map((c) => `${c.course}-${c.section}`).join(", ")}`, "warn");
      else notify(`Added ${s.course}-${s.section}`);
    },
    [byCrn, planSections, notify, setCrns],
  );
  const remove = useCallback((crn) => setCrns((p) => p.filter((c) => c !== crn)), [setCrns]);

  const startDrag = useCallback((crn, from = "list") => {
    setDragging({ crn, from });
    setPreviewCrn(crn);
  }, []);
  const endDrag = useCallback(() => {
    setDragging(null);
    setPreviewCrn(null);
  }, []);

  const previewSection = previewCrn ? byCrn.get(previewCrn) : null;
  const previewClashes = previewSection ? clashesWith(previewSection, planSections) : [];

  const watchSet = useMemo(() => new Set((app.radar?.watches ?? []).map((w) => `${w.term}:${w.crn}`)), [app.radar]);
  const radarProps = appOn
    ? {
        isWatched: (s) => watchSet.has(`${term}:${s.crn}`),
        onWatch: (s) => app.watch({ ...s, term }).then(() => notify(`Watching ${s.course}-${s.section}`)),
        onUnwatch: (s) => app.unwatch(term, s.crn),
      }
    : null;

  const verifySignIn = () => {
    setView("register");
    app.startJob("/register", { mode: "check", term, wanted: [], current: [] }).catch((e) => notify(e.status === 409 ? "Another task is already running" : e.message, "warn"));
  };
  const refreshData = () => app.startJob("/scrape", { terms: "" }).catch((e) => notify(e.status === 409 ? "Another task is already running" : e.message, "warn"));
  const updating = scrapeJob?.status === "running";

  // ---------- loading / error
  if (error && !index) {
    return (
      <Centered>
        <div className="max-w-sm">
          <h1 className="text-[17px] font-semibold text-fg">No course data yet</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-2">{appOn ? "Download the current offering from KFUPM to get started." : "Run python scraper.py to create the data files."}</p>
          {appOn && (
            <Button variant="primary" size="lg" className="mt-6" disabled={updating} onClick={refreshData}>
              {updating ? "Downloading…" : "Download course data"}
            </Button>
          )}
        </div>
      </Centered>
    );
  }
  const loading = !index || !doc || doc.meta.term !== term;

  const termEntry = index?.terms.find((x) => x.code === term);
  const termLabel = termEntry?.description ?? "";
  const nav = [
    ["planner", "Planner"],
    ["offday", "Off days"],
    ...(appOn ? [["register", "Register"], ["radar", "Radar"]] : []),
  ];
  const anyOpen = app.radar?.watches?.some((w) => w.open);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-8 border-b border-line px-5">
        <div className="flex items-center gap-2.5">
          <AppMark size={26} />
          <span className="text-[14px] font-semibold tracking-[-0.015em] text-fg">KFUPM Planner</span>
        </div>

        <nav className="flex items-center gap-1" aria-label="Sections">
          {nav.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-current={view === id ? "page" : undefined}
              className={cx(
                "relative flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors",
                view === id ? "bg-active text-fg" : "text-fg-2 hover:text-fg",
              )}
            >
              {label}
              {id === "radar" && anyOpen && <Dot tone="ok" />}
              {id === "register" && app.auto?.armed && <Dot tone="ok" />}
              {id === "planner" && conflicts.pairs.length > 0 && <Dot tone="danger" />}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {index && (
            <Select
              aria-label="Term"
              className="w-[230px]"
              value={term ?? ""}
              onChange={(e) => {
                setTerm(e.target.value);
                setFilters({ ...EMPTY_FILTERS, gender: filters.gender });
              }}
            >
              {index.terms.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.description}
                </option>
              ))}
            </Select>
          )}
          {appOn && (
            <Button variant="ghost" onClick={refreshData} disabled={updating} title={doc ? `Data from ${fmtDate(doc.meta.scrapedAt)}` : undefined}>
              {updating ? "Refreshing…" : "Refresh data"}
            </Button>
          )}
          {appOn && <AccountButton onSignIn={() => setSignIn(true)} onVerify={verifySignIn} notify={notify} />}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {loading ? (
          <Centered>
            <p className="text-[13px] text-fg-3">Loading courses…</p>
          </Centered>
        ) : view === "offday" ? (
          <div className="h-full overflow-y-auto">
            <OffDayFinder
              key={term}
              sections={genderSections}
              gender={filters.gender}
              termLabel={termLabel}
              onUseCombo={(newCrns, name) => {
                st.addPlan(name, newCrns);
                setView("planner");
                notify(`Created “${name}”`);
              }}
            />
          </div>
        ) : view === "register" && appOn ? (
          <div className="h-full overflow-y-auto">
            <RegisterPanel
              term={term}
              termLabel={termLabel}
              sections={genderSections}
              planSections={planSections}
              diff={diff}
              current={current}
              currentSections={currentSections}
              onAddToPlan={add}
              onRemoveFromPlan={remove}
              onEditCurrent={() => setEditCurrent(true)}
              notify={notify}
              onSignIn={() => setSignIn(true)}
            />
          </div>
        ) : view === "radar" && appOn ? (
          <div className="h-full overflow-y-auto">
            <RadarPanel term={term} sections={sections} notify={notify} onRegisterStarted={() => setView("register")} />
          </div>
        ) : (
          <div className="h-full overflow-y-auto lg:grid lg:grid-cols-[minmax(330px,370px)_minmax(0,1fr)_minmax(290px,330px)] lg:overflow-hidden">
            <section className="flex min-h-0 flex-col border-line lg:border-r" aria-label="Courses">
              <div className="border-b border-line p-4">
                <Filters filters={filters} setFilters={setFilters} departments={departments} types={types} resultCount={filtered.length} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <CourseList
                  sections={filtered}
                  planSections={planSections}
                  radar={radarProps}
                  onAdd={add}
                  onRemove={remove}
                  onPreview={(crn) => !dragging && setPreviewCrn(crn)}
                  onDragStart={(crn) => startDrag(crn, "list")}
                  onDragEnd={endDrag}
                />
              </div>
            </section>

            <section className="min-h-0 overflow-y-auto px-6 py-5" aria-label="Week">
              <div className="mb-4 flex items-baseline justify-between gap-4">
                <h2 className="truncate text-[17px] font-semibold tracking-[-0.015em] text-fg">{activePlan?.name}</h2>
                <span className="tnum shrink-0 text-[12px] text-fg-3">
                  {fmtNum(sections.length)} sections · updated {fmtDate(doc.meta.scrapedAt)}
                </span>
              </div>
              <Calendar
                planSections={planSections}
                droppingSections={diff.drop}
                conflictCrns={conflicts.crns}
                previewSection={previewSection}
                previewClashes={previewClashes}
                dragging={dragging}
                onDropAdd={(crn) => {
                  add(crn);
                  endDrag();
                }}
                onRemove={remove}
                onDragStart={startDrag}
                onDragEnd={endDrag}
              />
              {dragging?.from === "plan" && (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    remove(e.dataTransfer.getData("text/plain"));
                    endDrag();
                  }}
                  className="mt-3 rounded-[6px] border border-dashed border-danger/50 py-4 text-center text-[13px] text-danger"
                >
                  Drop here to remove
                </div>
              )}
            </section>

            <aside className="min-h-0 border-line lg:border-l" aria-label="Plan">
              <PlanSidebar
                plans={plans}
                activePlan={activePlan}
                planActions={st}
                planSections={planSections}
                conflicts={conflicts}
                duplicates={duplicates}
                mixedGender={mixedGender}
                missing={missing}
                term={term}
                current={current}
                currentSections={currentSections}
                currentMissing={currentMissing}
                diff={diff}
                onSetCurrent={setCurrent}
                onEditCurrent={() => setEditCurrent(true)}
                onRemove={remove}
                onClear={() => setCrns([])}
                notify={notify}
              />
            </aside>
          </div>
        )}
      </main>

      {appOn && <SignInDialog open={signIn} onClose={() => setSignIn(false)} notify={notify} />}
      {!loading && (
        <CurrentScheduleDialog
          open={editCurrent}
          onClose={() => setEditCurrent(false)}
          sections={sections}
          current={current}
          onSave={setCurrent}
          canOcr={appOn && !!app.status?.ocr}
          notify={notify}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          role="status"
          className="fixed bottom-6 left-1/2 z-50 flex max-w-[min(560px,90vw)] -translate-x-1/2 items-center gap-2.5 rounded-full border border-line bg-raised px-4 py-2 text-[13px] text-fg"
        >
          <Dot tone={toast.kind === "warn" ? "danger" : toast.kind === "alert" ? "ok" : "fg"} />
          <span className="truncate">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}
