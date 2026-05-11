import { useEffect, useMemo, useState } from "react";
import { listBudgetCategories } from "../api";
import { TAX_OPTIONS, FAMILY_BUDGET_OPTIONS, type OptionCategory } from "../catalog";

export function useCategoryOptions() {
  const [dbCategories, setDbCategories] = useState<OptionCategory[]>([]);

  useEffect(() => {
    listBudgetCategories()
      .then(({ categories }) => {
        setDbCategories(
          categories
            .filter((c) => c.is_active)
            .map((c) => ({ slug: c.slug, label: c.name, kind: "budget" as const, group: "family" as const }))
        );
      })
      .catch(() => {});
  }, []);

  // Always show the standard family budget options; DB-created categories
  // override labels or add new slugs on top.
  const budgetOptions = useMemo(() => {
    if (dbCategories.length === 0) return FAMILY_BUDGET_OPTIONS;
    const map = new Map(FAMILY_BUDGET_OPTIONS.map((o) => [o.slug, o]));
    for (const o of dbCategories) map.set(o.slug, o);
    return Array.from(map.values());
  }, [dbCategories]);

  return {
    budgetOptions,
    taxOptions: TAX_OPTIONS,
    allOptions: [...TAX_OPTIONS, ...budgetOptions] as OptionCategory[],
  };
}
