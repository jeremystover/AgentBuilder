import type { ServiceDef } from '../types.js';

export const news: ServiceDef = {
  name: 'news',
  description:
    'News aggregation — batch RSS feed digests from 150+ sources, grouped by variant (full/tech/finance) and locale.',
  basePath: '/api/news/v1',
  tools: [
    {
      name: 'list_feed_digest',
      description:
        'Batch digest of recent articles from 20+ RSS feeds. Pre-aggregated headlines from tier-1 and tier-2 news sources.',
      params: {
        variant: {
          type: 'string',
          description: 'Site variant: "full", "tech", or "finance".',
        },
        lang: {
          type: 'string',
          description: 'Language code for locale-boosted feeds (e.g. "en", "fr", "ar").',
        },
      },
      endpoint: '/list-feed-digest',
    },
  ],
};
