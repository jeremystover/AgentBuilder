import type { ServiceDef } from '../types.js';

export const secEdgar: ServiceDef = {
  name: 'sec-edgar',
  description:
    'SEC EDGAR — full-text filing search, insider transactions (Form 4), institutional holdings (13F), company filings, and XBRL financial facts. Called directly against SEC EDGAR (no worldmonitor.app dependency).',
  basePath: '/api/sec-edgar/v1',
  tools: [
    {
      name: 'search_sec_filings',
      description:
        'Full-text search across SEC filings via EDGAR EFTS. Returns filing type, company name, date, and document links.',
      params: {
        q: {
          type: 'string',
          description: 'Search query (e.g. "artificial intelligence", "stock buyback").',
          required: true,
        },
        forms: {
          type: 'string',
          description: 'Comma-separated form types (e.g. "10-K,10-Q,8-K").',
        },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD.' },
        from: { type: 'number', description: 'Pagination offset (default 0).' },
      },
      endpoint: '/search-sec-filings',
    },
    {
      name: 'get_insider_transactions',
      description:
        'Insider trading transactions (Form 4) for a company by CIK. Buys, sells, and option exercises by officers and directors.',
      params: {
        cik: {
          type: 'string',
          description: 'SEC CIK (e.g. "0000320193" for Apple, "789019" for Microsoft).',
          required: true,
        },
        limit: { type: 'number', description: 'Max transactions (default 20).' },
      },
      endpoint: '/get-insider-transactions',
    },
    {
      name: 'get_institutional_holdings',
      description:
        'Institutional holdings from 13F filings. Shows when filings were made and which funds hold positions.',
      params: {
        cik: {
          type: 'string',
          description: 'SEC CIK of the filer (e.g. "1067983" for Berkshire Hathaway).',
          required: true,
        },
        limit: { type: 'number', description: 'Max filings (default 50).' },
      },
      endpoint: '/get-institutional-holdings',
    },
    {
      name: 'get_company_filings',
      description:
        'Recent SEC filings for a company by CIK. Returns filing type, date, description, and document links.',
      params: {
        cik: {
          type: 'string',
          description: 'SEC CIK (e.g. "0000320193" for Apple).',
          required: true,
        },
        type: {
          type: 'string',
          description: 'Filing type filter (e.g. "10-K", "10-Q", "8-K").',
        },
        limit: { type: 'number', description: 'Max filings (default 20).' },
      },
      endpoint: '/get-company-filings',
    },
    {
      name: 'get_company_facts',
      description:
        'XBRL financial facts for a company — revenue, net income, EPS, total assets, and other standardized data points from filings.',
      params: {
        cik: {
          type: 'string',
          description: 'SEC CIK (e.g. "0000320193" for Apple).',
          required: true,
        },
        fact: {
          type: 'string',
          description:
            'Specific XBRL fact (e.g. "us-gaap:Revenue", "us-gaap:NetIncomeLoss").',
        },
      },
      endpoint: '/get-company-facts',
    },
  ],
};
