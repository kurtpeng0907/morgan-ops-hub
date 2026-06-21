/**
 * Morgan Ops Hub - Google Apps Script API
 *
 * Paste this file into Apps Script as Code.gs, deploy a new Web App version,
 * then keep the same /exec URL in the frontend if Apps Script gives you one.
 *
 * Security model:
 * - Existing admin/frontdesk pages still read the legacy full database so the
 *   current site will not break.
 * - Public client selection pages should use ?mode=clientSelection. That route
 *   returns only the selected/link-safe therapist fields, same-day schedules,
 *   and conflict-only appointment data. It never returns PINs, admin records,
 *   customer records, door password, or internal notes.
 * - You can later set Script Property API_SECRET and update the frontend to
 *   send token=... for full database reads/writes. Until then, legacy access
 *   remains enabled for compatibility.
 */
const SHEET_THERAPISTS = 'Therapists';
const SHEET_SCHEDULES = 'Schedules';
const SHEET_ADMINS = 'Admins';
const SHEET_APPOINTMENTS = 'Appointments';
const SHEET_CUSTOMERS = 'Customers';

const CLIENT_SELECTION_PREFIX = 'SYS_CLIENT_SELECTION_';
const THERAPIST_PROFILE_PREFIX = 'SYS_THERAPIST_PROFILE_';
const APPOINTMENT_META_PREFIX = 'SYS_APPT_META_';

function setup() {
  MailApp.getRemainingDailyQuota();
  Logger.log('授權成功，Email 功能可使用。');
}

