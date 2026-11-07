import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { useApp } from "../lib/appState.jsx";
import { plural } from "../lib/format.js";
import { Button, Check, Dot, Modal, Notice, PageHeader, SectionLabel, cx } from "./ui.jsx";
import AutoRegister from "./AutoRegister.jsx";
import { deviceName, vaultName } from "../lib/platform.js";

const STATUS = {
  running: ["Running", "fg"],
  done: ["Finished", "ok"],
  failed: ["Finished with problems", "danger"],
  cancelled: ["Stopped", "muted"],
};

function Changes({ label, items, tone }) {
  if (!items.length) return null;
  return (
    <div className="grid grid-cols-[64px_1fr] gap-4 py-3">
      <span className={cx("text-[13px] font-medium", tone)}>{label}</span>
      <ul className="space-y-1">
        {items.map((s) => (
          <li key={s.crn} className="tnum flex gap-3 text-[13px]">
            <span className="w-28 shrink-0 text-fg">
              {s.course}-{s.section}
            </span>
            <span className="w-14 shrink-0 text-fg-3">{s.crn}</span>
            <span className="truncate text-fg-2">{s.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function RegisterPanel({ term, termLabel, sections, planSections, diff, current, currentSections, onAddToPlan, onRemoveFromPlan, onEditCurrent, notify, onSignIn }) {
  const app = useApp();
  const { status, job } = app;
  const [allowDrop, setAllowDrop] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const logRef = useRef(null);

  const creds = status?.credentials;
  const signedIn = !!(creds?.saved || creds?.fromEnvFile);
  const autoArmed = !!app.auto?.armed;
  const running = job?.status === "running" || autoArmed;
  // send kept sections as wanted too, so the registrar can only ever drop real swaps (diff.drop)
  const wanted = [...new Set([...planSections.map((s) => s.crn), ...diff.keep.map((s) => s.crn)])];
  const toAdd = current.length ? diff.add : planSections;
  const drops = allowDrop ? diff.drop : [];
  const isRegisterJob = job?.kind?.startsWith("register");

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.lines?.length]);

  const run = async (mode, extra = {}) => {
    try {
      await app.startJob("/register", { mode, term, wanted, current, allowDrop, headed: status?.settings?.headed ?? true, ...extra });
    } catch (e) {
      notify(e.status === 409 ? "Another task is already running" : e.message, "warn");
    }
  };

  return (
    <div className="mx-auto max-w-[760px] px-8 py-10">
      <PageHeader title="Register">Register for {termLabel} through Banner from this {deviceName(status)} — automatically the moment seats open, or right now by hand.</PageHeader>

      <section className="mt-10">
        <SectionLabel>Account</SectionLabel>
        <div className="mt-3 flex items-center justify-between gap-4 rounded-[6px] border border-line px-4 py-3.5">
          <div className="flex items-center gap-3">
            <Dot tone={signedIn ? "ok" : "muted"} />
            <div>
              <p className="tnum text-[13.5px] text-fg">{creds?.saved ? creds.id : creds?.fromEnvFile ? "Using the .env file" : "Not signed in"}</p>
              <p className="text-[12px] text-fg-3">{creds?.saved ? (creds.keychain ? `Stored in ${vaultName(status)}` : "Kept in memory for this session") : "Your KFUPM ID and password are needed to register."}</p>
            </div>
          </div>
          <Button variant="outline" onClick={onSignIn}>
            {creds?.saved ? "Change" : "Sign in"}
          </Button>
        </div>
        <Check
          className="mt-3 px-1"
          checked={status?.settings?.headed ?? true}
          onChange={async (v) => {
            await api.post("/settings", { headed: v });
            app.refresh();
          }}
        >
          Show the browser while it works (needed for two-step verification)
        </Check>
      </section>

      <div className="mt-10">
        <AutoRegister
          term={term}
          sections={sections}
          planSections={planSections}
          current={current}
          currentSections={currentSections}
          onAddToPlan={onAddToPlan}
          onRemoveFromPlan={onRemoveFromPlan}
          onEditCurrent={onEditCurrent}
          notify={notify}
        />
      </div>

      <section className="mt-12 border-t border-line pt-10">
        <SectionLabel right={<span className="text-[12px] text-fg-3">{plural(planSections.length, "section")} in plan</span>}>Register now, manually</SectionLabel>
        {planSections.length === 0 ? (
          <p className="mt-3 rounded-[6px] border border-dashed border-line px-4 py-8 text-center text-[13px] text-fg-3">Your plan is empty. Add sections in Planner first.</p>
        ) : (
          <div className="mt-3 divide-y divide-line border-y border-line">
            <Changes label="Add" items={toAdd} tone="text-ok" />
            {current.length > 0 && <Changes label="Drop" items={diff.drop} tone={allowDrop ? "text-danger" : "text-fg-3"} />}
            {current.length > 0 && <Changes label="Keep" items={diff.keep} tone="text-fg-3" />}
          </div>
        )}
        {current.length === 0 && planSections.length > 0 && (
          <p className="mt-3 px-1 text-[12px] text-fg-3">Only adds. To also drop sections, set your current schedule in Planner.</p>
        )}
        {diff.drop.length > 0 && (
          <Check className="mt-3 px-1" checked={allowDrop} onChange={setAllowDrop}>
            Also drop the {plural(diff.drop.length, "section")} marked Drop
          </Check>
        )}
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!signedIn || running} onClick={() => run("check", { wanted: [], current: [] })}>
            Test sign-in
          </Button>
          <Button disabled={!signedIn || running || !planSections.length} onClick={() => run("dry")}>
            Dry run
          </Button>
          <div className="flex-1" />
          <Button variant="primary" size="lg" disabled={!signedIn || running || !planSections.length} onClick={() => setConfirming(true)}>
            Register
          </Button>
        </div>
        <div className="mt-5 space-y-2">
          {!signedIn && <Notice tone="warn">Sign in first.</Notice>}
          {autoArmed && <Notice>Auto-register is running. Stop it to register manually.</Notice>}
          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-[12px] text-fg-3">Something not working? Save a diagnostics file (logs + screenshots of the Banner pages, never your password) and send it to whoever helps you.</p>
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  const r = await api.post("/diagnostics");
                  notify(`Saved ${r.path.split("/").pop()} to your Desktop`);
                } catch (e) {
                  notify(e.message, "warn");
                }
              }}
            >
              Save diagnostics
            </Button>
          </div>
          <Notice>Registration only works while your registration window is open. Signing in, choosing the term and adding CRNs are verified on KFUPM's live Banner; always confirm the final result in Banner's summary. Automating registration may be against university rules — you're responsible for what you submit.</Notice>
        </div>
      </section>

      {job && isRegisterJob && (
        <section className="mt-10">
          <SectionLabel
            right={
              <div className="flex items-center gap-3">
                {STATUS[job.status] && (
                  <span className="flex items-center gap-1.5 text-[12px] text-fg-2">
                    <Dot tone={STATUS[job.status][1]} />
                    {STATUS[job.status][0]}
                  </span>
                )}
                {running && (
                  <Button size="sm" variant="danger" onClick={() => app.cancelJob(job.id)}>
                    Stop
                  </Button>
                )}
              </div>
            }
          >
            Log
          </SectionLabel>
          <pre ref={logRef} className="mt-3 max-h-[360px] overflow-auto rounded-[6px] border border-line bg-raised p-4 font-mono text-[11.5px] leading-[1.7] text-fg-2">
            {job.lines.join("\n") || "Starting…"}
          </pre>
        </section>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Register for real?"
        description="This will be submitted to Banner."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                run("live", { confirm: true });
              }}
            >
              Register now
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[13px]">
          <div>
            <p className="mb-1 font-medium text-ok">Add</p>
            <p className="tnum text-fg-2">{toAdd.map((s) => `${s.course}-${s.section} (${s.crn})`).join(", ") || "—"}</p>
          </div>
          {drops.length > 0 && (
            <div>
              <p className="mb-1 font-medium text-danger">Drop</p>
              <p className="tnum text-fg-2">{drops.map((s) => `${s.course}-${s.section} (${s.crn})`).join(", ")}</p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
