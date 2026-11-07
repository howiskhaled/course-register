import { useState } from "react";
import { api } from "../lib/api.js";
import { useApp } from "../lib/appState.jsx";
import { fmtClock, plural } from "../lib/format.js";
import { Button, Check, Dot, Field, Input, PageHeader, SectionLabel, Select, inputCls } from "./ui.jsx";

function Telegram({ notify }) {
  const app = useApp();
  const tg = app.status?.telegram;
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [chat, setChat] = useState(tg?.chatId || "");

  const call = async (fn, ok) => {
    try {
      await fn();
      await app.refresh();
      if (ok) notify(ok);
    } catch (e) {
      notify(e.message, "warn");
    }
  };

  return (
    <section className="mt-10">
      <SectionLabel
        right={
          <button type="button" className="text-[12.5px] font-medium text-fg-2 hover:text-fg" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : tg?.tokenSaved && tg?.chatId ? "Edit" : "Set up"}
          </button>
        }
      >
        <span className="flex items-center gap-2">
          Telegram alerts
          {tg?.tokenSaved && tg?.chatId && (
            <span className="flex items-center gap-1.5 text-[12px] font-normal text-fg-3">
              <Dot tone="ok" /> Connected
            </span>
          )}
        </span>
      </SectionLabel>
      {open && (
        <div className="mt-3 space-y-4 rounded-[6px] border border-line p-4">
          <ol className="list-decimal space-y-1 pl-4 text-[12.5px] leading-relaxed text-fg-2">
            <li>In Telegram, open @BotFather, send /newbot and copy the token.</li>
            <li>Paste it below, then send any message to your new bot.</li>
            <li>Press Detect to link this chat.</li>
          </ol>
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Bot token${tg?.tokenSaved ? " · saved" : ""}`}>
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={tg?.tokenSaved ? "••••••••••" : "123456:ABC…"} />
            </Field>
            <Field label="Chat ID">
              <Input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="123456789" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!token && !tg?.tokenSaved}
              onClick={() =>
                call(async () => {
                  if (token) await api.post("/settings", { telegramToken: token });
                  const r = await api.post("/telegram/detect");
                  setChat(r.chatId);
                  setToken("");
                  await api.post("/settings", { telegramChatId: r.chatId });
                }, "Chat linked")
              }
            >
              Detect
            </Button>
            <Button
              disabled={!token && chat === (tg?.chatId || "")}
              onClick={() =>
                call(async () => {
                  await api.post("/settings", { telegramChatId: chat, ...(token ? { telegramToken: token } : {}) });
                  setToken("");
                }, "Saved")
              }
            >
              Save
            </Button>
            <Button variant="ghost" disabled={!tg?.tokenSaved || !tg?.chatId} onClick={() => call(() => api.post("/telegram/test"), "Test message sent")}>
              Send test
            </Button>
            {tg?.tokenSaved && (
              <Button variant="ghost" onClick={() => call(() => api.post("/settings", { clearTelegram: true }), "Telegram removed")}>
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default function RadarPanel({ term, sections, notify, onRegisterStarted }) {
  const app = useApp();
  const { radar, prefs, status } = app;
  const [crn, setCrn] = useState("");
  const watches = radar?.watches ?? [];
  const byCrn = new Map(sections.map((s) => [s.crn, s]));

  const addCrn = async () => {
    const s = byCrn.get(crn.trim());
    if (!s) return notify("That CRN isn't in this term's data.", "warn");
    await app.watch({ ...s, term });
    setCrn("");
  };

  const registerNow = async (w) => {
    if (!window.confirm(`Register for real?\n\n${w.label}`)) return;
    try {
      await app.startJob("/register", { mode: "live", confirm: true, term: w.term, wanted: [w.crn], current: [], allowDrop: false, headed: status?.settings?.headed ?? true });
      onRegisterStarted?.();
    } catch (e) {
      notify(e.status === 409 ? "Another task is already running" : e.message, "warn");
    }
  };

  const running = radar?.running;
  return (
    <div className="mx-auto max-w-[760px] px-8 py-10">
      <PageHeader
        title="Radar"
        right={
          <span className="flex items-center gap-2 text-[12.5px] text-fg-2">
            <Dot tone={running ? "ok" : "muted"} />
            {radar?.checking ? "Checking…" : running ? `Watching · every ${radar.interval}s` : "Paused"}
          </span>
        }
      >
        Watches full sections and tells you the moment a seat opens. Runs while this app is open.
      </PageHeader>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <div className="flex min-w-[260px] flex-1 gap-2">
          <input
            className={inputCls}
            inputMode="numeric"
            placeholder="Add a CRN to watch"
            value={crn}
            onChange={(e) => setCrn(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && crn.trim() && addCrn()}
            aria-label="CRN to watch"
          />
          <Button className="h-9" disabled={!crn.trim()} onClick={addCrn}>
            Watch
          </Button>
        </div>
        <Select aria-label="Check interval" className="w-36" value={radar?.interval ?? 45} onChange={(e) => api.post("/radar/interval", { seconds: Number(e.target.value) }).then(app.refreshRadar)}>
          {[15, 30, 45, 60, 120, 300].map((s) => (
            <option key={s} value={s}>
              Every {s < 60 ? `${s}s` : `${s / 60} min`}
            </option>
          ))}
        </Select>
        <Button variant="ghost" disabled={!watches.length} onClick={() => api.post("/radar/check")}>
          Check now
        </Button>
        <Button variant="ghost" onClick={() => api.post(running ? "/radar/pause" : "/radar/resume")}>
          {running ? "Pause" : "Resume"}
        </Button>
      </div>
      {radar?.lastError && <p className="mt-3 text-[12.5px] text-danger">Last check failed: {radar.lastError}</p>}

      <section className="mt-8">
        <SectionLabel right={<span className="text-[12px] text-fg-3">{plural(watches.length, "section")}</span>}>Watching</SectionLabel>
        {watches.length === 0 ? (
          <p className="mt-3 rounded-[6px] border border-dashed border-line px-4 py-8 text-center text-[13px] text-fg-3">
            Nothing yet. Choose Watch on a full section in Planner, or add a CRN above.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {watches.map((w) => (
              <li key={w.term + w.crn} className="flex items-center gap-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <p className="tnum truncate text-[13.5px] text-fg">{w.label}</p>
                  <p className="tnum mt-0.5 text-[12px] text-fg-3">
                    {w.term} · {w.checkedAt ? `checked ${fmtClock(w.checkedAt)}` : "not checked yet"}
                  </p>
                </div>
                <span className="tnum flex w-28 items-center gap-1.5 text-[12.5px] text-fg-2">
                  <Dot tone={w.open ? "ok" : "muted"} />
                  {w.open ? `Open · ${w.seats}` : "Full"}
                </span>
                {w.open ? (
                  <Button variant="primary" onClick={() => registerNow(w)}>
                    Register now
                  </Button>
                ) : (
                  <span className="w-[108px]" />
                )}
                <Button variant="ghost" size="sm" onClick={() => app.unwatch(w.term, w.crn)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <SectionLabel
          right={
            <div className="flex gap-5">
              <Check checked={prefs.sound} onChange={(v) => app.setPrefs({ sound: v })}>
                Sound
              </Check>
              <Check checked={prefs.desktop} onChange={(v) => app.setPrefs({ desktop: v })}>
                Notifications
              </Check>
            </div>
          }
        >
          Alerts
        </SectionLabel>
        {(radar?.history ?? []).length === 0 ? (
          <p className="mt-3 text-[13px] text-fg-3">No seats have opened yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {[...radar.history].reverse().map((h, i) => (
              <li key={i} className="tnum flex items-center gap-3 text-[12.5px]">
                <span className="w-24 shrink-0 text-fg-3">{fmtClock(h.time)}</span>
                <Dot tone="ok" />
                <span className="truncate text-fg">{h.label}</span>
                <span className="shrink-0 text-fg-2">{plural(h.seats, "seat")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Telegram notify={notify} />
    </div>
  );
}
