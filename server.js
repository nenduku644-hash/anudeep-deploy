require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const qrcode = require('qrcode');

// Disable TLS verification to resolve corporate/local firewall certificate blocks
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/akb_billing';

const zlib = require('zlib');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// High-speed response compression for payloads > 1KB
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (body && typeof body === 'object' && acceptEncoding.includes('gzip')) {
      const jsonString = JSON.stringify(body);
      if (jsonString.length > 1024) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'gzip');
        return zlib.gzip(jsonString, (err, compressed) => {
          if (err) return res.send(jsonString);
          res.send(compressed);
        });
      }
    }
    return origJson(body);
  };
  next();
});

// Serve static frontend files from project root
app.use(express.static(path.join(__dirname)));

// Set up tmp dir for file uploads
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}
const upload = multer({ dest: tmpDir });

// Optional modules for Telegram proxy
let fetch, FormData;
try {
  fetch = require('node-fetch');
  FormData = require('form-data');
} catch (e) {
  console.warn('node-fetch or form-data missing. Telegram upload may be limited.');
}

// HTTPS agent with keepAlive disabled — prevents ECONNRESET
const tlsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: false
});

// Helper: fetch with retry and timeout for Telegram
async function fetchWithRetry(url, options, retries = 3, timeoutMs = 20000) {
  if (!fetch) throw new Error('node-fetch is not available');
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
      if (attempt === retries || !isRetryable) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

// ==========================================
// 1. MONGODB CONNECTION & SCHEMAS
// ==========================================
let isDbConnected = false;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 3000,
  socketTimeoutMS: 30000,
  maxPoolSize: 50,
  minPoolSize: 5,
})
  .then(() => {
    isDbConnected = true;
    console.log('⚡ Connected to MongoDB with high-speed connection pool at', MONGO_URI);
  })
  .catch(err => {
    isDbConnected = false;
    console.warn('⚠️ MongoDB connection error (will use local JSON fallback):', err.message);
  });

mongoose.connection.on('disconnected', () => { isDbConnected = false; });
mongoose.connection.on('connected', () => { isDbConnected = true; });

// Schemas with high-performance compound indexes
const InvoiceSchema = new mongoose.Schema({}, { strict: false, id: false });
InvoiceSchema.index({ invoiceNo: -1 });
InvoiceSchema.index({ date: -1, invoiceNo: -1 });
InvoiceSchema.index({ id: 1 });
const Invoice = mongoose.model('Invoice', InvoiceSchema);

const ProductSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  hsn: { type: String },
  price: { type: Number, default: 0 }
}, { strict: false });
ProductSchema.index({ name: 1 });
const Product = mongoose.model('Product', ProductSchema);

const ReceiverSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  address: { type: String },
  state: { type: String },
  gstin: { type: String },
  statecode: { type: String }
}, { strict: false });
ReceiverSchema.index({ name: 1 });
const Receiver = mongoose.model('Receiver', ReceiverSchema);

const ConsigneeSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  address: { type: String },
  state: { type: String },
  gstin: { type: String },
  statecode: { type: String }
}, { strict: false });
ConsigneeSchema.index({ name: 1 });
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

// ==========================================
// 2. IN-MEMORY CACHE (ULTRA-FAST < 1ms READS)
// ==========================================
const cache = {
  data: {},
  get(key) {
    const item = this.data[key];
    if (!item) return null;
    if (Date.now() > item.expiry) {
      delete this.data[key];
      return null;
    }
    return item.value;
  },
  set(key, value, ttlMs = 15000) {
    this.data[key] = { value, expiry: Date.now() + ttlMs };
  },
  invalidate(pattern) {
    if (!pattern) {
      this.data = {};
      return;
    }
    for (const key of Object.keys(this.data)) {
      if (key.includes(pattern)) delete this.data[key];
    }
  }
};

// Fallback JSON File helper
function readJsonFile(name, fallback = []) {
  try {
    const fpath = path.join(__dirname, 'data', name + '.json');
    if (fs.existsSync(fpath)) {
      const raw = fs.readFileSync(fpath, 'utf8');
      return JSON.parse(raw || 'null') || fallback;
    }
  } catch (e) {
    console.error('Failed to read fallback file:', name, e.message);
  }
  return fallback;
}

