const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

// Disable TLS verification to resolve corporate/local firewall certificate blocks
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/akb_billing';

app.use(cors());
app.use(express.json());

// Optional modules for Telegram proxy (may be missing until `npm install` is run)
let multer, fetch, FormData, upload;
let HAS_UPLOAD_SUPPORT = true;
try {
  multer = require('multer');
  fetch = require('node-fetch');
  FormData = require('form-data');
  // Ensure tmp directory exists
  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  // Temp upload storage for incoming PDF from client
  upload = multer({ dest: tmpDir });
} catch (e) {
  HAS_UPLOAD_SUPPORT = false;
  console.warn('Optional upload dependencies missing. To enable Telegram PDF upload, run: npm install multer node-fetch@2 form-data');
}

// HTTPS agent with keepAlive disabled — prevents ECONNRESET on corporate firewalls
const tlsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: false
});

// Helper: fetch with retry and timeout
async function fetchWithRetry(url, options, retries = 3, timeoutMs = 20000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, agent: tlsAgent, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      const isRetryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'AbortError' || err.code === 'ECONNREFUSED';
      console.warn(`[Telegram] Attempt ${attempt}/${retries} failed: ${err.code || err.name} - ${err.message}`);
      if (attempt === retries || !isRetryable) throw err;
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

// Serve static frontend files from project root (so visiting / serves index.html)
app.use(express.static(path.join(__dirname)));

// Ensure root returns index.html for SPA clients
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Connect to MongoDB
mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Invoice schema (flexible to accept existing JSON shape)
const InvoiceSchema = new mongoose.Schema({}, { strict: false, id: false });
const Invoice = mongoose.model('Invoice', InvoiceSchema);

const ProductSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  hsn: { type: String },
  price: { type: Number, default: 0 }
}, { strict: false });
const Product = mongoose.model('Product', ProductSchema);

const ReceiverSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  address: { type: String },
  state: { type: String },
  gstin: { type: String },
  statecode: { type: String }
}, { strict: false });
const Receiver = mongoose.model('Receiver', ReceiverSchema);

const ConsigneeSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  address: { type: String },
  state: { type: String },
  gstin: { type: String },
  statecode: { type: String }
}, { strict: false });
const Consignee = mongoose.model('Consignee', ConsigneeSchema);

const SettingsSchema = new mongoose.Schema({
  nextInvoiceNo: { type: Number, default: 1 },
  inactivityTimeout: { type: Number, default: 300000 },
  telegram: {
    token: { type: String, default: '8799482746:AAGiDi8HEoV7KGQNyer4772H_d1qv9fznac' },
    chatId: { type: String, default: '6877857251' }
  },
  emailSettings: {
    defaultCC: { type: String, default: '' },
    subjectPrefix: { type: String, default: 'Tax Invoice' }
  }
}, { strict: false });
const Settings = mongoose.model('Settings', SettingsSchema);


// REST endpoints for invoices
// GET all invoices (newest first)
app.get('/api/invoices', async (req, res) => {
  try {
    const invoices = await Invoice.find().sort({ date: -1, invoiceNo: -1 });
    return res.json(invoices);
  } catch (err) {
    console.error('DB read failed, falling back to local file:', err && err.message);
    // Fallback to local data file if available
    try {
      const fpath = path.join(__dirname, 'data', 'invoices.json');
      if (fs.existsSync(fpath)) {
        const raw = fs.readFileSync(fpath, 'utf8');
        const parsed = JSON.parse(raw || '[]');
        return res.json(Array.isArray(parsed) ? parsed : []);
      }
    } catch (e) {
      console.error('Fallback read failed:', e && e.message);
    }
    // final fallback: empty array
    return res.json([]);
  }
});

