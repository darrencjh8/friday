/**
 * Monthly Actual Budget backup to OneDrive. Each budget named in
 * ACTUAL_PRIMARY_BUDGET_FILE / ACTUAL_SECONDARY_BUDGET_FILE is exported by
 * actual-api (Actual's own export zip) and uploaded to OneDrive
 * /Backups/Actual/<budget> <YYYY-MM-DD>.zip, the file "Import Actual" restores.
 */
import { uploadBackup } from "./onedrive.js";

export async function backupActual({
    budgets = [process.env.ACTUAL_PRIMARY_BUDGET_FILE, process.env.ACTUAL_SECONDARY_BUDGET_FILE].filter(Boolean),
    actualApiUrl = process.env.ACTUAL_API_URL || "http://actual-api:3000",
    upload = uploadBackup,
    date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" }),
} = {}) {
    if (!budgets.length) throw new Error("No budget configured to back up");
    const files = [];
    for (const budget of budgets) {
        const resp = await fetch(`${actualApiUrl}/export?budget_id=${encodeURIComponent(budget)}`, {
            signal: AbortSignal.timeout(300000),
        });
        if (!resp.ok) throw new Error(`Export ${budget} failed: HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        files.push({ name: await upload("Actual", `${budget} ${date}.zip`, bytes), bytes: bytes.length });
    }
    return { files };
}

export function mountBackupRoute(app, backup = backupActual) {
    app.post("/backup/actual", async (_req, res) => {
        try {
            res.json(await backup());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}
