// Tiny UI primitives shared across drilldown views. Tailwind-styled,
// no third-party UI deps.

import {
  type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes,
  useEffect, useRef,
} from "react";
import { ChevronUp, ChevronDown } from "lucide-react";

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

export function Modal({
  open, onClose, title, children, footer, width = "max-w-lg",
}: {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`relative ${width} w-full bg-bg-surface rounded-xl shadow-xl flex flex-col max-h-[90vh]`}>
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="font-semibold text-text-primary">{title}</div>
          <button className="text-text-muted hover:text-text-primary" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
        {footer && <div className="border-t border-border px-5 py-3 bg-bg-elevated flex items-center justify-end gap-2">{footer}</div>}
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

// ── New primitives (Phase 1c Step 2) ──────────────────────────────────────

interface SummaryStatProps {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "success" | "warn" | "danger";
}

const STAT_TONE: Record<NonNullable<SummaryStatProps["tone"]>, string> = {
  default: "text-text-primary",
  success: "text-accent-success",
  warn:    "text-accent-warn",
  danger:  "text-accent-danger",
};

export function SummaryStat({ label, value, sub, tone = "default" }: SummaryStatProps) {
  return (
    <Card className="p-4">
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${STAT_TONE[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-text-muted">{sub}</div>}
    </Card>
  );
}

interface SortThProps {
  col: string;
  currentSort: string;
  currentDir: "asc" | "desc";
  onSort: (col: string) => void;
  children: ReactNode;
  className?: string;
}

export function SortTh({ col, currentSort, currentDir, onSort, children, className = "" }: SortThProps) {
  const active = currentSort === col;
  const Icon = active && currentDir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th
      className={`cursor-pointer select-none hover:text-text-primary transition-colors ${className}`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-0.5">
        {children}
        <Icon className={`w-3 h-3 ${active ? "opacity-100" : "opacity-25"}`} />
      </span>
    </th>
  );
}

interface ProgressBarProps {
  value: number;
  tone?: "success" | "warn" | "danger";
}

export function ProgressBar({ value, tone = "success" }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const fillCls = {
    success: "bg-accent-success",
    warn:    "bg-accent-warn",
    danger:  "bg-accent-danger",
  }[tone];
  return (
    <div className="h-2 w-full rounded-full bg-bg-elevated overflow-hidden">
      <div className={`h-full ${fillCls} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence == null) return <Badge tone="neutral">—</Badge>;
  const pct = `${Math.round(confidence * 100)}%`;
  if (confidence >= 0.9) return <Badge tone="ok">{pct}</Badge>;
  if (confidence >= 0.7) return <Badge tone="warn">{pct}</Badge>;
  return <Badge tone="danger">{pct}</Badge>;
}

// IndeterminateCheckbox — supports the three-state "select page / select all" pattern.
export function IndeterminateCheckbox({
  checked, indeterminate, onChange, ...rest
}: InputHTMLAttributes<HTMLInputElement> & { checked: boolean; indeterminate: boolean; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="rounded border-border focus:ring-accent-primary"
      {...rest}
    />
  );
}
