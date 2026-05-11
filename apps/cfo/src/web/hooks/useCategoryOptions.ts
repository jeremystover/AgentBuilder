import { useEffect, useState } from "react";
import { listBudgetCategories, listTaxCategories } from "../api";
import type { OptionCategory } from "../catalog";

export function useCategoryOptions() {
  const [budgetOptions, setBudgetOptions] = useState<OptionCategory[]>([]);
  const [taxOptions, setTaxOptions] = useState<OptionCategory[]>([]);

  useEffect(() => {
    listBudgetCategories()
      .then(({ categories }) => {
        setBudgetOptions(
          categories
            .filter((c) => c.is_active)
            .map((c) => ({ slug: c.slug, label: c.name, kind: "budget" as const, group: "family" as const }))
        );
      })
      .catch(() => {});

    listTaxCategories()
      .then(({ categories }) => {
        setTaxOptions(
          categories
            .filter((c) => c.is_active)
            .map((c) => ({ slug: c.slug, label: c.name, kind: "tax" as const, group: c.category_group }))
        );
      })
      .catch(() => {});
  }, []);

  return {
    budgetOptions,
    taxOptions,
    allOptions: [...taxOptions, ...budgetOptions] as OptionCategory[],
  };
}