function writeJsonFile(name, data) {
  try {
    const ddir = path.join(__dirname, 'data');
    if (!fs.existsSync(ddir)) fs.mkdirSync(ddir, { recursive: true });
    fs.writeFileSync(path.join(ddir, name + '.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write fallback file:', name, e.message);
  }
}

// Default settings object
function getDefaultSettings() {
  return {
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
  };
}

// ==========================================
// 3. WHATSAPP CLIENT SETUP
// ==========================================
let qrCodeDataUrl = null;
let isWhatsappConnected = false;
let client = null;

try {
  const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
  console.log('Initializing WhatsApp Client in background...');
  client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log('WhatsApp QR Code received.');
    isWhatsappConnected = false;
    try {
      qrCodeDataUrl = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error('Failed to generate QR Data URL', err);
    }
  });

  client.on('ready', () => {
    console.log('⚡ WhatsApp Client is ready!');
    isWhatsappConnected = true;
    qrCodeDataUrl = null;
  });

  client.on('authenticated', () => {
    console.log('WhatsApp Authenticated!');
  });

  client.on('auth_failure', msg => {
    console.error('WhatsApp Authentication failure', msg);
    isWhatsappConnected = false;
  });

  client.on('disconnected', (reason) => {
    console.log('WhatsApp Client disconnected', reason);
    isWhatsappConnected = false;
    client.initialize().catch(e => console.warn('WA re-init error:', e.message));
  });

  client.initialize().catch(e => {
    console.warn('WhatsApp initial launch warning (Puppeteer may be missing or busy):', e.message);
  });
} catch (e) {
  console.warn('WhatsApp client module error:', e.message);
}

// ==========================================
// 4. HIGH-SPEED API ENDPOINTS
// ==========================================

// Health check / latency test
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: isDbConnected ? 'mongodb' : 'fallback-file',
    whatsapp: isWhatsappConnected,
    timestamp: Date.now()
  });
});

// ⚡ BATCH BOOTSTRAP ENDPOINT: Loads EVERYTHING in ONE single round trip (under 10ms)
app.get('/api/bootstrap', async (req, res) => {
  const cached = cache.get('bootstrap');
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  const startTime = Date.now();
  try {
    let invoices, products, receivers, consignees, settings;

    if (isDbConnected) {
      [invoices, products, receivers, consignees, settings] = await Promise.all([
        Invoice.find().sort({ date: -1, invoiceNo: -1 }).lean(),
        Product.find().sort({ name: 1 }).lean(),
        Receiver.find().sort({ name: 1 }).lean(),
        Consignee.find().sort({ name: 1 }).lean(),
        Settings.findOne().lean()
      ]);
    } else {
      invoices = readJsonFile('invoices', []);
      products = readJsonFile('products', []);
      receivers = readJsonFile('receivers', []);
      consignees = readJsonFile('consignees', []);
      settings = readJsonFile('settings', getDefaultSettings());
    }

    if (!settings) {
      settings = getDefaultSettings();
      if (isDbConnected) {
        new Settings(settings).save().catch(() => {});
      }
    }

    const payload = {
      invoices: (invoices || []).map(normalizeInvoice),
      products: products || [],
      receivers: receivers || [],
      consignees: consignees || [],
      settings: settings || getDefaultSettings(),
      tookMs: Date.now() - startTime
    };

    cache.set('bootstrap', payload, 60000); // 60s TTL with instant cache invalidation on mutations
    res.json(payload);
  } catch (err) {
    console.error('Bootstrap error, falling back:', err.message);
    const fallbackPayload = {
      invoices: (readJsonFile('invoices', [])).map(normalizeInvoice),
      products: readJsonFile('products', []),
      receivers: readJsonFile('receivers', []),
      consignees: readJsonFile('consignees', []),
      settings: readJsonFile('settings', getDefaultSettings()),
      tookMs: Date.now() - startTime
    };
    res.json(fallbackPayload);
  }
});

