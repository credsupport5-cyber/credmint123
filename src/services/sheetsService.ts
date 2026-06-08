import { google } from 'googleapis';
import forge from 'node-forge';

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'withdrawal';
const DEPOSITS_SHEET_NAME = 'payments';
const KYC_SHEET_NAME = 'kyc';

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

function fmtIST(d: Date) {
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// ─── Withdrawal ───────────────────────────────────────────────────────────────

type WithdrawalRowData = {
  id: string;
  userName: string;
  userPhone: string;
  amount: number;
  accountNumber: string;
  ifsc: string;
  accountName: string;
  status: string;
  createdAt: Date;
};

function buildWithdrawalRow(data: WithdrawalRowData): string[] {
  return [
    data.id,
    data.userName,
    data.userPhone,
    `₹${data.amount}`,
    data.accountNumber,
    data.ifsc,
    data.accountName,
    data.status,
    fmtIST(data.createdAt),
    '',
  ];
}

export async function appendWithdrawalRow(data: WithdrawalRowData) {
  if (!SHEET_ID) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping sheet append');
    return;
  }
  try {
    const sheets = await getSheetsClient();
    // Anchor at A1 to avoid stray-cell mis-detection of the table origin
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [buildWithdrawalRow(data)] },
    });
    console.log(`[Sheets] Appended withdrawal ${data.id} (${data.status})`);
  } catch (err) {
    console.error('[Sheets] Failed to append withdrawal row:', err);
  }
}

export async function updateWithdrawalStatus(
  id: string,
  status: string,
  completedAt: Date,
  rowData?: Omit<WithdrawalRowData, 'id' | 'status' | 'createdAt'>
) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();

    // Update in-place on the original PENDING row
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:A`,
    });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((r) => r[0] === id);
    if (rowIndex !== -1) {
      const sheetRow = rowIndex + 1;
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [{
            range: `${SHEET_NAME}!H${sheetRow}:J${sheetRow}`,
            values: [[status, '', fmtIST(completedAt)]],
          }],
        },
      });
    }

    // Append a second row for the approval/completion event
    if (rowData) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [buildWithdrawalRow({ id, ...rowData, status, createdAt: completedAt })],
        },
      });
    }
  } catch (err) {
    console.error('[Sheets] Failed to update withdrawal row:', err);
  }
}

// ─── Deposits ─────────────────────────────────────────────────────────────────

type DepositRowData = {
  id: string;
  userName: string;
  userPhone: string;
  amount: number;
  txnHash: string;
  methodType: string;
  status: string;
  createdAt: Date;
};

function buildDepositRow(data: DepositRowData): string[] {
  return [
    data.id,
    data.userName,
    data.userPhone,
    `₹${data.amount}`,
    data.txnHash,
    data.methodType.toUpperCase(),
    data.status,
    fmtIST(data.createdAt),
    '',
  ];
}

export async function appendDepositRow(data: DepositRowData) {
  if (!SHEET_ID) {
    console.warn('[Sheets] GOOGLE_SHEET_ID not set — skipping deposit sheet append');
    return;
  }
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${DEPOSITS_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [buildDepositRow(data)] },
    });
    console.log(`[Sheets] Appended deposit ${data.id} (${data.status})`);
  } catch (err) {
    console.error('[Sheets] Failed to append deposit row:', err);
  }
}

export async function updateDepositStatus(
  id: string,
  status: string,
  verifiedAt: Date,
  rowData?: Omit<DepositRowData, 'id' | 'status' | 'createdAt'>
) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();

    // Update in-place on the original PENDING row
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${DEPOSITS_SHEET_NAME}!A:A`,
    });
    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((r) => r[0] === id);
    if (rowIndex !== -1) {
      // Update existing PENDING row in place — one row per request, no duplicates
      const sheetRow = rowIndex + 1;
      const amountCell = rowData ? `₹${rowData.amount}` : undefined;
      const data: { range: string; values: string[][] }[] = [
        {
          range: `${DEPOSITS_SHEET_NAME}!G${sheetRow}:I${sheetRow}`,
          values: [[status, '', fmtIST(verifiedAt)]],
        },
      ];
      // Refresh credited amount (USDT→INR resolves only at approval)
      if (amountCell) {
        data.push({ range: `${DEPOSITS_SHEET_NAME}!D${sheetRow}`, values: [[amountCell]] });
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data },
      });
    } else if (rowData) {
      // Original row missing (e.g. sheet trimmed) — append a single resolved row as fallback
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${DEPOSITS_SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [buildDepositRow({ id, ...rowData, status, createdAt: verifiedAt })],
        },
      });
    }
  } catch (err) {
    console.error('[Sheets] Failed to update deposit row:', err);
  }
}

// ─── KYC ──────────────────────────────────────────────────────────────────────

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
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${KYC_SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[data.userId, data.name, data.phone, data.action, fmtIST(data.createdAt)]],
      },
    });
    console.log(`[Sheets] Appended KYC ${data.action} for user ${data.userId}`);
  } catch (err) {
    console.error('[Sheets] Failed to append KYC row:', err);
  }
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

export async function backfillWithdrawalSheet(
  withdrawals: Array<WithdrawalRowData & { completedAt?: Date | null }>
) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();

    // Clear data below header row
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2:Z`,
    });

    const rows: string[][] = [];
    for (const w of withdrawals) {
      rows.push(buildWithdrawalRow({ ...w, status: 'PENDING', createdAt: w.createdAt }));
      if (w.status !== 'PENDING' && w.completedAt) {
        rows.push(buildWithdrawalRow({ ...w, createdAt: w.completedAt }));
      }
    }

    if (rows.length === 0) return;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    console.log(`[Sheets] Backfilled ${rows.length} withdrawal rows`);
  } catch (err) {
    console.error('[Sheets] Backfill withdrawal failed:', err);
    throw err;
  }
}

export async function backfillDepositSheet(
  deposits: Array<DepositRowData & { verifiedAt?: Date | null }>
) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${DEPOSITS_SHEET_NAME}!A2:Z`,
    });

    // One row per deposit. Status column reflects final state; verifiedAt
    // written to col I for resolved rows (matches updateDepositStatus layout).
    const rows: string[][] = deposits.map((d) => {
      const row = buildDepositRow({ ...d, createdAt: d.createdAt });
      if (d.status !== 'PENDING' && d.verifiedAt) {
        row[8] = fmtIST(d.verifiedAt); // col I
      }
      return row;
    });

    if (rows.length === 0) return;

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${DEPOSITS_SHEET_NAME}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: rows },
    });

    console.log(`[Sheets] Backfilled ${rows.length} deposit rows`);
  } catch (err) {
    console.error('[Sheets] Backfill deposit failed:', err);
    throw err;
  }
}