function doGet(e) {
  try {
    const mode = String(e && e.parameter && e.parameter.mode || '');
    if (mode === 'clientSelection') {
      return jsonOutput(getClientSelectionData(e.parameter || {}));
    }

    const secret = getApiSecret_();
    if (secret && !isAuthorized_(e && e.parameter)) {
      return jsonOutput({ success: false, error: 'unauthorized' });
    }

    return jsonOutput(getAllData());
  } catch (err) {
    return jsonOutput({ success: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const params = JSON.parse((e.postData && e.postData.contents) || '{}');
    const action = String(params.action || '');
    const data = params.data || {};

    const secret = getApiSecret_();
    if (secret && action !== 'submitClientSelection' && !isAuthorized_(params)) {
      return jsonOutput({ success: false, error: 'unauthorized' });
    }

    if (action === 'saveSchedule') {
      updateScheduleMerge(data.id, data.schedule || {});
    } else if (action === 'addTherapist' || action === 'updatePin') {
      saveTherapist(data);
    } else if (action === 'deleteTherapist') {
      deleteRow(SHEET_THERAPISTS, data.id);
      deleteRow(SHEET_SCHEDULES, data.id);
    } else if (action === 'addAppointment') {
      saveAppointment(data);
    } else if (action === 'deleteAppointment') {
      deleteRow(SHEET_APPOINTMENTS, data.appId || data.id);
    } else if (action === 'saveCustomer') {
      saveCustomer(data);
    } else if (action === 'deleteCustomer') {
      deleteRow(SHEET_CUSTOMERS, data.phone);
    } else if (action === 'repairTherapists') {
      repairTherapistRows();
    } else if (action === 'submitClientSelection') {
      saveClientSelectionSubmission(data);
    } else if (action === 'sendEmailNotification') {
      sendEmailNotification(data);
    } else {
      throw new Error('Unknown action: ' + action);
    }

    return jsonOutput({ success: true });
  } catch (err) {
    return jsonOutput({ success: false, error: String(err) });
  }
}

function getAllData() {
  initSheets();
  const db = { therapists: {}, schedules: {}, admins: {}, appointments: {}, customers: {} };

  getSheetData(SHEET_THERAPISTS).forEach(row => {
    const id = cleanCellId_(row[0]);
    if (!id || id === '編號') return;
    if (db.therapists[id] && db.therapists[id].name) return;
    if (db.therapists[id] && !String(row[1] || '').trim()) return;
    db.therapists[id] = {
      name: String(row[1] || ''),
      pin: cleanPin_(row[2])
    };
  });

  getSheetData(SHEET_SCHEDULES).forEach(row => {
    const id = cleanCellId_(row[0]);
    if (!id) return;
    try {
      db.schedules[id] = JSON.parse(row[1] || '{}');
    } catch (err) {
      db.schedules[id] = {};
    }
  });

  getSheetData(SHEET_APPOINTMENTS).forEach(row => {
    const id = cleanCellId_(row[0]);
    if (!id || id === '預約ID') return;
    db.appointments[id] = {
      id,
      date: normalizeDate_(row[1]),
      time: normalizeTime_(row[2]),
      therapistId: cleanCellId_(row[3]),
      customerName: String(row[4] || ''),
      phone: cleanCellId_(row[5]),
      service: String(row[6] || ''),
      duration: Number(row[7]) || 60,
      room: String(row[8] || 'R'),
      price: String(row[9] || ''),
      collectedPrice: String(row[10] || ''),
      isCompleted: String(row[11]) === 'true',
      notes: String(row[12] || ''),
      bookingStage: String(row[13] || ''),
      remittanceDue: String(row[14] || ''),
      remittancePaid: String(row[15]) === 'true',
      remittanceMethod: String(row[16] || '')
    };
  });

  getSheetData(SHEET_CUSTOMERS).forEach(row => {
    const phone = cleanCellId_(row[0]);
    if (!phone) return;
    let records = [];
    try {
      records = JSON.parse(row[3] || '[]');
    } catch (err) {
      records = [];
    }
    db.customers[phone] = {
      name: String(row[1] || ''),
      notes: String(row[2] || ''),
      records
    };
  });

  return db;
}

function getClientSelectionData(params) {
  initSheets();
  const full = getAllData();
  const selectionId = String(params.selection || params.id || '').trim();
  let selection = null;

  if (selectionId) {
    const key = CLIENT_SELECTION_PREFIX + selectionId;
    const record = full.customers[key];
    if (record && record.notes) {
      try {
        selection = JSON.parse(record.notes || '{}');
      } catch (err) {
        selection = null;
      }
    }
  }

  const date = normalizeDate_(selection && selection.date || params.date || '');
  const time = normalizeTime_(selection && selection.time || params.time || '');
  const service = String(selection && selection.service || params.service || '');
  const therapistIds = selection && Array.isArray(selection.therapistIds)
    ? selection.therapistIds.map(String)
    : String(params.therapists || '').split(',').map(s => s.trim()).filter(Boolean);

  const safe = {
    therapists: {},
    schedules: {},
    appointments: {},
    customers: {},
    clientSelections: {}
  };

  if (selection) {
    safe.customers[CLIENT_SELECTION_PREFIX + selection.id] = {
      name: '客選連結',
      notes: JSON.stringify(selection),
      records: []
    };
  }

  const allowed = new Set(therapistIds);
  const targetIds = allowed.size ? therapistIds : Object.keys(full.therapists);
  targetIds.forEach(id => {
    const therapist = full.therapists[id];
    if (!therapist) return;
    const profile = therapistPublicProfile_(id, therapist, full.customers);
    safe.therapists[id] = profile;
    const dayShift = (full.schedules[id] || {})[date] || '';
    safe.schedules[id] = date ? { [date]: normalizeShift_(dayShift) } : {};
  });

  Object.entries(full.appointments || {}).forEach(([id, appt]) => {
    if (date && appt.date !== date) return;
    if (allowed.size && !allowed.has(String(appt.therapistId))) return;
    if (!safe.therapists[appt.therapistId]) return;
    safe.appointments[id] = {
      id,
      date: appt.date,
      time: appt.time,
      therapistId: appt.therapistId,
      duration: Number(appt.duration) || 60
    };
  });

  safe.query = { selectionId, date, time, service, therapistIds };
  return safe;
}

function therapistPublicProfile_(id, therapist, customers) {
  let profile = {};
  const profileRecord = customers[THERAPIST_PROFILE_PREFIX + id];
  if (profileRecord && profileRecord.notes) {
    try {
      profile = JSON.parse(profileRecord.notes || '{}');
    } catch (err) {
      profile = {};
    }
  }
  return {
    nickname: String(profile.nickname || therapist.nickname || therapist.name || ''),
    name: String(profile.nickname || therapist.nickname || therapist.name || ''),
    age: String(profile.age || ''),
    height: String(profile.height || ''),
    weight: String(profile.weight || ''),
    specialties: String(profile.specialties || ''),
    bio: String(profile.bio || profile.notes || ''),
    photoUrl: String(profile.photoUrl || '')
  };
}

function saveTherapist(data) {
  if (!data || !data.id) throw new Error('Missing therapist id');
  updateRow(SHEET_THERAPISTS, data.id, [
    sheetText_(data.id),
    String(data.nickname || data.name || ''),
    sheetText_(data.pin || '')
  ]);
}

function repairTherapistRows() {
  initSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_THERAPISTS);
  const data = sheet.getDataRange().getValues();
  const seen = {};
  const clearRanges = [];

  for (let i = 0; i < data.length; i++) {
    const id = cleanCellId_(data[i][0]);
    if (!id) continue;
    if (id === '編號') {
      if (i > 0) clearRanges.push(sheet.getRange(i + 1, 1, 1, 3));
      continue;
    }
    if (seen[id]) {
      clearRanges.push(sheet.getRange(i + 1, 1, 1, 3));
      continue;
    }
    seen[id] = true;
  }

  clearRanges.forEach(range => range.clearContent());
  return clearRanges.length;
}

function saveAppointment(data) {
  const id = data.appId || data.id;
  if (!id) throw new Error('Missing appointment id');
  updateRow(SHEET_APPOINTMENTS, id, [
    sheetText_(id),
    normalizeDate_(data.date),
    normalizeTime_(data.time),
    sheetText_(data.therapistId || ''),
    String(data.customerName || ''),
    sheetText_(data.phone || ''),
    String(data.service || ''),
    Number(data.duration) || 60,
    String(data.room || 'R'),
    String(data.price || ''),
    String(data.collectedPrice || ''),
    boolString_(data.isCompleted),
    String(data.notes || ''),
    String(data.bookingStage || ''),
    String(data.remittanceDue || ''),
    boolString_(data.remittancePaid),
    String(data.remittanceMethod || '')
  ]);
  ensureCustomerExists(data.phone, data.customerName);
}

function saveCustomer(data) {
  if (!data || !data.phone) throw new Error('Missing customer key');
  const records = data.records ? JSON.stringify(data.records) : '[]';
  updateRow(SHEET_CUSTOMERS, data.phone, [
    sheetText_(data.phone),
    String(data.name || ''),
    String(data.notes || ''),
    records
  ]);
}

function saveClientSelectionSubmission(data) {
  if (!data || !data.id) throw new Error('Missing selection id');
  const key = CLIENT_SELECTION_PREFIX + data.id;
  const selection = {
    id: String(data.id),
    status: 'pending',
    source: 'public-client-selection',
    date: normalizeDate_(data.date),
    time: normalizeTime_(data.time),
    service: String(data.service || ''),
    duration: Number(data.duration) || 120,
    therapistIds: Array.isArray(data.therapistIds) ? data.therapistIds.map(String) : [],
    selectedTherapistId: String(data.selectedTherapistId || ''),
    selectedTherapistName: String(data.selectedTherapistName || ''),
    customerName: String(data.customerName || ''),
    customerContact: String(data.customerContact || ''),
    customerNote: String(data.customerNote || ''),
    createdAt: String(data.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString()
  };
  saveCustomer({
    phone: key,
    name: '待確認-' + (selection.customerName || selection.customerContact || '客選') + '-' + selection.selectedTherapistName,
    notes: JSON.stringify(selection),
    records: []
  });
}

function ensureCustomerExists(phone, name) {
  if (!phone) return;
  initSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CUSTOMERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (cleanCellId_(data[i][0]) === cleanCellId_(phone)) return;
  }
  sheet.appendRow([sheetText_(phone), String(name || ''), '', '[]']);
}

function updateScheduleMerge(id, newScheduleObj) {
  if (!id) throw new Error('Missing schedule id');
  initSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SCHEDULES);
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  let existingObj = {};
  for (let i = 0; i < data.length; i++) {
    if (cleanCellId_(data[i][0]) === cleanCellId_(id)) {
      rowIndex = i + 1;
      try {
        existingObj = JSON.parse(data[i][1] || '{}');
      } catch (err) {
        existingObj = {};
      }
      break;
    }
  }
  const normalizedNew = {};
  Object.keys(newScheduleObj || {}).forEach(key => {
    normalizedNew[normalizeDate_(key)] = normalizeShift_(newScheduleObj[key]);
  });
  const mergedObj = Object.assign({}, existingObj, normalizedNew);
  const rowData = [sheetText_(id), JSON.stringify(mergedObj)];
  if (rowIndex > -1) sheet.getRange(rowIndex, 1, 1, 2).setValues([rowData]);
  else sheet.appendRow(rowData);
}

