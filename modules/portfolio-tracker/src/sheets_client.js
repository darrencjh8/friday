/**
 * Google Sheets API client for portfolio taxonomy.
 * Ported 1:1 from src/gsheets/sheets_client.py
 */

import { google } from 'googleapis';

export class SheetsClient {
  constructor(serviceAccountJson, sheetId) {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(serviceAccountJson),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this._sheets = google.sheets({ version: 'v4', auth });
    this._sheetId = sheetId;
  }

  async readRange(range) {
    const res = await this._sheets.spreadsheets.values.get({
      spreadsheetId: this._sheetId,
      range,
    });
    return res.data.values || [];
  }

  async writeRange(range, values) {
    await this._sheets.spreadsheets.values.update({
      spreadsheetId: this._sheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }

  async appendRow(range, row) {
    await this._sheets.spreadsheets.values.append({
      spreadsheetId: this._sheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  }
}
