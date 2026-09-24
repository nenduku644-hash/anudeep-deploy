/**
 * Google Apps Script Backend for AKB Billing - HIGH PERFORMANCE EDITION
 * 
 * 1. Open Google Sheets -> Extensions -> Apps Script.
 * 2. Delete any code there and paste all this code.
 * 3. Replace DRIVE_FOLDER_ID below with the ID of the folder where you want to save PDFs.
 * 4. Click "Deploy" -> "New Deployment" -> Select type "Web app".
 * 5. Execute as "Me", Who has access: "Anyone".
 * 6. Copy the "Web app URL" and use it in your frontend code.
 */

const DRIVE_FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID_HERE';

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'bootstrap';
  try {
    let result = null;
    switch (action) {
      // ⚡ BATCH ENDPOINT: Returns ALL data in a single round-trip (under 2s instead of 25s!)
      case 'bootstrap':
      case 'getAllData':
        result = getBootstrapData();
        break;
      case 'getInvoices': result = getAll('Invoices'); break;
      case 'getProducts': result = getAll('Products'); break;
      case 'getReceivers': result = getAll('Receivers'); break;
      case 'getConsignees': result = getAll('Consignees'); break;
      case 'getSettings': result = getSettings(); break;
      default:
        return respond({ error: 'Invalid GET action' }, 400);
    }
    return respond(result);
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

function doPost(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  
  // Handle PDF Uploads (multipart/form-data from frontend)
  if (action === 'uploadPdf') {
    try {
      const fileBlob = e.parameter.file; // This expects the file input name to be "file"
      const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
      const newFile = folder.createFile(fileBlob);
      // Make it accessible for viewing
      newFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      
      return respond({
        ok: true,
        driveId: newFile.getId(),
        link: newFile.getUrl(),
        description: 'Successfully uploaded to Google Drive'
      });
    } catch (err) {
      return respond({ error: err.message }, 500);
    }
  }

  // Handle JSON Data Actions
  let payload = {};
  if (e.postData && e.postData.contents) {
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return respond({ error: 'Invalid JSON payload' }, 400);
    }
  }

  try {
    let result = null;
    switch (action) {
      case 'createInvoice': result = createDoc('Invoices', payload); break;
      case 'updateInvoice': result = updateDoc('Invoices', e.parameter.id, payload); break;
      case 'deleteInvoice': result = deleteDoc('Invoices', e.parameter.id); break;
      
      case 'createProduct': result = createDoc('Products', payload); break;
      case 'updateProduct': result = updateDoc('Products', e.parameter.id, payload); break;
      case 'deleteProduct': result = deleteDoc('Products', e.parameter.id); break;
      
      case 'createReceiver': result = createDoc('Receivers', payload); break;
      case 'updateReceiver': result = updateDoc('Receivers', e.parameter.id, payload); break;
      case 'deleteReceiver': result = deleteDoc('Receivers', e.parameter.id); break;
      
      case 'createConsignee': result = createDoc('Consignees', payload); break;
      case 'updateConsignee': result = updateDoc('Consignees', e.parameter.id, payload); break;
      case 'deleteConsignee': result = deleteDoc('Consignees', e.parameter.id); break;
      
      case 'updateSettings': result = updateSettings(payload); break;
      
      default:
        return respond({ error: 'Invalid POST action' }, 400);
    }
    // Invalidate batch cache on mutations
    invalidateCache();
    return respond({ success: true, data: result });
  } catch (err) {
    return respond({ error: err.message }, 500);
  }
}

// OPTIONS method to handle CORS preflight
function doOptions(e) {
  return respond({ status: 'ok' });
}

// ====== DB Helpers ======

function invalidateCache() {
  try {
    CacheService.getScriptCache().remove('akb_bootstrap_v1');
  } catch(e) {}
}

function getSheet(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['ID', 'Data']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ⚡ FAST SINGLE-PASS BOOTSTRAP
function getBootstrapData() {
  try {
    const cached = CacheService.getScriptCache().get('akb_bootstrap_v1');
    if (cached) return JSON.parse(cached);
  } catch(e) {}

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  function readSheetData(sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return [];
    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) return [];
    const items = [];
    for (let i = 1; i < values.length; i++) {
      try {
        if (values[i][1]) items.push(JSON.parse(values[i][1]));
      } catch(err) {}
    }
    return items;
  }

  const invoices = readSheetData('Invoices');
  invoices.sort((a, b) => (b.invoiceNo || 0) - (a.invoiceNo || 0));

  const result = {
    invoices: invoices,
    products: readSheetData('Products'),
    receivers: readSheetData('Receivers'),
    consignees: readSheetData('Consignees'),
    settings: getSettings()
  };

  try {
    const jsonStr = JSON.stringify(result);
    if (jsonStr.length < 95000) {
      CacheService.getScriptCache().put('akb_bootstrap_v1', jsonStr, 60);
    }
  } catch(e) {}

  return result;
}

function getAll(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const results = [];
  for (let i = 1; i < data.length; i++) {
    try {
      if (data[i][1]) results.push(JSON.parse(data[i][1]));
    } catch(e) {}
  }
  
  // Sort Invoices descending
  if (sheetName === 'Invoices') {
    results.sort((a, b) => (b.invoiceNo || 0) - (a.invoiceNo || 0));
  }
  
  return results;
}

function createDoc(sheetName, payload) {
  const sheet = getSheet(sheetName);
  const id = payload.id || payload._id || new Date().getTime().toString();
  payload.id = payload.id || id;
  payload._id = payload._id || id;
  
  sheet.appendRow([String(id), JSON.stringify(payload)]);
  return payload;
}

function updateDoc(sheetName, id, payload) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.getRange(i + 1, 2).setValue(JSON.stringify(payload));
      return payload;
    }
  }
  throw new Error('Document not found');
}

function deleteDoc(sheetName, id) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { deleted: true };
    }
  }
  throw new Error('Document not found');
}

function getSettings() {
  const sheet = getSheet('Settings');
  const data = sheet.getDataRange().getValues();
  
  let settings = {
    nextInvoiceNo: 1,
    inactivityTimeout: 300000,
    telegram: { token: '8799482746:AAGiDi8HEoV7KGQNyer4772H_d1qv9fznac', chatId: '6877857251' },
    emailSettings: { defaultCC: '', subjectPrefix: 'Tax Invoice' }
  };
  
  if (data.length > 1 && data[1][1]) {
    try {
      settings = JSON.parse(data[1][1]);
    } catch(e) {}
  } else {
    sheet.appendRow(['1', JSON.stringify(settings)]);
  }
  return settings;
}

function updateSettings(payload) {
  const sheet = getSheet('Settings');
  const data = sheet.getDataRange().getValues();
  
  let current = getSettings();
  let updated = Object.assign({}, current, payload);
  if (payload.telegram) updated.telegram = Object.assign({}, current.telegram, payload.telegram);
  if (payload.emailSettings) updated.emailSettings = Object.assign({}, current.emailSettings, payload.emailSettings);
  
  if (data.length > 1) {
    sheet.getRange(2, 2).setValue(JSON.stringify(updated));
  } else {
    sheet.appendRow(['1', JSON.stringify(updated)]);
  }
  
  return updated;
}

// ====== Response Helper ======

function respond(data, code = 200) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
