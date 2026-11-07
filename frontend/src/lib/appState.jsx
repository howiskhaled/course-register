import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, isApp, openEvents } from "./api.js";

const Ctx = createContext(null);
const PREFS_KEY = "kfupm-alert-prefs-v1";

function loadPrefs() {
  try {
    return { sound: true, desktop: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return { sound: true, desktop: false };
  }
}

/** three short beeps - no audio file needed */
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25, 0.5].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.2, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.2);
    });
  } catch {
    /* audio blocked */
  }
}

export function AppProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [radar, setRadar] = useState(null);
  const [job, setJob] = useState(null); // {id, kind, status, lines[]}
  const [lastAlert, setLastAlert] = useState(null);
  const [auto, setAuto] = useState(null);
  const [lastRegistered, setLastRegistered] = useState(null);
  const [dataVersion, setDataVersion] = useState(0); // bumps when the scraper finishes
  const [prefs, setPrefsState] = useState(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get("/status"));
    } catch {
      /* server gone */
    }
  }, []);
  const refreshAuto = useCallback(async () => {
    try {
      setAuto(await api.get("/auto"));
    } catch {
      /* ignore */
    }
  }, []);
  const refreshRadar = useCallback(async () => {
    try {
      setRadar(await api.get("/radar"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!isApp) return;
    refresh();
    refreshRadar();
    refreshAuto();
    return openEvents((ev) => {
      if (ev.type === "auto") {
        if (ev.kind === "log") setAuto((a) => (a ? { ...a, lines: [...a.lines, ev.line].slice(-300) } : a));
        else {
          if (ev.kind === "lost") {
            setLastRegistered({ ...ev, lost: true, at: Date.now() });
            beep();
          }
          if (ev.kind === "registered") {
            setLastRegistered({ ...ev, at: Date.now() });
            if (prefsRef.current.sound) beep();
            if (prefsRef.current.desktop && "Notification" in window && Notification.permission === "granted") {
              new Notification("Registered", { body: `CRN ${ev.crns.join(", ")}` });
            }
          }
          refreshAuto();
        }
        return;
      }
      if (ev.type === "radar") {
        refreshRadar();
        if (ev.kind === "open") {
          setLastAlert({ ...ev, at: Date.now() });
          if (prefsRef.current.sound) beep();
          if (prefsRef.current.desktop && "Notification" in window && Notification.permission === "granted") {
            new Notification("🟢 " + ev.label, { body: `${ev.seats} seat(s) available now` });
          }
        }
      } else if (ev.type === "job") {
        setJob((j) => {
          const same = j && j.id === ev.id;
          const base = same ? j : { id: ev.id, kind: ev.kind, status: "running", lines: [] };
          if (ev.line !== undefined) return { ...base, lines: [...base.lines, ev.line] };
          return { ...base, status: ev.status, rc: ev.rc };
        });
        if (ev.status) {
          refresh();
          // make sure the log is complete even if some lines raced the subscription
          if (ev.status !== "running")
            api.get(`/jobs/${ev.id}`).then((full) => setJob((cur) => (cur && cur.id === full.id ? { ...cur, status: full.status, rc: full.rc, lines: full.lines } : cur))).catch(() => {});
        }
      } else if (ev.type === "data") {
        setDataVersion((v) => v + 1);
      }
    });
  }, [refresh, refreshRadar, refreshAuto]);

  const setPrefs = useCallback((patch) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      if (patch.desktop && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      enabled: isApp,
      status,
      auto,
      lastRegistered,
      refreshAuto,
      radar,
      job,
      lastAlert,
      dataVersion,
      prefs,
      setPrefs,
      refresh,
      refreshRadar,
      watch: async (s) => {
        await api.post("/radar/watch", {
          term: s.term,
          crn: s.crn,
          subject: s.subject,
          number: s.number,
          label: `${s.course}-${s.section} · ${s.title} · CRN ${s.crn}`,
          seats: s.seats.available,
          capacity: s.seats.capacity,
        });
        refreshRadar();
      },
      unwatch: async (term, crn) => {
        await api.del(`/radar/watch?term=${term}&crn=${crn}`);
        refreshRadar();
      },
      startJob: async (path, body) => {
        const j = await api.post(path, body);
        // events for this job may already have arrived - don't wipe them
        setJob((cur) => (cur && cur.id === j.id ? cur : { id: j.id, kind: j.kind, status: "running", lines: j.lines || [] }));
        refresh();
        return j;
      },
      cancelJob: async (id) => api.post(`/jobs/${id}/cancel`),
    }),
    [status, radar, job, auto, lastRegistered, lastAlert, dataVersion, prefs, setPrefs, refresh, refreshRadar, refreshAuto],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useApp = () => useContext(Ctx);
