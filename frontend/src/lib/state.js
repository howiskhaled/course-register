import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isApp } from "./api.js";

const KEY = "kfupm-state-v2";

const uid = () => Math.random().toString(36).slice(2, 9);
const newPlan = (name) => ({ id: uid(), name, crns: [] });
const emptyTerm = () => {
  const p = newPlan("Plan A");
  return { plans: [p], activePlanId: p.id, current: [] };
};

function loadLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { term: null, terms: {} };
}

/** CRN lists are stored as strings; accept pasted text like "25052, 23853\n20843". */
export function parseCrns(text) {
  return [...new Set((text.match(/\b\d{4,6}\b/g) || []).map(String))];
}

/**
 * All planner state:
 *   term                 selected term code
 *   terms[code].plans    several named plans per term
 *   terms[code].current  CRNs the student is registered in right now
 *
 * In the desktop app it is saved by the app itself (Application Support), so plans survive
 * restarts and port changes. The website falls back to localStorage.
 */
export function usePlannerState() {
  const [state, setState] = useState(loadLocal);
  const [ready, setReady] = useState(!isApp);
  const saveTimer = useRef(null);

  // app: load the saved state from the app once
  useEffect(() => {
    if (!isApp) return;
    api
      .get("/kv/planner")
      .then((r) => {
        if (r.value && typeof r.value === "object" && r.value.terms) setState(r.value);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  // persist (debounced for the app)
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private mode */
    }
    if (!isApp || !ready) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => api.post("/kv/planner", { value: state }).catch(() => {}), 300);
  }, [state, ready]);

  const term = state.term;
  const t = useMemo(() => (term && state.terms[term]) || null, [state, term]);

  const patchTerm = useCallback(
    (fn) =>
      setState((s) => {
        if (!s.term) return s;
        const cur = s.terms[s.term] || emptyTerm();
        return { ...s, terms: { ...s.terms, [s.term]: fn(cur) } };
      }),
    [],
  );

  const setTerm = useCallback((code) => {
    setState((s) => ({ ...s, term: code, terms: { ...s.terms, [code]: s.terms[code] || emptyTerm() } }));
  }, []);

  const plans = t?.plans ?? [];
  const activePlan = plans.find((p) => p.id === t?.activePlanId) ?? plans[0] ?? null;

  const setCrns = useCallback(
    (fn) =>
      patchTerm((cur) => ({
        ...cur,
        plans: cur.plans.map((p) =>
          p.id === (cur.activePlanId ?? cur.plans[0].id) ? { ...p, crns: typeof fn === "function" ? fn(p.crns) : fn } : p,
        ),
      })),
    [patchTerm],
  );

  const api_ = useMemo(
    () => ({
      setActivePlanId: (id) => patchTerm((cur) => ({ ...cur, activePlanId: id })),
      addPlan: (name, crns = []) =>
        patchTerm((cur) => {
          const p = { ...newPlan(name || `Plan ${String.fromCharCode(65 + cur.plans.length)}`), crns };
          return { ...cur, plans: [...cur.plans, p], activePlanId: p.id };
        }),
      renamePlan: (id, name) => patchTerm((cur) => ({ ...cur, plans: cur.plans.map((p) => (p.id === id ? { ...p, name } : p)) })),
      deletePlan: (id) =>
        patchTerm((cur) => {
          if (cur.plans.length <= 1) return { ...cur, plans: cur.plans.map((p) => ({ ...p, crns: [] })) };
          const plans = cur.plans.filter((p) => p.id !== id);
          return { ...cur, plans, activePlanId: plans[0].id };
        }),
      setCurrent: (crns) => patchTerm((cur) => ({ ...cur, current: crns })),
    }),
    [patchTerm],
  );

  return { ready, term, setTerm, plans, activePlan, crns: activePlan?.crns ?? [], setCrns, current: t?.current ?? [], ...api_ };
}
