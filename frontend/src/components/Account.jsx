import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { useApp } from "../lib/appState.jsx";
import { Button, Field, Input, Modal } from "./ui.jsx";
import { deviceName, vaultName } from "../lib/platform.js";

export function SignInDialog({ open, onClose, notify }) {
  const app = useApp();
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setId(app.status?.credentials?.id || "");
      setPw("");
      setError("");
    }
  }, [open, app.status?.credentials?.id]);

  const save = async (e) => {
    e?.preventDefault();
    if (!id.trim() || !pw) return;
    setBusy(true);
    setError("");
    try {
      await api.post("/credentials", { id: id.trim(), password: pw });
      await app.refresh();
      setPw("");
      notify(`Signed in as ${id.trim()}`);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const keychain = app.status?.credentials?.keychain !== false;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sign in to KFUPM"
      description={
        keychain
          ? `Your ID and password are stored in ${vaultName(app.status)} and used only to sign in to Banner from this ${deviceName(app.status)}.`
          : "No keychain is available, so your credentials are kept in memory until you quit the app."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy || !id.trim() || !pw}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form onSubmit={save} className="space-y-4">
        <Field label="KFUPM ID">
          <Input autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="s202012345" autoComplete="username" spellCheck={false} />
        </Field>
        <Field label="Password">
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
        </Field>
        {error && <p className="text-[12.5px] text-danger">{error}</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function AccountButton({ onSignIn, onVerify, notify }) {
  const app = useApp();
  const creds = app.status?.credentials;
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (!creds?.saved) {
    return (
      <Button variant="outline" onClick={onSignIn}>
        Sign in
      </Button>
    );
  }

  const signOut = async () => {
    await api.del("/credentials");
    await app.refresh();
    setOpen(false);
    notify("Signed out");
  };

  return (
    <div className="relative" ref={ref}>
      <Button variant="outline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
        <span className="tnum">{creds.id}</span>
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-[8px] border border-line bg-raised" role="menu">
          <div className="border-b border-line px-4 py-3">
            <p className="text-[12px] text-fg-3">Signed in as</p>
            <p className="tnum text-[13.5px] font-medium text-fg">{creds.id}</p>
            <p className="mt-1 text-[11.5px] text-fg-3">{creds.keychain ? `Stored in ${vaultName(app.status)}` : "Kept in memory for this session"}</p>
          </div>
          {[
            ["Verify sign-in", () => (setOpen(false), onVerify())],
            ["Change credentials", () => (setOpen(false), onSignIn())],
            ["Sign out", signOut],
          ].map(([label, fn]) => (
            <button key={label} type="button" role="menuitem" onClick={fn} className="block w-full px-4 py-2.5 text-left text-[13px] text-fg-2 hover:bg-hover hover:text-fg">
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
