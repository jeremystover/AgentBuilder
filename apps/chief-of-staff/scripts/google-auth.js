#!/usr/bin/env node
/**
 * scripts/google-auth.js — Obtain a Google OAuth2 offline refresh token.
 *
 * Starts a local HTTP server, opens the Google consent page in your browser,
 * captures the authorization code from the redirect, and exchanges it for
 * a refresh token. Prints the wrangler command to store it as a secret.
 *
 * Usage (personal account):
 *   GOOGLE_OAUTH_CLIENT_ID=<id> GOOGLE_OAUTH_CLIENT_SECRET=<secret> \
 *     node scripts/google-auth.js
 *
 * Usage (named work account, e.g. "work"):
 *   GOOGLE_OAUTH_WORK_CLIENT_ID=<id> GOOGLE_OAUTH_WORK_CLIENT_SECRET=<secret> \
 *     node scripts/google-auth.js --account work
 *
 * After running, store the printed refresh token:
 *   wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN        # personal
 *   wrangler secret put GOOGLE_OAUTH_WORK_REFRESH_TOKEN   # named account
 */

import { createServer } from "http";
import { exec } from "child_process";
import { URL, URLSearchParams } from "url";

// ── Scopes ────────────────────────────────────────────────────────────────────
// Matches the permissions the chief-of-staff worker actually uses:
//   Gmail:    read + compose
//   Calendar: read + write
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar",
].join(" ");

// ── Args ──────────────────────────────────────────────────────────────────────
const accountIdx = process.argv.indexOf("--account");
const account = accountIdx !== -1 ? (process.argv[accountIdx + 1] || "") : "personal";
if (!account) {
  console.error("--account flag requires a value (e.g. --account work)");
  process.exit(1);
}

const isDefault = account === "personal";
const envPrefix = isDefault ? "GOOGLE_OAUTH_" : `GOOGLE_OAUTH_${account.toUpperCase()}_`;

const clientId = process.env[`${envPrefix}CLIENT_ID`] || "";
const clientSecret = process.env[`${envPrefix}CLIENT_SECRET`] || "";

if (!clientId || !clientSecret) {
  console.error(
    `\nMissing credentials for account '${account}'.\n` +
    `Set these environment variables before running:\n` +
    `  ${envPrefix}CLIENT_ID\n` +
    `  ${envPrefix}CLIENT_SECRET\n`
  );
  process.exit(1);
}

const PORT = 9876;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// ── Build consent URL ─────────────────────────────────────────────────────────
const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent"); // always return refresh_token

// ── Open browser ──────────────────────────────────────────────────────────────
const opener =
  process.platform === "darwin" ? "open" :
  process.platform === "win32"  ? "start" :
  "xdg-open";

console.log(`\nObtaining refresh token for Google account: '${account}'\n`);
console.log(`If the browser does not open, visit:\n${authUrl.toString()}\n`);
exec(`${opener} "${authUrl.toString()}"`, () => {});

// ── Local callback server ─────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404); res.end(); return;
  }

  const code  = url.searchParams.get("code")  || "";
  const error = url.searchParams.get("error") || "";

  if (error || !code) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(`OAuth error: ${error || "missing authorization code"}`);
    server.close();
    console.error(`\nOAuth error: ${error || "missing authorization code"}`);
    process.exit(1);
    return;
  }

  // Exchange code for tokens
  let tokenJson;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  REDIRECT_URI,
        grant_type:    "authorization_code",
      }).toString(),
    });
    tokenJson = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tokenJson));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Token exchange failed: ${err.message}`);
    server.close();
    console.error(`\nToken exchange failed: ${err.message}`);
    process.exit(1);
    return;
  }

  if (!tokenJson.refresh_token) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("No refresh_token in response. Try revoking access and re-running.");
    server.close();
    console.error(
      "\nGoogle did not return a refresh_token. This can happen if the account\n" +
      "already has a valid token. Revoke access at:\n" +
      "  https://myaccount.google.com/permissions\n" +
      "Then re-run this script."
    );
    process.exit(1);
    return;
  }

  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><h2>Auth successful — you can close this tab.</h2></body></html>");
  server.close();

  const secretName = isDefault
    ? "GOOGLE_OAUTH_REFRESH_TOKEN"
    : `GOOGLE_OAUTH_${account.toUpperCase()}_REFRESH_TOKEN`;

  console.log(`\nSuccess! Store the refresh token with:\n`);
  console.log(`  wrangler secret put ${secretName}`);
  console.log(`\nWhen prompted, paste:\n`);
  console.log(tokenJson.refresh_token);
  console.log();
  process.exit(0);
});

server.listen(PORT, "localhost", () => {
  console.log(`Waiting for OAuth callback on http://localhost:${PORT}/callback ...\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Stop the other process and retry.`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});