function updateRow(sheetName, id, rowData) {
  initSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const normalizedId = cleanCellId_(id);
  for (let i = 0; i < data.length; i++) {
    if (cleanCellId_(data[i][0]) === normalizedId) {
      sheet.getRange(i + 1, 1, 1, rowData.length).setValues([rowData]);
      return;
    }
  }
  sheet.appendRow(rowData);
}

function deleteRow(sheetName, id) {
  initSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const data = sheet.getDataRange().getValues();
  const normalizedId = cleanCellId_(id);
  for (let i = 0; i < data.length; i++) {
    if (cleanCellId_(data[i][0]) === normalizedId) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

function getSheetData(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  return sheet ? sheet.getDataRange().getValues() : [];
}

function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEET_THERAPISTS, SHEET_SCHEDULES, SHEET_ADMINS, SHEET_APPOINTMENTS, SHEET_CUSTOMERS].forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
}

function sendEmailNotification(data) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CUSTOMERS);
  if (!sheet) return;
  const cData = sheet.getDataRange().getValues();
  const emails = [];
  for (let i = 0; i < cData.length; i++) {
    if (!String(cleanCellId_(cData[i][0])).startsWith('SYS_ADMIN_')) continue;
    try {
      const records = JSON.parse(cData[i][3] || '[]');
      if (records[0] && records[0].email && String(records[0].email).includes('@')) {
        emails.push(records[0].email);
      }
    } catch (err) {}
  }
  emails.forEach(email => {
    MailApp.sendEmail({
      to: email,
      subject: String(data.subject || ''),
      htmlBody: String(data.body || '')
    });
  });
}

