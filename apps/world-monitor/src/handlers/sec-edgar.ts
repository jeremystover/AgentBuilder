import { callUrl } from '../client.js';

const SEC_EFTS = 'https://efts.sec.gov/LATEST';
const SEC_DATA = 'https://data.sec.gov';
const SEC_HEADERS: Record<string, string> = {
  // SEC requires a descriptive User-Agent with a contact email per their fair-access policy.
  // https://www.sec.gov/os/accessing-edgar-data
  'user-agent': 'agentbuilder-world-monitor/0.1 (jeremy@stover.com)',
};

const TIMEOUT_MS = 20_000;

export type DirectHandler = (params: Record<string, unknown>) => Promise<unknown>;

function padCik(cik: string): string {
  return cik.replace(/^0*/, '').padStart(10, '0');
}

interface SecSubmissions {
  cik?: string;
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

async function secJson<T>(url: string): Promise<T> {
  const res = await callUrl(url, 'GET', undefined, {
    timeoutMs: TIMEOUT_MS,
    headers: SEC_HEADERS,
  });
  return res.data as T;
}

const searchSecFilings: DirectHandler = async (params) => {
  const url = new URL(`${SEC_EFTS}/search-index`);
  url.searchParams.set('q', String(params.q));
  url.searchParams.set('dateRange', 'custom');
  if (params.forms) url.searchParams.set('forms', String(params.forms));
  if (params.start_date) url.searchParams.set('startdt', String(params.start_date));
  if (params.end_date) url.searchParams.set('enddt', String(params.end_date));
  if (params.from !== undefined) url.searchParams.set('from', String(params.from));
  return secJson(url.toString());
};

function documentUrl(cik: string, accession: string, primary: string): string {
  return `${SEC_DATA}/Archives/edgar/data/${Number.parseInt(cik, 10)}/${accession.replace(/-/g, '')}/${primary}`;
}

async function filingsMatching(
  cik: string,
  limit: number,
  predicate: (form: string) => boolean,
): Promise<{ data: SecSubmissions; indices: number[] }> {
  const data = await secJson<SecSubmissions>(`${SEC_DATA}/submissions/CIK${cik}.json`);
  const recent = data.filings.recent;
  const indices: number[] = [];
  for (let i = 0; i < recent.form.length && indices.length < limit; i++) {
    if (predicate(recent.form[i] ?? '')) indices.push(i);
  }
  return { data, indices };
}

const getInsiderTransactions: DirectHandler = async (params) => {
  const cik = padCik(String(params.cik));
  const limit = Number(params.limit ?? 20);
  const { data, indices } = await filingsMatching(cik, limit, (f) => f === '4' || f === '4/A');
  const r = data.filings.recent;
  return {
    company: data.name,
    cik,
    total_form4_found: indices.length,
    transactions: indices.map((i) => ({
      form: r.form[i],
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i],
      description: r.primaryDocDescription[i],
      accessionNumber: r.accessionNumber[i],
      documentUrl: documentUrl(cik, r.accessionNumber[i] ?? '', r.primaryDocument[i] ?? ''),
    })),
  };
};

const getInstitutionalHoldings: DirectHandler = async (params) => {
  const cik = padCik(String(params.cik));
  const limit = Number(params.limit ?? 50);
  const { data, indices } = await filingsMatching(cik, limit, (f) => f === '13F-HR' || f === '13F-HR/A');
  const r = data.filings.recent;
  return {
    institution: data.name,
    cik,
    total_13f_found: indices.length,
    filings: indices.map((i) => ({
      form: r.form[i],
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i],
      accessionNumber: r.accessionNumber[i],
      documentUrl: documentUrl(cik, r.accessionNumber[i] ?? '', r.primaryDocument[i] ?? ''),
    })),
  };
};

const getCompanyFilings: DirectHandler = async (params) => {
  const cik = padCik(String(params.cik));
  const limit = Number(params.limit ?? 20);
  const typeFilter = params.type ? String(params.type) : undefined;
  const { data, indices } = await filingsMatching(cik, limit, (f) =>
    typeFilter ? f === typeFilter : true,
  );
  const r = data.filings.recent;
  return {
    company: data.name,
    cik,
    filings: indices.map((i) => ({
      form: r.form[i],
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i],
      description: r.primaryDocDescription[i],
      accessionNumber: r.accessionNumber[i],
      documentUrl: documentUrl(cik, r.accessionNumber[i] ?? '', r.primaryDocument[i] ?? ''),
    })),
  };
};

const getCompanyFacts: DirectHandler = async (params) => {
  const cik = padCik(String(params.cik));
  const fact = params.fact ? String(params.fact) : undefined;
  const data = await secJson<Record<string, unknown>>(
    `${SEC_DATA}/api/xbrl/companyfacts/CIK${cik}.json`,
  );
  if (fact) {
    const [taxonomy, concept] = fact.split(':');
    const facts = data.facts as Record<string, Record<string, unknown>> | undefined;
    return facts?.[taxonomy ?? '']?.[concept ?? ''] ?? { error: `Fact "${fact}" not found` };
  }
  return data;
};

export const secEdgarHandlers: Record<string, DirectHandler> = {
  search_sec_filings: searchSecFilings,
  get_insider_transactions: getInsiderTransactions,
  get_institutional_holdings: getInstitutionalHoldings,
  get_company_filings: getCompanyFilings,
  get_company_facts: getCompanyFacts,
};
