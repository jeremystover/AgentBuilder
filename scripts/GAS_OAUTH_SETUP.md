# Google Apps Script OAuth Token Getter

A web app to securely get Google OAuth refresh tokens from any browser (including at work).

## Setup (One-time)

### 1. Create a GAS Project
- Go to [script.google.com](https://script.google.com)
- Click **+ New project**
- Name it something like "OAuth Token Getter"

### 2. Paste the Code
- Delete the default `myFunction()` code
- Copy all code from `gas-oauth-token-getter.gs`
- Paste it into the script editor
- Click **Save**

### 3. Deploy as Web App
- Click **Deploy** → **New deployment**
- Select type: **Web app**
- Execute as: **Your account**
- Who has access: **Anyone**
- Click **Deploy**
- Copy the **Deployment URL** (you'll need this)

### 4. (Optional) Update Redirect URI
The script auto-generates the redirect URI. If you want to verify it's correct:
- In Google Cloud Console, go to your OAuth app credentials
- Under "Authorized redirect URIs", add the deployment URL + `?redirect=true`
- Example: `https://script.google.com/macros/d/YOUR_DEPLOYMENT_ID/usercallback?redirect=true`

## Usage

### Get a Personal Account Token

1. Go to your deployment URL in your browser
2. Enter your **Client ID** and **Client Secret** (from Google Cloud Console)
3. Leave Account as `personal`
4. Click **Get Refresh Token**
5. Authorize with your Google account
6. Copy the refresh token
7. Run:
   ```bash
   wrangler secret put GOOGLE_OAUTH_REFRESH_TOKEN
   # Paste the token
   ```

### Get a Work Account Token (e.g., "work" or "gong")

1. Go to your deployment URL
2. Enter your **Client ID** and **Client Secret** (for your work OAuth app)
3. Enter Account name: `work` (or whatever you want to call it)
4. Click **Get Refresh Token**
5. Authorize with your work Google account
6. Copy the refresh token
7. Run:
   ```bash
   wrangler secret put GOOGLE_OAUTH_WORK_REFRESH_TOKEN
   # Paste the token
   ```

## How It Works

1. **You enter credentials** - GAS stores them temporarily in cache (1 hour)
2. **GAS generates auth URL** - Opens Google's consent screen
3. **You authorize** - Google redirects back to the GAS web app with auth code
4. **GAS exchanges code for tokens** - Server-side, so credentials never leave Google's network
5. **Display refresh token** - You copy it and store via `wrangler secret put`

## Security Notes

✅ **Safe to use at work because:**
- Google handles the OAuth flow (not a third party)
- Credentials are never exposed to the browser (server-side exchange)
- Temporary cache expires after 1 hour
- You deploy and control the GAS script

## Troubleshooting

**"Error: State mismatch or expired"**
- The page took too long. Just go back and try again.

**"Error: Failed to get refresh token"**
- Client ID or Secret is wrong
- You already authorized this app — revoke at https://myaccount.google.com/permissions and try again
- Redirect URI mismatch (verify in Google Cloud Console)

**Need to get another token?**
- Just visit the deployment URL again — it's reusable

## When to Re-use This

- Whenever you need a new refresh token (e.g., for a new account)
- If you see `invalid_grant` errors (revoke access and get a fresh token)
- Keep the URL bookmarked for future use
