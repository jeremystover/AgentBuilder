import type { ServiceDef } from '../types.js';

export const seismology: ServiceDef = {
  name: 'seismology',
  description: 'Earthquake monitoring — real-time seismic events from USGS (M4.5+ by default).',
  basePath: '/api/seismology/v1',
  tools: [
    {
      name: 'list_earthquakes',
      description:
        'Recent earthquakes from USGS — magnitude, depth, location, tsunami warning status, felt reports. Default min magnitude 4.5.',
      params: {
        start: { type: 'number', description: 'Start timestamp (Unix ms).' },
        end: { type: 'number', description: 'End timestamp (Unix ms).' },
        page_size: { type: 'number', description: 'Results per page.' },
        cursor: { type: 'string', description: 'Pagination cursor.' },
        min_magnitude: { type: 'number', description: 'Minimum magnitude threshold (default 4.5).' },
      },
      endpoint: '/list-earthquakes',
    },
  ],
};