// GET single invoice by id
app.get('/api/invoices/:id', async (req, res) => {
  try {
    const idParam = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(idParam) ? { _id: idParam } : { id: Number(idParam) };
    const inv = await Invoice.findOne(query);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    res.json(inv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// POST create
app.post('/api/invoices', async (req, res) => {
  try {
    const doc = new Invoice(req.body);
    await doc.save();
    res.json({ success: true, invoice: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save invoice' });
  }
});

// PUT update by id
app.put('/api/invoices/:id', async (req, res) => {
  try {
    const idParam = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(idParam) ? { _id: idParam } : { id: Number(idParam) };
    const updated = await Invoice.findOneAndUpdate(query, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ success: true, invoice: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// DELETE
app.delete('/api/invoices/:id', async (req, res) => {
  try {
    const idParam = req.params.id;
    const query = mongoose.Types.ObjectId.isValid(idParam) ? { _id: idParam } : { id: Number(idParam) };
    const result = await Invoice.deleteOne(query);
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// REST endpoints for products
// GET all products
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.find().sort({ name: 1 });
    return res.json(products);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET single product by id
app.get('/api/products/:id', async (req, res) => {
  try {
    const p = await Product.findOne({ id: Number(req.params.id) });
    if (!p) return res.status(404).json({ error: 'Product not found' });
    res.json(p);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// POST create product
app.post('/api/products', async (req, res) => {
  try {
    const doc = new Product(req.body);
    await doc.save();
    res.json({ success: true, product: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save product' });
  }
});

// PUT update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const updated = await Product.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// DELETE product
app.delete('/api/products/:id', async (req, res) => {
  try {
    const result = await Product.deleteOne({ id: Number(req.params.id) });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// REST endpoints for receivers
// GET all receivers
app.get('/api/receivers', async (req, res) => {
  try {
    const receivers = await Receiver.find().sort({ name: 1 });
    return res.json(receivers);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch receivers' });
  }
});

// POST create receiver
app.post('/api/receivers', async (req, res) => {
  try {
    const doc = new Receiver(req.body);
    await doc.save();
    res.json({ success: true, receiver: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save receiver' });
  }
});

// PUT update receiver
app.put('/api/receivers/:id', async (req, res) => {
  try {
    const updated = await Receiver.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Receiver not found' });
    res.json({ success: true, receiver: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update receiver' });
  }
});

// DELETE receiver
app.delete('/api/receivers/:id', async (req, res) => {
  try {
    const result = await Receiver.deleteOne({ id: Number(req.params.id) });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete receiver' });
  }
});

// REST endpoints for consignees
// GET all consignees
app.get('/api/consignees', async (req, res) => {
  try {
    const consignees = await Consignee.find().sort({ name: 1 });
    return res.json(consignees);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch consignees' });
  }
});

// POST create consignee
app.post('/api/consignees', async (req, res) => {
  try {
    const doc = new Consignee(req.body);
    await doc.save();
    res.json({ success: true, consignee: doc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save consignee' });
  }
});

// PUT update consignee
app.put('/api/consignees/:id', async (req, res) => {
  try {
    const updated = await Consignee.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    if (!updated) return res.status(404).json({ error: 'Consignee not found' });
    res.json({ success: true, consignee: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update consignee' });
  }
});

// DELETE consignee
app.delete('/api/consignees/:id', async (req, res) => {
  try {
    const result = await Consignee.deleteOne({ id: Number(req.params.id) });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete consignee' });
  }
});

// REST endpoints for settings
// GET settings (returns single global settings doc)
app.get('/api/settings', async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = new Settings({
        nextInvoiceNo: 1,
        inactivityTimeout: 300000,
        telegram: {
          token: '8799482746:AAGiDi8HEoV7KGQNyer4772H_d1qv9fznac',
          chatId: '6877857251'
        },
        emailSettings: {
          defaultCC: '',
          subjectPrefix: 'Tax Invoice'
        }
      });
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT settings
app.put('/api/settings', async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = new Settings({});
    }
    if (req.body.nextInvoiceNo !== undefined) settings.nextInvoiceNo = req.body.nextInvoiceNo;
    if (req.body.inactivityTimeout !== undefined) settings.inactivityTimeout = req.body.inactivityTimeout;
    
    if (req.body.telegram) {
      settings.telegram = {
        ...settings.telegram,
        ...req.body.telegram
      };
    }
    
    if (req.body.emailSettings) {
      settings.emailSettings = {
        ...settings.emailSettings,
        ...req.body.emailSettings
      };
    }
    
    settings.markModified('telegram');
    settings.markModified('emailSettings');
    
    await settings.save();
    res.json({ success: true, settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Try to listen on PORT, falling back to next ports if occupied
function tryListen(startPort, maxAttempts = 10) {
  const port = startPort;
  const server = app.listen(port);

  server.on('listening', () => {
    console.log(`Server listening on http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      server.close();
      const nextPort = port + 1;
      if (nextPort < startPort + maxAttempts) {
        console.warn(`Port ${port} in use, trying ${nextPort}...`);
        tryListen(nextPort, maxAttempts);
      } else {
        console.error(`All ports ${startPort}-${startPort + maxAttempts - 1} busy. Exiting.`);
        process.exit(1);
      }
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });
}

tryListen(PORT, 20);

// POST /api/sendTelegramDocument - used as a server-side proxy to upload PDFs to Telegram (avoids CORS and browser limitations)
// Expects form-data with fields: token, chatId and file (pdf)
app.post('/api/sendTelegramDocument', HAS_UPLOAD_SUPPORT ? upload.single('file') : (req,res)=>res.status(501).json({error:'Upload support not enabled. Run: npm install multer node-fetch@2 form-data'}), async (req, res) => {
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath) fs.unlink(filePath, () => {}); };
  try {
    console.log('/api/sendTelegramDocument called, hasFile=', !!req.file, 'bodyKeys=', Object.keys(req.body||{}));
    const token = req.body.token;
    const chatId = req.body.chatId;
    if (!token || !chatId) { cleanup(); return res.status(400).json({ error: 'Missing token or chatId' }); }
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

    const tgUrl = `https://api.telegram.org/bot${token}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath), { filename: req.file.originalname || 'invoice.pdf' });

    const tgRes = await fetchWithRetry(tgUrl, { method: 'POST', body: form });
    const json = await tgRes.json();
    console.log('Telegram sendDocument response:', json && (json.description || JSON.stringify(json).slice(0,200)));

    cleanup();

    if (!json) return res.status(500).json({ error: 'No response from Telegram' });
    if (!json.ok) return res.status(502).json({ error: 'Telegram error', detail: json });
    return res.json(json);
  } catch (err) {
    cleanup();
    console.error('sendTelegramDocument error details:', err);
    const isConnErr = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.name === 'AbortError';
    const hint = isConnErr
      ? 'Network error reaching Telegram. Check if api.telegram.org is reachable from this server (firewall/proxy may be blocking it).'
      : err.message;
    return res.status(500).json({ error: 'Server error', detail: hint, code: err.code });
  }
});

// POST /api/sendTelegramMessage - server proxy to send text messages to Telegram
app.post('/api/sendTelegramMessage', express.json(), async (req, res) => {
  if (!HAS_UPLOAD_SUPPORT) return res.status(501).json({ error: 'Telegram proxy not enabled. Run: npm install multer node-fetch@2 form-data' });
  try {
    console.log('/api/sendTelegramMessage called, bodyKeys=', Object.keys(req.body||{}));
    const token = req.body.token;
    const chatId = req.body.chatId;
    const text = req.body.text;
    if (!token || !chatId || !text) return res.status(400).json({ error: 'Missing fields' });

    const tgUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetchWithRetry(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
    const json = await r.json();
    console.log('Telegram sendMessage response:', json && (json.description || JSON.stringify(json).slice(0,200)));
    if (!json) return res.status(500).json({ error: 'No response from Telegram' });
    if (!json.ok) return res.status(502).json({ error: 'Telegram error', detail: json });
    return res.json(json);
  } catch (err) {
    console.error('sendTelegramMessage error details:', err);
    const isConnErr = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.name === 'AbortError';
    const hint = isConnErr
      ? 'Network error reaching Telegram. Check if api.telegram.org is reachable from this server (firewall/proxy may be blocking it).'
      : err.message;
    return res.status(500).json({ error: 'Server error', detail: hint, code: err.code });
  }
});