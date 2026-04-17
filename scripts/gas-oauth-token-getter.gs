/**
 * Google Apps Script OAuth Token Getter
 *
 * Deploy as a web app to get refresh tokens for Google OAuth.
 * Works from any browser (including at work).
 *
 * Setup:
 * 1. Go to script.google.com
 * 2. Create a new project
 * 3. Paste this entire code
 * 4. Save and deploy as web app (Execute as: your account, Who has access: Anyone)
 * 5. Visit the deployment URL in your browser
 * 6. Enter your Client ID, Client Secret, and desired account name
 * 7. Authorize and get your refresh token
 */

// Scopes needed for chief-of-staff
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar",
].join(" ");

const REDIRECT_URI = "https://script.google.com/macros/d/{DEPLOYMENT_ID}/usercallback";

/**
 * doGet - Renders the OAuth token getter UI
 */
function doGet(e) {
  // Handle OAuth callback
  if (e.parameter.code) {
    return handleCallback(e.parameter.code, e.parameter.state);
  }

  // Render the form
  return HtmlService.createHtmlOutput(getHtmlForm());
}

/**
 * doPost - Handles form submission to generate auth URL
 */
function doPost(e) {
  const clientId = e.parameter.clientId || "";
  const clientSecret = e.parameter.clientSecret || "";
  const account = e.parameter.account || "personal";

  if (!clientId || !clientSecret) {
    return HtmlService.createHtmlOutput(
      "<p style='color:red'>Error: Client ID and Secret are required</p><br>" +
      '<a href="javascript:history.back()">Back</a>'
    );
  }

  // Store credentials temporarily in cache
  const cache = CacheService.getScriptCache();
  const state = Utilities.getUuid();
  cache.put(state, JSON.stringify({ clientId, clientSecret, account }), 3600);

  // Build auth URL
  const deploymentUrl = ScriptApp.getService().getUrl();
  const redirectUri = deploymentUrl + "?redirect=true";

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", state);

  return HtmlService.createHtmlOutput(
    `<p>Opening Google consent page...</p>
     <p><a href="${authUrl}" target="_blank">Click here if not redirected automatically</a></p>
     <script>
       window.location.href = "${authUrl}";
     </script>`
  );
}

/**
 * handleCallback - Exchanges auth code for refresh token
 */
function handleCallback(code, state) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(state);

  if (!cached) {
    return HtmlService.createHtmlOutput(
      "<p style='color:red'>Error: State mismatch or expired. Please try again.</p>"
    );
  }

  const { clientId, clientSecret, account } = JSON.parse(cached);
  cache.remove(state);

  const deploymentUrl = ScriptApp.getService().getUrl();
  const redirectUri = deploymentUrl + "?redirect=true";

  // Exchange code for tokens
  try {
    const response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
      method: "post",
      payload: {
        code: code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      },
      muteHttpExceptions: true,
    });

    const result = JSON.parse(response.getContentText());

    if (!response.getResponseCode() === 200 || !result.refresh_token) {
      return HtmlService.createHtmlOutput(
        `<p style='color:red'>Error: ${result.error_description || "Failed to get refresh token"}</p>
         <p>Make sure:</p>
         <ul>
           <li>Client ID and Secret are correct</li>
           <li>The redirect URI in Google Cloud Console matches</li>
           <li>You haven't already authorized this app (revoke at https://myaccount.google.com/permissions)</li>
         </ul>
         <a href="javascript:history.back()">Try again</a>`
      );
    }

    // Display the refresh token
    const secretName =
      account === "personal"
        ? "GOOGLE_OAUTH_REFRESH_TOKEN"
        : `GOOGLE_OAUTH_${account.toUpperCase()}_REFRESH_TOKEN`;

    return HtmlService.createHtmlOutput(`
      <h2>✅ Success!</h2>
      <p><strong>Account:</strong> ${account}</p>
      <p><strong>Refresh Token:</strong></p>
      <textarea readonly style="width:100%;height:150px;font-family:monospace">${result.refresh_token}</textarea>
      <h3>Next steps:</h3>
      <ol>
        <li>Copy the refresh token above</li>
        <li>Run: <code>wrangler secret put ${secretName}</code></li>
        <li>Paste the token when prompted</li>
        <li>Deploy: <code>wrangler deploy</code></li>
      </ol>
      <p><a href="${ScriptApp.getService().getUrl()}">Get another token</a></p>
    `);
  } catch (err) {
    return HtmlService.createHtmlOutput(
      `<p style='color:red'>Error: ${err.toString()}</p>
       <a href="javascript:history.back()">Back</a>`
    );
  }
}

/**
 * getHtmlForm - Returns the input form HTML
 */
function getHtmlForm() {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
          }
          .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
          }
          h1 {
            color: #1f2937;
            margin-top: 0;
          }
          .form-group {
            margin-bottom: 20px;
          }
          label {
            display: block;
            margin-bottom: 8px;
            font-weight: 500;
            color: #374151;
          }
          input {
            width: 100%;
            padding: 10px;
            border: 1px solid #d1d5db;
            border-radius: 4px;
            font-size: 14px;
            box-sizing: border-box;
          }
          input:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
          }
          button {
            background: #3b82f6;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          }
          button:hover {
            background: #2563eb;
          }
          .help {
            background: #f0f9ff;
            padding: 15px;
            border-radius: 4px;
            margin-top: 20px;
            font-size: 13px;
            color: #0c4a6e;
            line-height: 1.6;
          }
          a {
            color: #3b82f6;
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🔐 Google OAuth Token Getter</h1>
          <form onsubmit="submitForm(event)">
            <div class="form-group">
              <label for="clientId">Client ID *</label>
              <input type="text" id="clientId" name="clientId" required
                     placeholder="From Google Cloud Console">
            </div>
            <div class="form-group">
              <label for="clientSecret">Client Secret *</label>
              <input type="password" id="clientSecret" name="clientSecret" required
                     placeholder="From Google Cloud Console">
            </div>
            <div class="form-group">
              <label for="account">Account Name</label>
              <input type="text" id="account" name="account" value="personal"
                     placeholder="personal (or your work account name)">
            </div>
            <button type="submit">Get Refresh Token</button>
          </form>

          <div class="help">
            <strong>Don't have Client ID & Secret?</strong>
            <ol>
              <li>Go to <a href="https://console.cloud.google.com" target="_blank">Google Cloud Console</a></li>
              <li>Create a new project or select existing one</li>
              <li>Go to Credentials → Create Credential → OAuth 2.0 Client ID (Desktop app)</li>
              <li>Copy the Client ID and Client Secret</li>
              <li>Paste them above</li>
            </ol>
          </div>
        </div>

        <script>
          function submitForm(event) {
            event.preventDefault();
            const form = event.target;
            google.script.run.processForm(form);
          }
        </script>
      </body>
    </html>
  `;
}
