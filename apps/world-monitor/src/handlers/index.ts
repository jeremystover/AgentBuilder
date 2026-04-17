import { secEdgarHandlers, type DirectHandler } from './sec-edgar.js';

export type { DirectHandler };

export const directHandlers: Record<string, DirectHandler> = {
  ...secEdgarHandlers,
};
