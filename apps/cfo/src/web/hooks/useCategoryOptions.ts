import { useEffect, useMemo, useState } from "react";
import { listBudgetCategories, listTaxCategories } from "../api";
import { TAX_OPTIONS, FAMILY_BUDGET_OPTIONS, type OptionCategory } from "../catalog";

export function useCategoryOptions() {
  const [dbBudgetCategories, setDbBudgetCategories] = useState<OptionCategory[]>([]);
  const [dbTaxCategories, setDbTaxCategories] = useState<OptionCategory[]>([]);

  useEffect(() => {
    listBudgetCategories()
      .then(({ categories }) => {
        setDbBudgetCategories(
          categories
            .filter((c) => c.is_active)
            .map((c) => ({ slug: c.slug, label: c.name, kind: "budget" as const, group: "family" as const }))
        );
      })
      .catch(() => {});

    listTaxCategories()
      .then(({ categories }) => {
        setDbTaxCategories(
          categories
            .filter((c) => c.is_active)
            .map((c) => ({ slug: c.slug, label: c.name, kind: "tax" as const, group: c.category_group }))
        );
      })
      .catch(() => {});
  }, []);

  const budgetOptions = useMemo(() => {
    if (dbBudgetCategories.length === 0) return FAMILY_BUDGET_OPTIONS;
    const map = new Map(FAMILY_BUDGET_OPTIONS.map((o) => [o.slug, o]));
    for (const o of dbBudgetCategories) map.set(o.slug, o);
    return Array.from(map.values());
  }, [dbBudgetCategories]);

  const taxOptions = useMemo(() => {
    if (dbTaxCategories.length === 0) return TAX_OPTIONS;
    const map = new Map(TAX_OPTIONS.map((o) => [o.slug, o]));
    for (const o of dbTaxCategories) map.set(o.slug, o);
    return Array.from(map.values());
  }, [dbTaxCategories]);

  return {
    budgetOptions,
    taxOptions,
    allOptions: [...taxOptions, ...budgetOptions] as OptionCategory[],
  };
}
