import { useEffect, useState } from "react";
import { listBudgetCategories } from "../api";
import { TAX_OPTIONS, type OptionCategory } from "../catalog";

export function useCategoryOptions() {
  const [budgetOptions, setBudgetOptions] = useState<OptionCategory[]>([]);

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
  }, []);

  return {
    budgetOptions,
    taxOptions: TAX_OPTIONS,
    allOptions: [...TAX_OPTIONS, ...budgetOptions] as OptionCategory[],
  };
}