function jsonOutput(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function cleanCellId_(value) {
  return String(value == null ? '' : value).replace(/^'/, '').trim();
}

function cleanPin_(value) {
  return cleanCellId_(value);
}

function sheetText_(value) {
  const text = cleanCellId_(value);
  return /^0\d+/.test(text) ? "'" + text : text;
}

function boolString_(value) {
  return value === true || String(value) === 'true' || String(value) === 'on' ? 'true' : 'false';
}

function normalizeDate_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
  }
  const text = String(value).trim();
  const direct = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (direct) return direct[1] + '-' + String(direct[2]).padStart(2, '0') + '-' + String(direct[3]).padStart(2, '0');
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? text : Utilities.formatDate(parsed, Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
}

function normalizeTime_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'Asia/Taipei', 'HH:mm');
  }
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const total = Math.round(value * 24 * 60);
    return String(Math.floor(total / 60) % 24).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }
  const text = String(value).trim().replace(/：/g, ':');
  const match = text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\b/);
  return match ? String(match[1]).padStart(2, '0') + ':' + match[2] : text.slice(0, 5);
}

function normalizeShift_(value) {
  return String(value || '')
    .replace(/：/g, ':')
    .replace(/[－–—~～至到]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}

function getApiSecret_() {
  return String(PropertiesService.getScriptProperties().getProperty('API_SECRET') || '').trim();
}

function isAuthorized_(params) {
  const secret = getApiSecret_();
  if (!secret) return true;
  return String(params && (params.token || params.apiToken) || '') === secret;
}
