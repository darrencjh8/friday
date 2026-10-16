/**
 * OneDrive OAuth helpers for interactive authorization flow.
 *
 * The existing src/onedrive.js handles token refresh + file operations.
 * This module adds the one-time OAuth setup path (code → refresh_token)
 * that replaces the manual authorize.sh flow.
 */

import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const REDIRECT_URI =
    "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPE =
    "Files.ReadWrite Files.ReadWrite.All Sites.ReadWrite.All offline_access";

/**
 * Build the Microsoft OAuth authorization URL.
 * User visits this URL in a browser, logs in, and copies the redirect URL.
 */
export function getAuthUrl() {
    const clientId = process.env.ONEDRIVE_CLIENT_ID;
    if (!clientId) {
        throw new Error("ONEDRIVE_CLIENT_ID environment variable is not set");
    }
    const params = new URLSearchParams({
        client_id: clientId,
        scope: SCOPE,
        response_type: "code",
        prompt: "login",
        redirect_uri: REDIRECT_URI,
    });
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

/**
 * Exchange the authorization code from the redirect URL for a refresh token.
 * Saves the refresh token to disk for future headless use.
 *
 * @param {string} redirectUri - The full redirect URL from the browser address bar
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function exchangeCodeForToken(redirectUri) {
    const url = new URL(redirectUri);
    const code = url.searchParams.get("code");
    if (!code) {
        throw new Error(
            "No authorization code found in redirect URI. Expected ?code=... in the URL.",
        );
    }

    const clientId = process.env.ONEDRIVE_CLIENT_ID;
    if (!clientId) {
        throw new Error("ONEDRIVE_CLIENT_ID environment variable is not set");
    }

    const body = new URLSearchParams({
        client_id: clientId,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
    });

    const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(
            `Token exchange failed: HTTP ${resp.status}: ${err.slice(0, 200)}`,
        );
    }

    const data = await resp.json();
    if (!data.refresh_token) {
        throw new Error(
            "No refresh_token in response. The authorization code may have expired or been used already.",
        );
    }

    const tokenPath =
        process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
        "/app/config/onedrive/refresh_token";
    const dir = dirname(tokenPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath, data.refresh_token);

    return { success: true };
}
