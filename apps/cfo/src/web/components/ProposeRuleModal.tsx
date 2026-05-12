import { useState } from "react";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Select, humanizeSlug } from "./ui";
import { createRule, applyRuleRetroactive, type RuleInput } from "../api";
import type { RuleMatchField, RuleMatchOperator, EntitySlug } from "../types";
import { ENTITY_OPTIONS, TAX_OPTIONS, TRANSFER_OPTION } from "../catalog";
import { useCategoryOptions } from "../hooks/useCategoryOptions";

export const FIELD_OPTIONS: { value: RuleMatchField; label: string }[] = [
  { value: "merchant_name", label: "Merchant" },
  { value: "description",   label: "Description" },
  { value: "account_id",    label: "Account ID" },
  { value: "amount",        label: "Amount" },
];

export const OPERATOR_OPTIONS: { value: RuleMatchOperator; label: string }[] = [
  { value: "contains",    label: "contains" },
  { value: "equals",      label: "equals" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with",   label: "ends with" },
  { value: "regex",       label: "regex" },
];

export type RuleProposal = { draft: RuleInput };

export function buildRuleProposal(opts: {
  merchantName: string | null | undefined;
  description: string | null | undefined;
  entity: string;
  categoryTax: string;
  categoryBudget?: string | null;
}): RuleProposal | null {
  const merchantName = (opts.merchantName ?? "").trim();
  const description = (opts.description ?? "").trim();
  const matchValue = merchantName || description;
  if (!matchValue || !opts.entity || !opts.categoryTax || opts.categoryTax === "transfer") return null;
  return {
    draft: {
      name: `${matchValue} → ${humanizeSlug(opts.categoryTax)}`,
      match_field: merchantName ? "merchant_name" : "description",
      match_operator: "contains",
      match_value: matchValue,
      entity: opts.entity as EntitySlug,
      category_tax: opts.categoryTax,
      category_budget: opts.categoryBudget ?? "",
      priority: 50,
      is_active: true,
    },
  };
}

export function ProposeRuleModal({
  proposal, onDismiss, onSaved,
}: {
  proposal: RuleProposal;
  onDismiss(): void;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState<RuleInput>(proposal.draft);
  const [applyRetroactive, setApplyRetroactive] = useState(true);
  const [busy, setBusy] = useState(false);
  const { budgetOptions } = useCategoryOptions();

  const update = <K extends keyof RuleInput>(key: K, value: RuleInput[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const isTransfer = draft.category_tax === "transfer";

  const handleAdd = async () => {
    if (!draft.name.trim() || !draft.match_value.trim()) {
      toast.error("Name and match value are required");
      return;
    }
    if (!isTransfer && !draft.category_tax && !draft.category_budget) {
      toast.error("Select at least a tax or budget category");
      return;
    }
    setBusy(true);
    try {
      const payload: RuleInput = {
        ...draft,
        entity: isTransfer ? undefined : draft.entity,
        category_tax: draft.category_tax || undefined,
        category_budget: isTransfer ? undefined : (draft.category_budget || undefined),
      };
      const { rule } = await createRule(payload);
      if (applyRetroactive) {
        const r = await applyRuleRetroactive(rule.id);
        if (r.applied > 0) {
          toast.success(`Rule created · applied to ${r.applied} uncategorized transaction${r.applied !== 1 ? "s" : ""}`);
        } else {
          toast.success("Rule created (no uncategorized matches found)");
        }
      } else {
        toast.success("Rule created");
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onDismiss} />
      <div className="relative w-full max-w-lg bg-bg-surface rounded-xl shadow-2xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="font-semibold text-text-primary">Create a rule from this categorization?</div>
          <button className="text-text-muted hover:text-text-primary" onClick={onDismiss} aria-label="Dismiss">✕</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Rule name</label>
            <Input
              type="text"
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
              className="w-full"
            />
          </div>

          <div>
            <div className="text-xs text-text-muted mb-1">When</div>
            <div className="grid grid-cols-3 gap-2">
              <Select value={draft.match_field} onChange={(e) => update("match_field", e.target.value as RuleMatchField)} className="w-full">
                {FIELD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              <Select value={draft.match_operator} onChange={(e) => update("match_operator", e.target.value as RuleMatchOperator)} className="w-full">
                {OPERATOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              <Input
                type="text"
                value={draft.match_value}
                onChange={(e) => update("match_value", e.target.value)}
                className="w-full"
              />
            </div>
          </div>

          <div>
            <div className="text-xs text-text-muted mb-1">Classify as</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-text-muted mb-1">Tax category</label>
                <Select
                  value={draft.category_tax ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    update("category_tax", val);
                    if (val === "transfer") update("category_budget", "");
                  }}
                  className="w-full"
                >
                  <option value="">— none —</option>
                  <option value={TRANSFER_OPTION.slug}>{TRANSFER_OPTION.label}</option>
                  <optgroup label="Schedule C">
                    {TAX_OPTIONS.filter((c) => c.group === "schedule_c").map(({ slug, label }) => (
                      <option key={slug} value={slug}>{label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Schedule E">
                    {TAX_OPTIONS.filter((c) => c.group === "schedule_e").map(({ slug, label }) => (
                      <option key={slug} value={slug}>{label}</option>
                    ))}
                  </optgroup>
                </Select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Budget category</label>
                <Select
                  value={draft.category_budget ?? ""}
                  onChange={(e) => update("category_budget", e.target.value)}
                  className="w-full"
                  disabled={isTransfer}
                >
                  <option value="">— none —</option>
                  {budgetOptions.map(({ slug, label }) => (
                    <option key={slug} value={slug}>{label}</option>
                  ))}
                </Select>
              </div>
              {!isTransfer && (
                <div className="col-span-2">
                  <label className="block text-xs text-text-muted mb-1">Entity</label>
                  <Select value={draft.entity ?? "family_personal"} onChange={(e) => update("entity", e.target.value as EntitySlug)} className="w-full">
                    {ENTITY_OPTIONS.map(({ slug, label }) => <option key={slug} value={slug}>{label}</option>)}
                  </Select>
                </div>
              )}
              {isTransfer && (
                <div className="col-span-2 text-xs text-text-muted bg-bg-elevated rounded px-3 py-2">
                  Transfers are excluded from all tax reports and budgets.
                </div>
              )}
            </div>
          </div>

          <label className="flex items-start gap-3 p-3 rounded-lg border border-border bg-bg-elevated cursor-pointer">
            <input
              type="checkbox"
              checked={applyRetroactive}
              onChange={(e) => setApplyRetroactive(e.target.checked)}
              className="mt-0.5 rounded"
            />
            <div>
              <div className="text-sm font-medium text-text-primary">Apply to past uncategorized transactions</div>
              <div className="text-xs text-text-muted mt-0.5">Categorize any existing transactions that match this rule and don't have a category yet. Manually categorized transactions are never touched.</div>
            </div>
          </label>
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3 bg-bg-elevated rounded-b-xl">
          <Button variant="ghost" onClick={onDismiss} disabled={busy}>Dismiss</Button>
          <Button variant="primary" onClick={() => void handleAdd()} disabled={busy}>
            <Check className="w-4 h-4" /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}
