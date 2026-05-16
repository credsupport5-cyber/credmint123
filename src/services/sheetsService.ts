import { google } from 'googleapis';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Withdrawals';

function getAuthClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');

  const key = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

export async function appendWithdrawalRow(data: {
  id: string;
  userName: string;
  userPhone: string;
  amount: number;
  accountNumber: string;
  ifsc: string;
  accountName: string;
  status: string;
  createdAt: Date;
}) {
  if (!SHEET_ID) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping sheet append');
    return;
  }

  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const row = [
      data.id,
      data.userName,
      data.userPhone,
      `₹${data.amount}`,
      data.accountNumber,
      data.ifsc,
      data.accountName,
      data.status,
      data.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:J`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });

    console.log(`[Sheets] Appended withdrawal ${data.id}`);
  } catch (err) {
    console.error('[Sheets] Failed to append row:', err);
  }
}

export async function updateWithdrawalStatus(
  id: string,
  status: string,
  completedAt: Date
) {
  if (!SHEET_ID) return;

  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:A`,
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((r) => r[0] === id);
    if (rowIndex === -1) return;

    const sheetRow = rowIndex + 1;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          {
            range: `${SHEET_NAME}!H${sheetRow}:J${sheetRow}`,
            values: [
              [
                status,
                '',
                completedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
              ],
            ],
          },
        ],
      },
    });
  } catch (err) {
    console.error('[Sheets] Failed to update row:', err);
  }
}
