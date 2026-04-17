import type { ServiceDef } from '../types.js';

export const market: ServiceDef = {
  name: 'market',
  description:
    'Financial market data — stock quotes, crypto prices, commodities, sector performance, stablecoin peg health, BTC ETF flows, country indices, and Gulf region markets.',
  basePath: '/api/market/v1',
  tools: [
    {
      name: 'list_market_quotes',
      description:
        'Real-time stock and index quotes. Supports major indices (^GSPC, ^DJI, ^IXIC, ^VIX), futures (GC=F, CL=F), and individual stocks.',
      params: {
        symbols: {
          type: 'string[]',
          description:
            'Comma-separated ticker symbols (e.g. "AAPL,MSFT,^GSPC,GC=F"). Leave empty for default watchlist.',
        },
      },
      endpoint: '/list-market-quotes',
    },
    {
      name: 'list_crypto_quotes',
      description:
        'Cryptocurrency prices and market data — price, 24h change, market cap, volume for top coins.',
      params: {
        ids: {
          type: 'string[]',
          description:
            'Comma-separated CoinGecko IDs (e.g. "bitcoin,ethereum,solana"). Leave empty for top coins.',
        },
      },
      endpoint: '/list-crypto-quotes',
    },
    {
      name: 'list_commodity_quotes',
      description:
        'Commodity futures prices — gold (GC=F), crude oil (CL=F), natural gas (NG=F), silver (SI=F), copper (HG=F).',
      params: {
        symbols: {
          type: 'string[]',
          description:
            'Comma-separated Yahoo Finance commodity symbols (e.g. "GC=F,CL=F,NG=F").',
        },
      },
      endpoint: '/list-commodity-quotes',
    },
    {
      name: 'get_sector_summary',
      description:
        'Sector ETF performance — Technology (XLK), Healthcare (XLV), Financials (XLF), Energy (XLE), etc.',
      params: {
        period: {
          type: 'string',
          description: 'Time period (e.g. "1d", "5d", "1mo", "3mo", "ytd").',
        },
      },
      endpoint: '/get-sector-summary',
    },
    {
      name: 'list_stablecoin_markets',
      description:
        'Stablecoin peg health — USDT, USDC, DAI, FDUSD, USDe with price deviation from $1.00.',
      params: {
        coins: {
          type: 'string[]',
          description:
            'Comma-separated CoinGecko stablecoin IDs (e.g. "tether,usd-coin,dai").',
        },
      },
      endpoint: '/list-stablecoin-markets',
    },
    {
      name: 'list_etf_flows',
      description:
        'BTC spot ETF flow data — IBIT, FBTC, GBTC, ARKB, HODL, BRRR inflows/outflows.',
      endpoint: '/list-etf-flows',
    },
    {
      name: 'get_country_stock_index',
      description:
        'Primary stock market index for a country (e.g. S&P 500 for US, Nikkei for JP, DAX for DE).',
      params: {
        country_code: {
          type: 'string',
          description: 'ISO 3166-1 alpha-2 country code (e.g. "US", "JP", "DE", "GB").',
          required: true,
        },
      },
      endpoint: '/get-country-stock-index',
    },
    {
      name: 'list_gulf_quotes',
      description:
        'Gulf Cooperation Council markets — Tadawul, Dubai, Abu Dhabi (ADX), Qatar, Muscat, plus Gulf currencies and oil prices.',
      endpoint: '/list-gulf-quotes',
    },
  ],
};
