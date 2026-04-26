/**
 * web/spa-html.js — agent-branded thin wrappers around the shared shell.
 *
 * The actual HTML lives in @agentbuilder/web-ui-kit. This module just
 * applies the chief-of-staff page titles so log lines and tab titles read
 * naturally.
 */

import { loginHtml as kitLoginHtml, appHtml as kitAppHtml } from "@agentbuilder/web-ui-kit";

export function loginHtml({ error } = {}) {
  return kitLoginHtml({ title: "Chief of Staff", error });
}

export function appHtml() {
  return kitAppHtml({ title: "Chief of Staff" });
}
