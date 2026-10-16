/**
 * OneDrive sync via Microsoft Graph API with OAuth2 refresh tokens.
 * Ported 1:1 from src/onedrive_download.py and src/onedrive_upload.py
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const REDIRECT_URI =
    "https://login.microsoftonline.com/common/oauth2/nativeclient";

/**
 * Get an access token using the refresh token from disk.
 * Retries up to 3 times with backoff.
 */
async function getAccessToken() {
    const refreshTokenPath =
        process.env.ONEDRIVE_REFRESH_TOKEN_PATH ||
        "/app/config/onedrive/refresh_token";
    const clientId = process.env.ONEDRIVE_CLIENT_ID;

    if (!existsSync(refreshTokenPath)) {
        throw new Error(
            `OneDrive refresh token not found at ${refreshTokenPath}`,
        );
    }
    const refreshToken = readFileSync(refreshTokenPath, "utf8").trim();

    const body = new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        redirect_uri: REDIRECT_URI,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const resp = await fetch(TOKEN_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: body.toString(),
                signal: AbortSignal.timeout(15000),
            });
            if (!resp.ok) throw new Error(`Token HTTP ${resp.status}`);
            const data = await resp.json();
            return data.access_token;
        } catch (e) {
            if (attempt < 2) await sleep(2000 * (attempt + 1));
            else throw e;
        }
    }
}

/**
 * Download latest Portfolio.portfolio from OneDrive.
 * @param {string} [localPath] - Local destination path
 * @returns {Promise<{success: boolean, data?: string, path?: string, error?: string}>}
 */
export async function pullFromOneDrive(localPath) {
    const ppXmlPath =
        localPath ||
        process.env.PP_XML_PATH ||
        "/data/onedrive/Portfolio/Portfolio.portfolio";

    try {
        const token = await getAccessToken();

        // Step 1: Resolve Portfolio shortcut/folder
        const itemResp = await fetch(
            "https://graph.microsoft.com/v1.0/me/drive/root:/Portfolio",
            {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
            },
        );
        if (!itemResp.ok)
            throw new Error(
                `Resolve Portfolio folder failed: HTTP ${itemResp.status}`,
            );
        const item = await itemResp.json();
        const remote = item.remoteItem;

        let downloadUrl;
        if (remote) {
            // Shared folder from another drive
            const driveId = remote.parentReference.driveId;
            const folderId = remote.id;
            const childrenUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}/children?select=name,@microsoft.graph.downloadUrl`;
            const childrenResp = await fetch(childrenUrl, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(30000),
            });
            if (!childrenResp.ok)
                throw new Error(
                    `List shared folder failed: HTTP ${childrenResp.status}`,
                );
            const children = await childrenResp.json();

            for (const child of children.value || []) {
                if (child.name === "Portfolio.portfolio") {
                    downloadUrl = child["@microsoft.graph.downloadUrl"];
                    break;
                }
            }
        } else {
            // Direct file in user's drive
            downloadUrl = item["@microsoft.graph.downloadUrl"];
        }

        if (!downloadUrl) {
            throw new Error("Portfolio.portfolio not found in shared folder");
        }

        // Step 2: Download via pre-signed URL (no auth needed)
        const dlResp = await fetch(downloadUrl, {
            signal: AbortSignal.timeout(60000),
        });
        if (!dlResp.ok)
            throw new Error(`Download failed: HTTP ${dlResp.status}`);

        const content = Buffer.from(await dlResp.arrayBuffer());

        // Ensure parent directory exists
        const { dirname } = await import("path");
        const { mkdirSync, existsSync: fsExists } = await import("fs");
        const dir = dirname(ppXmlPath);
        if (!fsExists(dir)) mkdirSync(dir, { recursive: true });

        writeFileSync(ppXmlPath, content);
        return { success: true, path: ppXmlPath };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Upload Portfolio.portfolio to OneDrive.
 * @param {string} localPath - Local file path to upload
 * @returns {Promise<{success: boolean, path?: string, error?: string}>}
 */
export async function pushToOneDrive(localPath) {
    if (!localPath) {
        localPath =
            process.env.PP_XML_PATH ||
            "/data/onedrive/Portfolio/Portfolio.portfolio";
    }

    try {
        const token = await getAccessToken();

        if (!existsSync(localPath)) {
            throw new Error(`Local file not found: ${localPath}`);
        }
        const content = readFileSync(localPath);
        const contentLength = content.length;

        // Resolve remote folder (handles shortcut/shared folders)
        const itemResp = await fetch(
            "https://graph.microsoft.com/v1.0/me/drive/root:/Portfolio",
            {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
            },
        );
        if (!itemResp.ok)
            throw new Error(
                `Resolve Portfolio folder failed: HTTP ${itemResp.status}`,
            );
        const item = await itemResp.json();
        const remote = item.remoteItem;

        let uploadUrl;
        if (remote) {
            const driveId = remote.parentReference.driveId;
            const folderId = remote.id;
            uploadUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${folderId}:/Portfolio.portfolio:/content`;
        } else {
            uploadUrl =
                "https://graph.microsoft.com/v1.0/me/drive/root:/Portfolio/Portfolio.portfolio:/content";
        }
        uploadUrl += "?@microsoft.graph.conflictBehavior=replace";

        const uploadResp = await fetch(uploadUrl, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "text/plain",
            },
            body: content,
            signal: AbortSignal.timeout(30000),
        });

        if (!uploadResp.ok) {
            const errText = await uploadResp.text();
            throw new Error(
                `Upload failed: HTTP ${uploadResp.status}: ${errText.slice(0, 200)}`,
            );
        }

        const result = await uploadResp.json();
        return { success: true, path: result.name || "Portfolio.portfolio" };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
