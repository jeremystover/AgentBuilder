import { useCallback, useEffect, useState } from "react";
import { getBankConfig, listAccounts } from "../api";
import type { Account, BankConfig } from "../types";

export interface UseAccountsResult {
  accounts: Account[];
  config: BankConfig | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAccounts(): UseAccountsResult {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [config, setConfig] = useState<BankConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [acctRes, cfgRes] = await Promise.all([listAccounts(), getBankConfig()]);
      setAccounts(acctRes.accounts);
      setConfig(cfgRes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { accounts, config, loading, error, refresh };
}
