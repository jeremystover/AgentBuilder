// Tiny UI primitives shared across drilldown views. Tailwind-styled,
// no third-party UI deps. Each is a thin wrapper over native elements so
// you can pass `className` to override anywhere.

import { type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "success" | "danger" | "warn";
type Size = "sm" | "md";

const VARIANT_CLS: Record<Variant, string> = {
  primary: "bg-accent-primary text-white hover:opacity-90 disabled:opacity-40",
  ghost:   "border border-border text-text-primary hover:bg-bg-elevated disabled:opacity-40",
  success: "bg-accent-success text-white hover:opacity-90 disabled:opacity-40",
  danger:  "bg-accent-danger text-white hover:opacity-90 disabled:opacity-40",
  warn:    "bg-accent-warn text-white hover:opacity-90 disabled:opacity-40",
};

const SIZE_CLS: Record<Size, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = "ghost", size = "md", className = "", children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors ${VARIANT_CLS[variant]} ${SIZE_CLS[size]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-bg-surface ${className}`}>
      {children}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "danger" | "info"; children: ReactNode }) {
  const cls = {
    neutral: "bg-bg-elevated text-text-muted",
    ok:      "bg-accent-success/10 text-accent-success",
    warn:    "bg-accent-warn/10 text-accent-warn",
    danger:  "bg-accent-danger/10 text-accent-danger",
    info:    "bg-accent-primary/10 text-accent-primary",
  }[tone];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{children}</span>;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", ...rest } = props;
  return (
    <select
      {...rest}
      className={`rounded-lg border border-border bg-bg-surface px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary ${className}`}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return (
    <input
      {...rest}
      className={`rounded-lg border border-border bg-bg-surface px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary ${className}`}
    />
  );
}

export function Drawer({
  open, onClose, title, children, footer,
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative ml-auto h-full w-full max-w-xl bg-bg-surface shadow-xl flex flex-col">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="font-semibold text-text-primary">{title}</div>
          <button className="text-text-muted hover:text-text-primary" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
        {footer && <div className="border-t border-border px-5 py-3 bg-bg-elevated">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-5">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
        {subtitle && <p className="text-sm text-text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="text-center py-10 text-text-subtle text-sm">{children}</div>;
}

export function fmtUsd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  const s = opts.sign ? (n < 0 ? "-" : "+") : (n < 0 ? "-" : "");
  return `${s}$${abs.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function humanizeSlug(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/_/g, " ");
}
