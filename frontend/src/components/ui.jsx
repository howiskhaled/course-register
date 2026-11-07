import { useEffect } from "react";

export const cx = (...a) => a.filter(Boolean).join(" ");

const BTN_BASE =
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-2";
const BTN_VARIANT = {
  // the single filled button on a screen
  primary: "bg-fg text-canvas hover:bg-white",
  outline: "border border-line text-fg hover:border-line-2 hover:bg-hover",
  ghost: "text-fg-2 hover:bg-hover hover:text-fg",
  danger: "border border-danger/40 text-danger hover:bg-danger/10",
};
const BTN_SIZE = {
  sm: "h-7 px-3 text-[12.5px]",
  md: "h-8 px-4 text-[13px]",
  lg: "h-10 px-5 text-[14px]",
};

export function Button({ variant = "outline", size = "md", className, type = "button", ...props }) {
  return <button type={type} className={cx(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], className)} {...props} />;
}

export const inputCls =
  "h-9 w-full rounded-full border border-line bg-transparent px-4 text-[13.5px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-line-2 focus:bg-hover";

export function Input({ className, ...props }) {
  return <input className={cx(inputCls, className)} {...props} />;
}

export function Select({ className, children, ...props }) {
  return (
    <div className={cx("relative", className)}>
      <select
        className="h-9 w-full appearance-none truncate rounded-full border border-line bg-transparent pl-4 pr-9 text-[13.5px] text-fg outline-none transition-colors hover:border-line-2 focus:border-line-2"
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-3.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </div>
  );
}

export function Field({ label, hint, children, className }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-[12px] font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] text-fg-3">{hint}</span>}
    </label>
  );
}

export function Segmented({ options, value, onChange, className, size = "md" }) {
  return (
    <div role="radiogroup" className={cx("inline-flex rounded-full border border-line p-[3px]", className)}>
      {options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          role="radio"
          aria-checked={value === val}
          onClick={() => onChange(val)}
          className={cx(
            "flex-1 rounded-full font-medium transition-colors",
            size === "sm" ? "h-6 px-2.5 text-[12px]" : "h-7 px-3.5 text-[12.5px]",
            value === val ? "bg-active text-fg" : "text-fg-2 hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, children, className }) {
  return (
    <label className={cx("flex cursor-default select-none items-center gap-2.5 text-[13px] text-fg-2", className)}>
      <span className="relative inline-flex">
        <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="grid h-[15px] w-[15px] place-items-center rounded-[4px] border border-line-2 transition-colors peer-checked:border-fg peer-checked:bg-fg peer-focus-visible:ring-2 peer-focus-visible:ring-line-2">
          <svg viewBox="0 0 12 12" className={cx("h-2.5 w-2.5 text-canvas", checked ? "opacity-100" : "opacity-0")} fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M2.5 6.2l2.3 2.3 4.7-5" />
          </svg>
        </span>
      </span>
      <span className="text-fg">{children}</span>
    </label>
  );
}

const DOT = { ok: "bg-ok", danger: "bg-danger", warn: "bg-warn", muted: "bg-fg-3", fg: "bg-fg" };
export function Dot({ tone = "muted", className }) {
  return <span aria-hidden="true" className={cx("inline-block h-1.5 w-1.5 shrink-0 rounded-full", DOT[tone], className)} />;
}

export function SectionLabel({ children, right, className }) {
  return (
    <div className={cx("flex items-center justify-between gap-3", className)}>
      <h3 className="text-[13px] font-medium text-fg-2">{children}</h3>
      {right}
    </div>
  );
}

export function Notice({ tone = "muted", title, children, className }) {
  return (
    <div className={cx("flex gap-2.5 rounded-[6px] border border-line px-3 py-2.5 text-[12.5px] leading-relaxed text-fg-2", className)} role={tone === "danger" ? "alert" : "status"}>
      <Dot tone={tone} className="mt-[7px]" />
      <div className="min-w-0">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, description, children, footer, width = "w-[440px]" }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className={cx("max-w-full rounded-[10px] border border-line bg-raised", width)}>
        <div className="px-6 pt-6">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{title}</h2>
          {description && <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">{description}</p>}
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/** The app mark - same artwork as the Dock icon (packaging/make_icon.py), as crisp vector. */
export function AppMark({ size = 26, className }) {
  const block = (x, y, props = {}) => <rect x={x} y={y} width="88" height="136" rx="22" {...props} />;
  return (
    <svg viewBox="100 100 824 824" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id="appmark-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#404044" />
          <stop offset="1" stopColor="#161618" />
        </linearGradient>
      </defs>
      <rect x="103" y="103" width="818" height="818" rx="232" fill="url(#appmark-body)" stroke="#fff" strokeOpacity="0.14" strokeWidth="10" />
      <g fill="#fff">
        {block(244, 300)}
        {block(468, 300)}
        {block(692, 300)}
        <g fillOpacity="0.5">
          {block(356, 392)}
          {block(580, 392)}
          {block(244, 588)}
          {block(692, 588)}
        </g>
      </g>
      {block(468, 588, { fill: "#30d158" })}
    </svg>
  );
}

export function PageHeader({ title, children, right }) {
  return (
    <div className="flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-fg">{title}</h1>
        {children && <p className="mt-2 max-w-[60ch] text-[14px] leading-relaxed text-fg-2">{children}</p>}
      </div>
      {right}
    </div>
  );
}
