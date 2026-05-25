import { google } from 'googleapis';
import forge from 'node-forge';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'withdrawal';
const DEPOSITS_SHEET_NAME = 'payments';

async function getAccessToken(): Promise<string> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');

  const key = JSON.parse(keyJson);
  const privateKeyPem = (key.private_key as string).replace(/\\n/g, '\n');
  const clientEmail = key.client_email as string;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const md = forge.md.sha256.create();
  md.update(signingInput, 'utf8');
  const signature = Buffer.from(privateKey.sign(md), 'binary').toString('base64url');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function getSheetsClient() {
  const accessToken = await getAccessToken();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.sheets({ version: 'v4', auth });
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
    const sheets = await getSheetsClient();

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

export async function appendDepositRow(data: {
  id: string;
  userName: string;
  userPhone: string;
  amount: number;
  txnHash: string;
  methodType: string;
  status: string;
  createdAt: Date;
}) {
  if (!SHEET_ID) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping deposit sheet append');
    return;
  }

  try {
    const sheets = await getSheetsClient();

    const row = [
      data.id,
      data.userName,
      data.userPhone,
      `₹${data.amount}`,
      data.txnHash,
      data.methodType.toUpperCase(),
      data.status,
      data.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      '',
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${DEPOSITS_SHEET_NAME}!A:I`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });

    console.log(`[Sheets] Appended deposit ${data.id}`);
  } catch (err) {
    console.error('[Sheets] Failed to append deposit row:', err);
  }
}

export async function updateDepositStatus(
  id: string,
  status: string,
  verifiedAt: Date
) {
  if (!SHEET_ID) return;

  try {
    const sheets = await getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${DEPOSITS_SHEET_NAME}!A:A`,
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
            range: `${DEPOSITS_SHEET_NAME}!G${sheetRow}:I${sheetRow}`,
            values: [
              [
                status,
                '',
                verifiedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
              ],
            ],
          },
        ],
      },
    });
  } catch (err) {
    console.error('[Sheets] Failed to update deposit row:', err);
  }
}

const KYC_SHEET_NAME = 'kyc';

export async function appendKycRow(data: {
  userId: string;
  name: string;
  phone: string;
  action: string;
  createdAt: Date;
}) {
  if (!SHEET_ID) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping KYC sheet append');
    return;
  }

  try {
    const sheets = await getSheetsClient();

    const row = [
      data.userId,
      data.name,
      data.phone,
      data.action,
      data.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${KYC_SHEET_NAME}!A:E`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });

    console.log(`[Sheets] Appended KYC ${data.action} for user ${data.userId}`);
  } catch (err) {
    console.error('[Sheets] Failed to append KYC row:', err);
  }
}

export async function updateWithdrawalStatus(
  id: string,
  status: string,
  completedAt: Date
) {
  if (!SHEET_ID) return;

  try {
    const sheets = await getSheetsClient();

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