// Helper functions for bulletproof invoice ID normalization & matching
function normalizeInvoice(doc) {
  if (!doc) return null;
  const raw = doc.toObject ? doc.toObject() : doc;
  const idStr = String(raw.id || raw._id || Date.now());
  return {
    ...raw,
    id: idStr,
    _id: idStr
  };
}

function buildInvoiceQuery(idParam) {
  const idStr = String(idParam || '').trim();
  const conditions = [
    { id: idStr }
  ];
  const num = Number(idStr);
  if (!isNaN(num) && num > 0) {
    conditions.push({ id: num });
    conditions.push({ invoiceNo: num });
  }
  if (mongoose.Types.ObjectId.isValid(idStr) && idStr.length === 24) {
    try {
      conditions.push({ _id: new mongoose.Types.ObjectId(idStr) });
    } catch (e) {}
  }
  return { $or: conditions };
}

// --- INVOICES CRUD ---
app.get('/api/invoices', async (req, res) => {
  const cached = cache.get('invoices');
  if (cached) return res.json(cached);

  try {
    if (isDbConnected) {
      const rawInvoices = await Invoice.find().sort({ date: -1, invoiceNo: -1 }).lean();
      const invoices = (rawInvoices || []).map(normalizeInvoice);
      cache.set('invoices', invoices, 8000);
      return res.json(invoices);
    }
  } catch (err) {
    console.error('Invoice DB read failed:', err.message);
  }
  const fallback = (readJsonFile('invoices', [])).map(normalizeInvoice);
  res.json(fallback);
});

app.get('/api/invoices/:id', async (req, res) => {
  try {
    const idParam = req.params.id;
    if (isDbConnected) {
      const inv = await Invoice.findOne(buildInvoiceQuery(idParam)).lean();
      if (inv) return res.json(normalizeInvoice(inv));
    }
  } catch (err) {
    console.error(err.message);
  }
  const list = readJsonFile('invoices', []);
  const found = list.find(i => String(i.id) === String(req.params.id) || String(i._id) === String(req.params.id) || String(i.invoiceNo) === String(req.params.id));
  if (found) return res.json(normalizeInvoice(found));
  res.status(404).json({ error: 'Invoice not found' });
});

app.post('/api/invoices', async (req, res) => {
  cache.invalidate('invoice');
  cache.invalidate('bootstrap');
  try {
    const body = { ...req.body };
    const invId = body.id ? String(body.id) : String(Date.now());
    body.id = invId;

    if (!body._id || !mongoose.Types.ObjectId.isValid(body._id) || String(body._id).length !== 24) {
      delete body._id;
    }

    let savedDoc = body;
    if (isDbConnected) {
      const existing = await Invoice.findOne(buildInvoiceQuery(invId)).lean();
      if (existing) {
        delete body._id;
        const updated = await Invoice.findOneAndUpdate(buildInvoiceQuery(invId), body, { new: true }).lean();
        savedDoc = updated || body;
      } else {
        const doc = new Invoice(body);
        const saved = await doc.save();
        savedDoc = saved.toObject ? saved.toObject() : saved;
      }
    }
    savedDoc = normalizeInvoice(savedDoc);

    // Also save to fallback file
    let list = readJsonFile('invoices', []);
    list = list.filter(i => String(i.id) !== invId && String(i._id) !== invId && String(i.invoiceNo) !== String(body.invoiceNo));
    list.unshift(savedDoc);
    writeJsonFile('invoices', list);

    res.json({ success: true, invoice: savedDoc });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save invoice', detail: err.message });
  }
});

