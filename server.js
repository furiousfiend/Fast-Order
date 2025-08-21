import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import OAuthClient from 'intuit-oauth';
import QuickBooks from 'node-quickbooks';
import fetch from 'node-fetch'; // new: used to call QuickBooks API

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---- Token store (demo only; in memory) ----
let tokens = null;
let realmId = process.env.QB_REALM_ID || null;

const envSetting = (process.env.QB_ENVIRONMENT || 'sandbox').toLowerCase();
const useSandbox = envSetting !== 'production'; // sandbox by default

// new: base URL for QuickBooks Online queries
const QBO_BASE = process.env.QBO_BASE || 'https://sandbox-quickbooks.api.intuit.com';

const oauthClient = new OAuthClient({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: envSetting, // 'sandbox' or 'production'
  redirectUri: process.env.QB_REDIRECT_URI
});

function getQB() {
  if (!tokens || !realmId) {
    throw new Error('Not connected to QuickBooks yet. Visit /auth/connect first.');
  }
  // node-quickbooks args (OAuth2):
  return new QuickBooks(
    process.env.QB_CLIENT_ID,
    process.env.QB_CLIENT_SECRET,
    tokens.access_token,
    false,
    realmId,
    useSandbox,
    true,
    null,
    '2.0',
    tokens.refresh_token
  );
}

// --- OAuth start
app.get('/auth/connect', (req, res) => {
  const url = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: 'fast-order'
  });
  res.redirect(url);
});

// --- OAuth callback
app.get('/auth/callback', async (req, res) => {
  try {
    const authResponse = await oauthClient.createToken(req.url);
    tokens = authResponse.getJson();
    realmId = req.query.realmId || realmId;
    res.send(`<h3>Connected to QuickBooks ✅</h3>
      <p>Realm ID: ${realmId || '(missing)'}</p>
      <p><a href="/">Go to the order form</a></p>`);
  } catch (e) {
    res.status(500).send('OAuth error: ' + e.message);
  }
});

// --- Search Items (autocomplete) — searches by Name or Sku
app.get('/api/items', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const term = q.replace(/'/g, "''"); // escape single quotes for SQL
    let sql = `
      SELECT Id, Name, Sku, Type, UnitPrice, QtyOnHand
      FROM Item
      WHERE Active = true
    `;
    if (term) {
      sql += ` AND (Name LIKE '%${term}%' OR Sku LIKE '%${term}%')`;
    }
    sql += ` STARTPOSITION 1 MAXRESULTS 25`;

    const url = `${QBO_BASE}/v3/company/${realmId}/query?minorversion=73`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/text',
        Accept: 'application/json'
      },
      body: sql
    });
    const data = await response.json();
    const items = (data?.QueryResponse?.Item || []).map(it => ({
      id: it.Id,
      name: it.Name,
      sku: it.Sku,
      unitPrice: it.UnitPrice,
      type: it.Type,
      qtyOnHand: typeof it.QtyOnHand === 'number' ? it.QtyOnHand : null
    }));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Search Customers (autocomplete) — searches DisplayName, CompanyName and PrimaryEmailAddr
app.get('/api/customers', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const term = q.replace(/'/g, "''");
    let sql = `
      SELECT Id, DisplayName, CompanyName, PrimaryEmailAddr
      FROM Customer
      WHERE Active = true
    `;
    if (term) {
      sql += ` AND (DisplayName LIKE '%${term}%' OR CompanyName LIKE '%${term}%' OR PrimaryEmailAddr LIKE '%${term}%')`;
    }
    sql += ` STARTPOSITION 1 MAXRESULTS 25`;

    const url = `${QBO_BASE}/v3/company/${realmId}/query?minorversion=73`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/text',
        Accept: 'application/json'
      },
      body: sql
    });
    const data = await response.json();
    const customers = (data?.QueryResponse?.Customer || []).map(c => ({
      id: c.Id,
      name: c.DisplayName || c.CompanyName || '',
      email: c.PrimaryEmailAddr?.Address || null
    }));
    res.json({ customers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Create UNSENT invoice (draft-like)
app.post('/api/invoice', (req, res) => {
  try {
    const { customerId, notes, agentName, lines } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines required' });

    const cleanLines = lines.map(l => {
      const qty = Math.max(1, Math.floor(Number(l.qty || 1)));
      const price = Number(l.unitPrice || 0);
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: price * qty,
        Description: l.description || '',
        SalesItemLineDetail: {
          ItemRef: { value: String(l.itemId) },
          Qty: qty,
          UnitPrice: price
        }
      };
    });

    const qb = getQB();
    const invoice = {
      CustomerRef: { value: String(customerId) },
      PrivateNote: `${agentName ? `Agent: ${agentName} — ` : ''}${notes || ''}`.trim(),
      Line: cleanLines,
      EmailStatus: 'NotSet'
    };
    if (agentName) {
      invoice.CustomField = [
        { DefinitionId: '1', Name: 'Agent', Type: 'StringType', StringValue: agentName }
      ];
    }
    qb.createInvoice(invoice, (err, created) => {
      if (err) return res.status(500).json({ error: 'Failed to create invoice', details: err.Fault || err });
      res.json({ ok: true, invoice: { Id: created.Id, DocNumber: created.DocNumber, TotalAmt: created.TotalAmt } });
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Create Estimate (alternative draft)
app.post('/api/estimate', (req, res) => {
  try {
    const { customerId, notes, agentName, lines } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'lines required' });

    const cleanLines = lines.map(l => {
      const qty = Math.max(1, Math.floor(Number(l.qty || 1)));
      const price = Number(l.unitPrice || 0);
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: price * qty,
        Description: l.description || '',
        SalesItemLineDetail: {
          ItemRef: { value: String(l.itemId) },
          Qty: qty,
          UnitPrice: price
        }
      };
    });

    const qb = getQB();
    const estimate = {
      CustomerRef: { value: String(customerId) },
      PrivateNote: `${agentName ? `Agent: ${agentName} — ` : ''}${notes || ''}`.trim(),
      Line: cleanLines
    };
    if (agentName) {
      estimate.CustomField = [
        { DefinitionId: '1', Name: 'Agent', Type: 'StringType', StringValue: agentName }
      ];
    }
    qb.createEstimate(estimate, (err, created) => {
      if (err) return res.status(500).json({ error: 'Failed to create estimate', details: err.Fault || err });
      res.json({ ok: true, estimate: { Id: created.Id, DocNumber: created.DocNumber, TotalAmt: created.TotalAmt } });
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Serve the UI
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`QuickBooks order prototype → http://localhost:${PORT}`));
