/**
 * web/spa-html.js — agent-branded thin wrappers around the shared shell.
 *
 * The actual HTML lives in @agentbuilder/web-ui-kit. This module just
 * applies the chief-of-staff page titles so log lines and tab titles read
 * naturally, plus the favicon / web-app manifest link tags so the browser
 * tab and MacOS Chrome's "Install as App" pick up the branded ✦ mark.
 *
 * The icons themselves are served by worker.js from /favicon.* and
 * /icon-*.png — see scripts/gen-icons.py for how they're generated.
 */

import { loginHtml as kitLoginHtml, appHtml as kitAppHtml } from "@agentbuilder/web-ui-kit";

const ICON_HEAD = [
  '<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png"/>',
  '<link rel="alternate icon" type="image/x-icon" href="/favicon.ico"/>',
  '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>',
  '<link rel="manifest" href="/manifest.webmanifest"/>',
  '<meta name="theme-color" content="#1f2433"/>',
  '<meta name="apple-mobile-web-app-title" content="Chief of Staff"/>',
  '<meta name="application-name" content="Chief of Staff"/>',
  '<meta name="apple-mobile-web-app-capable" content="yes"/>',
  '<meta name="mobile-web-app-capable" content="yes"/>',
].join("\n");

export function loginHtml({ error } = {}) {
  return kitLoginHtml({ title: "Chief of Staff", error, head: ICON_HEAD });
}

export function appHtml() {
  return kitAppHtml({ title: "Chief of Staff", head: ICON_HEAD });
}