app.put('/api/invoices/:id', async (req, res) => {
  cache.invalidate('invoice');
  cache.invalidate('bootstrap');
  try {
    const idParam = req.params.id;
    const body = { ...req.body };
    delete body._id;
    let updated = null;
    if (isDbConnected) {
      updated = await Invoice.findOneAndUpdate(buildInvoiceQuery(idParam), body, { new: true }).lean();
    }
    // Fallback file update
    let list = readJsonFile('invoices', []);
    list = list.map(i => (String(i.id) === String(idParam) || String(i._id) === String(idParam) || String(i.invoiceNo) === String(idParam)) ? { ...i, ...req.body } : i);
    writeJsonFile('invoices', list);

    res.json({ success: true, invoice: normalizeInvoice(updated || req.body) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

app.delete('/api/invoices/:id', async (req, res) => {
  cache.invalidate('invoice');
  cache.invalidate('bootstrap');
  try {
    const idParam = req.params.id;
    const idStr = String(idParam || '').trim();
    let deletedCount = 0;
    if (isDbConnected) {
      const query = buildInvoiceQuery(idStr);
      const result = await Invoice.deleteMany(query);
      deletedCount = result.deletedCount;
      console.log(`Deleted invoice from MongoDB query:`, idStr, `deletedCount:`, deletedCount);
    }
    let list = readJsonFile('invoices', []);
    const beforeLen = list.length;
    list = list.filter(i => String(i.id) !== idStr && String(i._id) !== idStr && String(i.invoiceNo) !== idStr);
    writeJsonFile('invoices', list);

    res.json({ success: true, deletedCount: Math.max(deletedCount, beforeLen - list.length) });
  } catch (err) {
    console.error('Delete invoice error:', err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// --- PRODUCTS CRUD ---
app.get('/api/products', async (req, res) => {
  const cached = cache.get('products');
  if (cached) return res.json(cached);

  try {
    if (isDbConnected) {
      const products = await Product.find().sort({ name: 1 }).lean();
      cache.set('products', products, 15000);
      return res.json(products);
    }
  } catch (err) {
    console.error(err.message);
  }
  res.json(readJsonFile('products', []));
});

app.post('/api/products', async (req, res) => {
  cache.invalidate('product');
  cache.invalidate('bootstrap');
  try {
    let saved = req.body;
    if (isDbConnected) {
      const doc = new Product(req.body);
      saved = await doc.save();
    }
    const list = readJsonFile('products', []);
    list.push(saved);
    writeJsonFile('products', list);
    res.json({ success: true, product: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save product' });
  }
});

app.put('/api/products/:id', async (req, res) => {
  cache.invalidate('product');
  cache.invalidate('bootstrap');
  try {
    let updated = null;
    if (isDbConnected) {
      updated = await Product.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    }
    let list = readJsonFile('products', []);
    list = list.map(p => p.id === Number(req.params.id) ? { ...p, ...req.body } : p);
    writeJsonFile('products', list);
    res.json({ success: true, product: updated || req.body });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.delete('/api/products/:id', async (req, res) => {
  cache.invalidate('product');
  cache.invalidate('bootstrap');
  try {
    let deletedCount = 0;
    if (isDbConnected) {
      const result = await Product.deleteOne({ id: Number(req.params.id) });
      deletedCount = result.deletedCount;
    }
    let list = readJsonFile('products', []);
    list = list.filter(p => p.id !== Number(req.params.id));
    writeJsonFile('products', list);
    res.json({ success: true, deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// --- RECEIVERS CRUD ---
app.get('/api/receivers', async (req, res) => {
  const cached = cache.get('receivers');
  if (cached) return res.json(cached);

  try {
    if (isDbConnected) {
      const receivers = await Receiver.find().sort({ name: 1 }).lean();
      cache.set('receivers', receivers, 15000);
      return res.json(receivers);
    }
  } catch (err) {
    console.error(err.message);
  }
  res.json(readJsonFile('receivers', []));
});

app.post('/api/receivers', async (req, res) => {
  cache.invalidate('receiver');
  cache.invalidate('bootstrap');
  try {
    let saved = req.body;
    if (isDbConnected) {
      const doc = new Receiver(req.body);
      saved = await doc.save();
    }
    const list = readJsonFile('receivers', []);
    list.push(saved);
    writeJsonFile('receivers', list);
    res.json({ success: true, receiver: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save receiver' });
  }
});

app.put('/api/receivers/:id', async (req, res) => {
  cache.invalidate('receiver');
  cache.invalidate('bootstrap');
  try {
    let updated = null;
    if (isDbConnected) {
      updated = await Receiver.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    }
    let list = readJsonFile('receivers', []);
    list = list.map(r => r.id === Number(req.params.id) ? { ...r, ...req.body } : r);
    writeJsonFile('receivers', list);
    res.json({ success: true, receiver: updated || req.body });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update receiver' });
  }
});

app.delete('/api/receivers/:id', async (req, res) => {
  cache.invalidate('receiver');
  cache.invalidate('bootstrap');
  try {
    let deletedCount = 0;
    if (isDbConnected) {
      const result = await Receiver.deleteOne({ id: Number(req.params.id) });
      deletedCount = result.deletedCount;
    }
    let list = readJsonFile('receivers', []);
    list = list.filter(r => r.id !== Number(req.params.id));
    writeJsonFile('receivers', list);
    res.json({ success: true, deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete receiver' });
  }
});

// --- CONSIGNEES CRUD ---
app.get('/api/consignees', async (req, res) => {
  const cached = cache.get('consignees');
  if (cached) return res.json(cached);

  try {
    if (isDbConnected) {
      const consignees = await Consignee.find().sort({ name: 1 }).lean();
      cache.set('consignees', consignees, 15000);
      return res.json(consignees);
    }
  } catch (err) {
    console.error(err.message);
  }
  res.json(readJsonFile('consignees', []));
});

app.post('/api/consignees', async (req, res) => {
  cache.invalidate('consignee');
  cache.invalidate('bootstrap');
  try {
    let saved = req.body;
    if (isDbConnected) {
      const doc = new Consignee(req.body);
      saved = await doc.save();
    }
    const list = readJsonFile('consignees', []);
    list.push(saved);
    writeJsonFile('consignees', list);
    res.json({ success: true, consignee: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save consignee' });
  }
});

app.put('/api/consignees/:id', async (req, res) => {
  cache.invalidate('consignee');
  cache.invalidate('bootstrap');
  try {
    let updated = null;
    if (isDbConnected) {
      updated = await Consignee.findOneAndUpdate({ id: Number(req.params.id) }, req.body, { new: true });
    }
    let list = readJsonFile('consignees', []);
    list = list.map(c => c.id === Number(req.params.id) ? { ...c, ...req.body } : c);
    writeJsonFile('consignees', list);
    res.json({ success: true, consignee: updated || req.body });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update consignee' });
  }
});

app.delete('/api/consignees/:id', async (req, res) => {
  cache.invalidate('consignee');
  cache.invalidate('bootstrap');
  try {
    let deletedCount = 0;
    if (isDbConnected) {
      const result = await Consignee.deleteOne({ id: Number(req.params.id) });
      deletedCount = result.deletedCount;
    }
    let list = readJsonFile('consignees', []);
    list = list.filter(c => c.id !== Number(req.params.id));
    writeJsonFile('consignees', list);
    res.json({ success: true, deletedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete consignee' });
  }
});

// --- SETTINGS CRUD ---
app.get('/api/settings', async (req, res) => {
  const cached = cache.get('settings');
  if (cached) return res.json(cached);

  try {
    if (isDbConnected) {
      let settings = await Settings.findOne();
      if (!settings) {
        settings = new Settings(getDefaultSettings());
        await settings.save();
      }
      cache.set('settings', settings, 15000);
      return res.json(settings);
    }
  } catch (err) {
    console.error(err.message);
  }
  res.json(readJsonFile('settings', getDefaultSettings()));
});

app.put('/api/settings', async (req, res) => {
  cache.invalidate('settings');
  cache.invalidate('bootstrap');
  try {
    let settings = null;
    if (isDbConnected) {
      settings = await Settings.findOne();
      if (!settings) settings = new Settings({});
      if (req.body.nextInvoiceNo !== undefined) settings.nextInvoiceNo = req.body.nextInvoiceNo;
      if (req.body.inactivityTimeout !== undefined) settings.inactivityTimeout = req.body.inactivityTimeout;
      if (req.body.telegram) settings.telegram = { ...settings.telegram, ...req.body.telegram };
      if (req.body.emailSettings) settings.emailSettings = { ...settings.emailSettings, ...req.body.emailSettings };
      settings.markModified('telegram');
      settings.markModified('emailSettings');
      await settings.save();
    }
    let cur = readJsonFile('settings', getDefaultSettings());
    let updated = { ...cur, ...req.body };
    writeJsonFile('settings', updated);

    res.json({ success: true, settings: settings || updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ==========================================
// 5. WHATSAPP ENDPOINTS
// ==========================================
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    connected: isWhatsappConnected,
    qr: qrCodeDataUrl
  });
});


app.post('/api/whatsapp/sendPdf', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {}); };

  if (!isWhatsappConnected || !client) {
    cleanup();
    return res.status(400).json({ error: 'WhatsApp is not connected. Please scan the QR code first.' });
  }

  try {
    let phone = req.body.phone;
    if (!phone) {
      cleanup();
      return res.status(400).json({ error: 'Missing customer phone number' });
    }
    // Clean phone number to digits only
    phone = phone.replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;

    let targetChatId = phone + '@c.us';
    try {
      const numberId = await client.getNumberId(phone);
      if (numberId && numberId._serialized && !numberId._serialized.endsWith('@lid')) {
        targetChatId = numberId._serialized;
      }
    } catch (numErr) {
      console.warn('getNumberId note:', numErr.message);
    }

    if (!filePath || !fs.existsSync(filePath)) {
      cleanup();
      return res.status(400).json({ error: 'PDF file missing or empty' });
    }

    const { MessageMedia } = require('whatsapp-web.js');
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    const mimetype = (req.file && req.file.mimetype) || 'application/pdf';
    const filename = (req.file && req.file.originalname) || 'Invoice.pdf';
    const media = new MessageMedia(mimetype, base64Data, filename);

    const caption = req.body.caption || 'Here is your invoice from Anudeep Khadi Bandar. Thank you for your business!';
    console.log(`Sending WhatsApp invoice PDF to ${targetChatId}...`);

    await client.sendMessage(targetChatId, media, {
      caption: caption,
      sendMediaAsDocument: true
    });

    cleanup();
    console.log(`✅ WhatsApp invoice PDF sent successfully to ${targetChatId}`);
    res.json({ success: true, message: 'PDF sent via WhatsApp successfully!' });
  } catch (err) {
    console.error('Error sending WhatsApp message:', err);
    cleanup();
    res.status(500).json({ error: 'Failed to send WhatsApp message', details: err.message });
  }
});

app.post('/api/whatsapp/sendMessage', async (req, res) => {
  if (!isWhatsappConnected || !client) {
    return res.status(400).json({ error: 'WhatsApp is not connected.' });
  }
  try {
    let phone = req.body.phone;
    let message = req.body.message;
    if (!phone || !message) return res.status(400).json({ error: 'Missing phone or message' });
    phone = phone.replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;

    let targetChatId = phone + '@c.us';
    try {
      const numberId = await client.getNumberId(phone);
      if (numberId && numberId._serialized) targetChatId = numberId._serialized;
    } catch (e) {}

    await client.sendMessage(targetChatId, message);
    res.json({ success: true, message: 'WhatsApp message sent successfully!' });
  } catch (err) {
    console.error('Error sending WhatsApp text message:', err);
    res.status(500).json({ error: 'Failed to send message', details: err.message });
  }
});

// ==========================================
// 6. TELEGRAM PROXY ENDPOINTS
// ==========================================
app.post('/api/sendTelegramDocument', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath) fs.unlink(filePath, () => {}); };
  try {
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
    cleanup();

    if (!json) return res.status(500).json({ error: 'No response from Telegram' });
    if (!json.ok) return res.status(502).json({ error: 'Telegram error', detail: json });
    return res.json(json);
  } catch (err) {
    cleanup();
    console.error('sendTelegramDocument error:', err.message);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

app.post('/api/sendTelegramMessage', async (req, res) => {
  try {
    const { token, chatId, text } = req.body;
    if (!token || !chatId || !text) return res.status(400).json({ error: 'Missing fields' });

    const tgUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetchWithRetry(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const json = await r.json();
    return res.json(json);
  } catch (err) {
    console.error('sendTelegramMessage error:', err.message);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// Root route serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 7. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`⚡ AKB High-Speed Backend Server Running`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🚀 Database: MongoDB & Fast Cache on /api/bootstrap`);
  console.log(`📲 WhatsApp: http://localhost:${PORT}/api/whatsapp/status`);
  console.log(`===============================================`);
});
