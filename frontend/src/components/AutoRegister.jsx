import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { useApp } from "../lib/appState.jsx";
import { plural } from "../lib/format.js";
import { Button, Check, Dot, Modal, Notice, SectionLabel, Segmented, Select, cx, inputCls } from "./ui.jsx";
import { deviceName } from "../lib/platform.js";

const REGISTRAR = {
  off: ["Off", "muted"],
  scheduled: ["Scheduled", "muted"],
  signing_in: ["Signing in to Banner…", "warn"],
  waiting_window: ["Signed in — waiting for your registration window to open", "warn"],
  ready: ["Signed in and ready", "ok"],
  error: ["Stopped with an error", "danger"],
};

const STATUS = {
  waiting: ["Full — watching", "muted", "text-fg-2"],
  open: ["Seat open", "ok", "text-ok"],
  registering: ["Registering…", "warn", "text-fg"],
  registered: ["Registered", "ok", "text-ok"],
  rehearsed: ["Rehearsed — not submitted", "ok", "text-fg-2"],
  failed: ["Couldn't register", "danger", "text-danger"],
};

export default function AutoRegister({ term, sections, planSections, current, currentSections, onAddToPlan, onRemoveFromPlan, onEditCurrent, notify }) {
  const app = useApp();
  const { auto, status, radar } = app;
  const [crn, setCrn] = useState("");
  const [interval, setIntervalSec] = useState(10);
  const [dry, setDry] = useState(false);
  // per-target action: { [targetCrn]: [current CRNs to drop when it gets in] }; missing = suggested swap
  const actionsKey = `kfupm-drop-actions-v1:${term}`;
  const [actions, setActions] = useState(() => readActions(actionsKey));
  const [picking, setPicking] = useState(null); // target CRN whose action is being edited
  useEffect(() => setActions(readActions(actionsKey)), [actionsKey]);
  const saveAction = (crn, drops) => {
    const next = { ...actions, [crn]: drops };
    setActions(next);
    try {
      localStorage.setItem(actionsKey, JSON.stringify(next));
    } catch {
      /* not saved; still used for this session */
    }
  };
  const [confirming, setConfirming] = useState(false);
  const [startMode, setStartMode] = useState("now"); // now | at
  const [startTime, setStartTime] = useState(() => readPref("kfupm-auto-start-time", "09:00"));
  const now = useNow(startMode === "at" ? 15000 : 0);
  const startAt = startMode === "at" ? nextOccurrence(startTime, now) : null;
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef(null);

  const armed = !!auto?.armed;
  const signedIn = !!(status?.credentials?.saved || status?.credentials?.fromEnvFile);
  const byCrn = useMemo(() => new Map(sections.map((s) => [s.crn, s])), [sections]);
  const seatsLive = useMemo(() => new Map((radar?.watches ?? []).map((w) => [w.crn, w])), [radar]);

  // what you want = plan sections you don't already have. Each one can drop any of your current sections
  // when it gets in (a swap of the same course is suggested; any other course can be picked with "Action").
  const targets = useMemo(() => {
    const claimed = new Set(); // a current section can be traded for one target only
    return planSections
      .filter((s) => !current.includes(s.crn))
      .map((s) => {
        const suggested = currentSections.filter((c) => c.course === s.course && c.type === s.type && !planSections.some((p) => p.crn === c.crn));
        const chosen = Array.isArray(actions[s.crn]) ? actions[s.crn] : suggested.map((c) => c.crn);
        const replaces = currentSections.filter((c) => chosen.includes(c.crn) && !claimed.has(c.crn));
        replaces.forEach((c) => claimed.add(c.crn));
        return { section: s, replaces, suggested };
      });
  }, [planSections, current, currentSections, actions]);
  const anyReplaces = targets.some((t) => t.replaces.length);
  const claimedBy = new Map(targets.flatMap((t) => t.replaces.map((c) => [c.crn, t.section])));
  const pickingTarget = targets.find((t) => t.section.crn === picking);
  // plan sections you already have: auto-register leaves these alone
  const alreadyHave = planSections.filter((s) => current.includes(s.crn));
  const name = (s) => `${s.course}-${s.section}`;

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [auto?.lines?.length, showLog]);

  const addWanted = () => {
    const s = byCrn.get(crn.trim());
    if (!s) return notify("That CRN isn't in this term's data.", "warn");
    onAddToPlan(s.crn);
    setCrn("");
  };

  const start = async () => {
    setConfirming(false);
    try {
      await api.post("/auto/arm", {
        term,
        confirm: true,
        dry,
        allowDrop: anyReplaces,
        interval,
        headed: status?.settings?.headed ?? true,
        ...(startAt ? { startAt: Math.floor(startAt.getTime() / 1000) } : {}),
        targets: targets.map(({ section: s, replaces }) => ({
          crn: s.crn,
          subject: s.subject,
          number: s.number,
          label: `${s.course}-${s.section} · ${s.title} · CRN ${s.crn}`,
          drops: replaces.map((r) => r.crn),
        })),
      });
      app.refreshAuto();
      app.refreshRadar();
      notify(startAt ? `Auto-register scheduled for ${fmtWhen(startAt)}` : dry ? "Auto-register rehearsal started" : "Auto-register started");
    } catch (e) {
      notify(e.message, "warn");
    }
  };

  const stop = async () => {
    await api.post("/auto/stop");
    app.refreshAuto();
    app.refreshRadar();
  };

  const [regText, regTone] = REGISTRAR[auto?.registrar] ?? REGISTRAR.off;
  const showRun = !armed && !!(auto?.targets?.length && auto?.endedReason);

  return (
    <section>
      <SectionLabel
        right={
          armed ? (
            <span className="flex items-center gap-2 text-[12.5px] text-fg-2">
              <Dot tone={regTone} />
              {auto.dry ? "Rehearsal · " : ""}
              {auto.registrar === "scheduled" ? "Scheduled" : "Running"}
            </span>
          ) : null
        }
      >
        Auto-register
      </SectionLabel>
      <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-fg-2">
        Keep your schedule, add the sections you want — even full ones — and let the app finish the job. It stays signed in, checks their seats every few seconds and registers each one the moment a seat opens.
      </p>

      {!armed && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-[6px] border border-line px-4 py-3">
          <div className="min-w-0">
            <p className="text-[12px] text-fg-3">Your current schedule</p>
            <p className="tnum truncate text-[13px] text-fg">{currentSections.length ? currentSections.map((s) => `${s.course}-${s.section}`).join(", ") : "Not set"}</p>
          </div>
          <Button variant={currentSections.length ? "ghost" : "outline"} onClick={onEditCurrent}>
            {currentSections.length ? "Edit" : "Set current schedule"}
          </Button>
        </div>
      )}

      {armed ? (
        <div className="mt-4 rounded-[6px] border border-line">
          <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3">
            <span className="flex items-center gap-2.5 text-[13px] text-fg">
              <Dot tone={regTone} />
              {auto.registrar === "scheduled" && auto.startAt ? (
                <Countdown at={auto.startAt * 1000} />
              ) : auto.registrar === "ready" ? (
                `${regText} · checking every ${radar?.interval ?? interval}s`
              ) : (
                regText
              )}
            </span>
            <Button variant="danger" onClick={stop}>
              Stop
            </Button>
          </div>
          {auto.detail && auto.registrar !== "ready" && <p className="border-b border-line px-4 py-2.5 text-[12px] text-fg-3">{auto.detail}</p>}
          <TargetList targets={auto.targets} seatsLive={seatsLive} />
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex gap-2">
            <input
              className={inputCls}
              inputMode="numeric"
              placeholder="Add a section you want by CRN"
              value={crn}
              onChange={(e) => setCrn(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && crn.trim() && addWanted()}
              aria-label="CRN you want"
            />
            <Button className="h-9" disabled={!crn.trim()} onClick={addWanted}>
              Add
            </Button>
          </div>

          {targets.length === 0 ? (
            <p className="rounded-[6px] border border-dashed border-line px-4 py-7 text-center text-[13px] text-fg-3">
              Nothing to go after yet. Add the sections you want above, or with Add in Planner.
            </p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {targets.map(({ section: s, replaces }) => {
                const open = s.seats.available > 0;
                return (
                  <li key={s.crn} className="group flex items-center gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="tnum text-[13.5px] text-fg">
                        {s.course}-{s.section} <span className="text-fg-3">· {s.crn}</span>
                      </p>
                      <p className="truncate text-[12px] text-fg-3">{s.title}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPicking(s.crn)}
                      title="Choose what happens when this section gets a seat"
                      className={cx(
                        "tnum flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors",
                        replaces.length ? "border-danger/40 text-danger hover:bg-danger/10" : "border-line text-fg-2 hover:border-line-2 hover:bg-hover hover:text-fg",
                      )}
                    >
                      <span className="truncate">{replaces.length ? `Add + drop ${replaces.map(name).join(", ")}` : "Add only"}</span>
                      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M4 6l4 4 4-4" />
                      </svg>
                    </button>
                    <span className="tnum flex items-center gap-1.5 text-[12.5px] text-fg-2">
                      <Dot tone={open ? "ok" : "muted"} />
                      {open ? `${s.seats.available} open now` : "Full"}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${s.course}-${s.section}`}
                      onClick={() => onRemoveFromPlan(s.crn)}
                      className="grid h-6 w-6 place-items-center rounded-full text-[14px] text-fg-3 opacity-0 hover:bg-hover hover:text-fg group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {alreadyHave.length > 0 && (
            <p className="tnum text-[12.5px] text-fg-3">
              Already registered, won't be touched: <span className="text-fg-2">{alreadyHave.map(name).join(", ")}</span>
            </p>
          )}
          {current.length === 0 && targets.length > 0 && (
            <Notice tone="danger" title="Set your current schedule first">
              It's empty, so every section in the plan would be attempted — including ones you already have, and swaps would fail as duplicates.{" "}
              <button type="button" className="font-medium text-fg underline-offset-2 hover:underline" onClick={onEditCurrent}>
                Set it now
              </button>
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex items-center gap-2.5 text-[13px] text-fg-2">
              Check every
              <Select aria-label="Check interval" className="w-[92px]" value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))}>
                {[5, 10, 15, 30].map((s) => (
                  <option key={s} value={s}>
                    {s}s
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex items-center gap-2.5 text-[13px] text-fg-2">
              Start
              <Segmented
                size="sm"
                value={startMode}
                onChange={setStartMode}
                options={[
                  ["now", "Now"],
                  ["at", "At a time"],
                ]}
              />
              {startMode === "at" && (
                <input
                  type="time"
                  aria-label="Start time"
                  value={startTime}
                  onChange={(e) => {
                    setStartTime(e.target.value);
                    writePref("kfupm-auto-start-time", e.target.value);
                  }}
                  className="tnum h-7 rounded-full border border-line bg-transparent px-3 text-[12.5px] text-fg outline-none [color-scheme:dark] focus:border-line-2"
                />
              )}
            </div>
            <Check checked={dry} onChange={setDry}>
              Rehearsal — every step except Submit
            </Check>
            <div className="flex-1" />
            <Button
              variant="primary"
              size="lg"
              disabled={!signedIn || !targets.length || app.job?.status === "running" || (startMode === "at" && !startAt)}
              onClick={() => setConfirming(true)}
            >
              {startMode === "at" ? "Schedule auto-register" : "Start auto-register"}
            </Button>
          </div>
          {startAt && (
            <p className="tnum text-[12.5px] text-fg-3">
              Starts <span className="text-fg-2">{fmtWhen(startAt)}</span> — it signs in 3 minutes early and checks every few seconds from then. Keep the app open and your {deviceName(status)} awake
              {status?.platform === "darwin" ? " (lid open)" : ""}.
            </p>
          )}
          {!signedIn && <p className="text-[12.5px] text-fg-3">Sign in first (top right).</p>}

          {showRun && <LastRun auto={auto} />}
        </div>
      )}

      {auto?.lines?.length > 0 && (
        <div className="mt-3">
          <button type="button" className="text-[12.5px] font-medium text-fg-3 hover:text-fg" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide activity" : "Show activity"}
          </button>
          {showLog && (
            <pre ref={logRef} className="mt-2 max-h-[260px] overflow-auto rounded-[6px] border border-line bg-raised p-4 font-mono text-[11.5px] leading-[1.7] text-fg-2">
              {auto.lines.join("\n")}
            </pre>
          )}
        </div>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={startAt ? `Schedule ${dry ? "a rehearsal" : "auto-register"} for ${fmtWhen(startAt)}?` : dry ? "Start a rehearsal?" : "Start auto-register?"}
        description={
          (startAt ? "It waits until then, signs in 3 minutes early, and starts on time. " : "") +
          (dry
            ? "It will sign in and go through every step for each section that opens, without submitting."
            : "While the app is open it will register these sections on its own as soon as seats open. You can stop it at any time.")
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={start}>
              {startAt ? "Schedule" : dry ? "Start rehearsal" : "Start"}
            </Button>
          </>
        }
      >
        <ul className="space-y-1.5 text-[13px]">
          {targets.map(({ section: s, replaces }) => (
            <li key={s.crn} className="tnum text-fg-2">
              <span className="text-fg">
                {s.course}-{s.section}
              </span>{" "}
              · {s.crn}
              {replaces.length > 0 && <span className="text-danger"> · drops {replaces.map((r) => `${name(r)} (${r.crn})`).join(", ")}</span>}
            </li>
          ))}
        </ul>
        {alreadyHave.length > 0 && <p className="tnum mt-4 text-[12.5px] text-fg-3">Not touched (already registered): {alreadyHave.map(name).join(", ")}</p>}
        {anyReplaces && (
          <p className="mt-4 text-[12px] leading-relaxed text-fg-3">
            Each drop is submitted together with its section using Banner's Conditional Add and Drop, so it only goes through if that section is added.
          </p>
        )}
        {current.length === 0 && <p className="mt-4 text-[12.5px] text-danger">Your current schedule is empty — every section above will be attempted.</p>}
        <p className="mt-4 text-[12px] leading-relaxed text-fg-3">
          Checks every {interval}s · keep the app open and your {deviceName(status)} awake. Automated registration may be against university rules — you're responsible for what's submitted.
        </p>
      </Modal>

      <ActionPicker
        target={pickingTarget}
        currentSections={currentSections}
        claimedBy={claimedBy}
        name={name}
        onClose={() => setPicking(null)}
        onSave={(drops) => {
          saveAction(picking, drops);
          setPicking(null);
        }}
      />
    </section>
  );
}

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered */
  }
}

/** Re-render every `ms` (0 = never). */
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ms) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The next time the clock shows "HH:MM": today if it's still ahead, otherwise tomorrow. */
function nextOccurrence(hhmm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() <= now + 30_000) d.setDate(d.getDate() + 1);
  return d;
}

function fmtWhen(d) {
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const day = d.toDateString() === today.toDateString() ? "today" : d.toDateString() === tomorrow.toDateString() ? "tomorrow" : d.toLocaleDateString("en-US", { weekday: "long" });
  return `${day} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

function Countdown({ at }) {
  const now = useNow(1000);
  const left = Math.max(0, Math.round((at - now) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const sec = left % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return (
    <span className="tnum">
      Scheduled for {fmtWhen(new Date(at))} · starts in {h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`}
      {left <= 180 ? " · signing in…" : ""}
    </span>
  );
}

function readActions(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** Pick what happens when a wanted section gets a seat: just add it, or add it and drop some of your current sections. */
function ActionPicker({ target, currentSections, claimedBy, name, onClose, onSave }) {
  const [mode, setMode] = useState("add");
  const [drops, setDrops] = useState([]);
  const s = target?.section;
  useEffect(() => {
    if (!target) return;
    const initial = target.replaces.map((c) => c.crn);
    setDrops(initial);
    setMode(initial.length ? "swap" : "add");
  }, [target]);
  if (!target) return <Modal open={false} onClose={onClose} />;

  const toggle = (crn, on) => setDrops((d) => (on ? [...new Set([...d, crn])] : d.filter((c) => c !== crn)));
  const suggested = new Set(target.suggested.map((c) => c.crn));
  const chosen = mode === "swap" ? drops : [];
  const canSave = mode === "add" || drops.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`When ${name(s)} gets a seat`}
      description="Choose what auto-register does in that same Banner submission."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSave} onClick={() => onSave(chosen)}>
            Save
          </Button>
        </>
      }
    >
      <Segmented
        className="w-full"
        value={mode}
        onChange={setMode}
        options={[
          ["add", "Just add it"],
          ["swap", "Add it and drop…"],
        ]}
      />
      {mode === "add" ? (
        <p className="mt-4 text-[13px] leading-relaxed text-fg-2">Your current sections all stay. Only {name(s)} is added.</p>
      ) : currentSections.length === 0 ? (
        <p className="mt-4 text-[13px] text-fg-3">Set your current schedule first to pick sections to drop.</p>
      ) : (
        <>
          <p className="mt-4 text-[12.5px] text-fg-3">Drop these when {name(s)} is added — any course:</p>
          <ul className="mt-2 max-h-[260px] space-y-2.5 overflow-auto">
            {currentSections.map((c) => {
              const other = claimedBy.get(c.crn);
              const takenElsewhere = other && other.crn !== s.crn;
              return (
                <li key={c.crn}>
                  <Check checked={drops.includes(c.crn)} disabled={takenElsewhere} onChange={(on) => toggle(c.crn, on)}>
                    <span className="tnum">
                      {name(c)} <span className="text-fg-3">· {c.crn}</span>
                      {suggested.has(c.crn) && <span className="text-fg-3"> · same course</span>}
                      {takenElsewhere && <span className="text-fg-3"> · already dropped for {name(other)}</span>}
                    </span>
                  </Check>
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-[12px] leading-relaxed text-fg-3">
            Banner's Conditional Add and Drop is ticked, so nothing is dropped unless {name(s)} is added. Make sure the new section doesn't clash with anything you keep.
          </p>
        </>
      )}
    </Modal>
  );
}

function TargetList({ targets, seatsLive }) {
  return (
    <ul className="divide-y divide-line">
      {targets.map((t) => {
        const [text, tone, cls] = STATUS[t.status] ?? STATUS.waiting;
        const live = seatsLive.get(t.crn);
        return (
          <li key={t.crn} className="flex items-start gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="tnum truncate text-[13.5px] text-fg">{t.label}</p>
              <p className="tnum mt-0.5 text-[12px] text-fg-3">
                {t.drops.length > 0 ? `replaces ${t.drops.join(", ")} · ` : ""}
                {plural(t.attempts, "attempt")}
                {live?.checkedAt ? ` · checked ${new Date(live.checkedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : ""}
              </p>
              {t.msg && t.status !== "registered" && <p className="mt-1 text-[12px] text-fg-2">{t.msg}</p>}
            </div>
            <span className={cx("flex shrink-0 items-center gap-1.5 text-[12.5px]", cls)}>
              <Dot tone={tone} />
              {text}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function LastRun({ auto }) {
  return (
    <div className="rounded-[6px] border border-line">
      <p className="border-b border-line px-4 py-2.5 text-[12.5px] text-fg-2">Last run · {auto.endedReason}</p>
      <TargetList targets={auto.targets} seatsLive={new Map()} />
    </div>
  );
}
