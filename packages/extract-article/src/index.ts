/**
 * @agentbuilder/extract-article
 *
 * Pure HTML → ExtractedArticle. Used by paywall-replay watchers
 * (medium-watcher, wired-watcher) after they've fetched a page with the
 * subscriber cookie. No fetch or auth concerns live here — those belong
 * to the watcher.
 */

export * from './extract.js';
