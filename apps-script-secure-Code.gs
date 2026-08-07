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
const SHEET_SERVICE_RECORDS = 'ServiceRecords';
const SHEET_MUTATIONS = 'Mutations';

const CLIENT_SELECTION_PREFIX = 'SYS_CLIENT_SELECTION_';
const THERAPIST_PROFILE_PREFIX = 'SYS_THERAPIST_PROFILE_';
const APPOINTMENT_META_PREFIX = 'SYS_APPT_META_';
const ADMIN_PREFIX = 'SYS_ADMIN_';
const ADMIN_LOGIN_LOG_KEY = 'SYS_ADMIN_LOGIN_LOG';
const FRONTDESK_LOGIN_LOG_KEY = 'SYS_FRONTDESK_LOGIN_LOG';
const BOOTSTRAP_CACHE_VERSION_KEY = 'BOOTSTRAP_CACHE_VERSION';
const BOOTSTRAP_CACHE_TTL_SECONDS = 180;
const LEGACY_RECORDS_MAX_CHARS = 45000;
const SERVICE_RECORD_SCHEMA = 'service-record-v2';
let ACTIVE_ROW_INDEXES_ = {};
const DATA_CONTRACT_VERSION = 'morgan-v2.0';

// LINE staff reminder configuration (store values in Script Properties).
// Required: LINE_CHANNEL_ACCESS_TOKEN, LINE_STAFF_RECIPIENTS (comma-separated user/group/room IDs).
// Optional: LINE_REMINDER_HOUR (default 09), LINE_REMINDER_LEAD_MINUTES (default 60).
const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
const LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply';
const LINE_REMINDER_TIMEZONE = 'Asia/Taipei';

function setup() {
  MailApp.getRemainingDailyQuota();
  Logger.log('授權成功，Email 功能可使用。');
}

function doGet(e) {
  try {
    const mode = String(e && e.parameter && e.parameter.mode || '');
    if (mode === 'capabilities') {
      return jsonOutput({ success: true, capabilities: { batch: true, clientSelection: true }, version: DATA_CONTRACT_VERSION });
    }
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
  let lock = null;
  let lockHeld = false;
  try {
    const params = JSON.parse((e.postData && e.postData.contents) || '{}');
    // LINE webhook events do not use the app's normal action envelope.
    if (Array.isArray(params.events)) return jsonOutput(handleLineWebhook_(params, e && e.parameter || {}));
    const action = String(params.action || '');
    const data = params.data || {};
    const actor = params.actor || {};

    if (action === 'authenticate' || action === 'bootstrap' || action === 'fullData' || action === 'customerRecords' || action === 'mutationStatus' || action === 'serviceRecordsAudit') {
      if (!isGatewayAuthorized_(params)) return jsonOutput({ success: false, error: 'unauthorized_gateway' });
      if (action === 'authenticate') return jsonOutput(authenticateGatewayUser_(data));
      if (action === 'bootstrap') return jsonOutput(getGatewayBootstrap_(data));
      if (action === 'customerRecords') return jsonOutput(getGatewayCustomerRecords_(data));
      if (action === 'mutationStatus') return jsonOutput(getMutationStatus_(data.mutationId));
      if (action === 'serviceRecordsAudit') {
        if (String(data.role || '') !== 'admin') return jsonOutput({ success: false, error: 'forbidden' });
        return jsonOutput(auditServiceRecords_());
      }
      return jsonOutput(getGatewayFullData_(data));
    }

    const secret = getApiSecret_();
    if (secret && action !== 'submitClientSelection' && !isAuthorized_(params) && !isGatewayAuthorized_(params)) {
      return jsonOutput({ success: false, error: 'unauthorized' });
    }

    if (isGatewayAuthorized_(params) && String(actor.role || '') === 'therapist' && !isTherapistGatewayWriteAllowed_(actor, action, data)) {
      return jsonOutput({ success: false, error: 'forbidden' });
    }

    if (action !== 'sendEmailNotification') {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(5000)) return jsonOutput({ success: false, error: 'busy', retryable: true });
      lockHeld = true;
    }

    const mutationId = cleanCellId_(params.mutationId || data.mutationId || '');
    if (mutationId) {
      const prior = getMutationStatus_(mutationId);
      if (prior.found && prior.status === 'verified') return jsonOutput(prior.result);
    }
    ACTIVE_ROW_INDEXES_ = {};

    let actions = [];
    let actionResult = null;
    if (action === 'batch') {
      actions = Array.isArray(data.actions) ? data.actions : [];
      if (!actions.length) throw new Error('Empty batch');
      actionResult = actions.map(item => executeAction_(String(item.action || ''), item.data || {}));
    } else {
      actions = [{ action: action, data: data }];
      actionResult = executeAction_(action, data);
    }

    bumpBootstrapCacheVersion_();
    const gatewayRequest = isGatewayAuthorized_(params);
    const cacheVersion = getBootstrapCacheVersion_();
    const changedEntities = actions.map(function(item) { return { action: item.action, id: actionEntityId_(item) }; });
    const result = { success: true, verified: gatewayRequest ? verifyGatewayActions_(actions) : false, mutationId: mutationId, changedEntities: changedEntities, cacheVersion: cacheVersion, result: actionResult };
    if (mutationId) saveMutationResult_(mutationId, result);
    return jsonOutput(result);
  } catch (err) {
    return jsonOutput({ success: false, error: String(err) });
  } finally {
    if (lockHeld && lock) lock.releaseLock();
  }
}

function flattenGatewayActions_(action, data) {
  if (action !== 'batch') return [{ action: action, data: data || {} }];
  const nested = Array.isArray(data && data.actions) ? data.actions : [];
  return nested.reduce(function(all, item) {
    return all.concat(flattenGatewayActions_(String(item && item.action || ''), item && item.data || {}));
  }, []);
}

function isTherapistGatewayWriteAllowed_(actor, action, data) {
  const actorId = cleanCellId_(actor && actor.id);
  const actions = flattenGatewayActions_(action, data);
  if (!actorId || !actions.length) return false;
  const ownAppointments = actions.filter(function(item) {
    return item.action === 'addAppointment' && cleanCellId_(item.data && item.data.therapistId) === actorId;
  }).map(function(item) { return item.data || {}; });
  return actions.every(function(item) {
    const itemData = item.data || {};
    if (item.action === 'saveSchedule') return cleanCellId_(itemData.id) === actorId;
    if (item.action === 'addAppointment') return cleanCellId_(itemData.therapistId) === actorId;
    if (item.action !== 'saveCustomer') return false;
    const key = String(itemData.phone || '');
    if (key.indexOf('SYS_APPROVAL_') === 0) {
      try { return cleanCellId_(JSON.parse(String(itemData.notes || '{}')).therapistId) === actorId; } catch (err) { return false; }
    }
    if (key.indexOf(APPOINTMENT_META_PREFIX) === 0) {
      const appointmentId = key.slice(APPOINTMENT_META_PREFIX.length);
      return ownAppointments.some(function(appt) { return String(appt.appId || appt.id || '') === appointmentId; });
    }
    return ownAppointments.some(function(appt) { return String(appt.phone || '') === key; });
  });
}

function executeAction_(action, data) {
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
  } else if (action === 'saveAdmin') {
    saveAdmin_(data);
  } else if (action === 'saveServiceRecord') {
    return saveServiceRecord_(data);
  } else if (action === 'backfillServiceRecords') {
    return backfillServiceRecords_(data);
  } else {
    throw new Error('Unknown action: ' + action);
  }
}

function getAllData() {
  initSheets();
  // Legacy-admin payload. Keep this shape during migration so existing admin
  // and frontdesk clients can read it without interruption.
  const db = { schemaVersion: 'legacy-v1', therapists: {}, schedules: {}, admins: {}, appointments: {}, customers: {} };

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

  mergeServiceRecordsIntoCustomers_(db.customers, getSheetData(SHEET_SERVICE_RECORDS));

  return db;
}

function getCoreDataWithoutRecords_(includeSystemRecords) {
  initSheets();
  const db = { therapists: {}, schedules: {}, admins: {}, appointments: {}, customers: {} };
  getSheetData(SHEET_THERAPISTS).forEach(function(row) {
    const id = cleanCellId_(row[0]);
    if (!id || id === '編號' || db.therapists[id]) return;
    db.therapists[id] = { name: String(row[1] || ''), pin: cleanPin_(row[2]) };
  });
  getSheetData(SHEET_SCHEDULES).forEach(function(row) {
    const id = cleanCellId_(row[0]);
    if (!id) return;
    try { db.schedules[id] = JSON.parse(row[1] || '{}'); } catch (err) { db.schedules[id] = {}; }
  });
  getSheetData(SHEET_APPOINTMENTS).forEach(function(row) {
    const id = cleanCellId_(row[0]);
    if (!id || id === '預約ID') return;
    db.appointments[id] = {
      id: id, date: normalizeDate_(row[1]), time: normalizeTime_(row[2]), therapistId: cleanCellId_(row[3]),
      customerName: String(row[4] || ''), phone: cleanCellId_(row[5]), service: String(row[6] || ''),
      duration: Number(row[7]) || 60, room: String(row[8] || 'R'), price: String(row[9] || ''),
      collectedPrice: String(row[10] || ''), isCompleted: String(row[11]) === 'true', notes: String(row[12] || ''),
      bookingStage: String(row[13] || ''), remittanceDue: String(row[14] || ''), remittancePaid: String(row[15]) === 'true', remittanceMethod: String(row[16] || '')
    };
  });
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CUSTOMERS);
  if (sheet && sheet.getLastRow()) {
    const systemRecordRanges = [];
    const systemKeysByRow = {};
    sheet.getRange(1, 1, sheet.getLastRow(), 3).getValues().forEach(function(row, rowIndex) {
      const key = cleanCellId_(row[0]);
      if (key) {
        db.customers[key] = { name: String(row[1] || ''), notes: String(row[2] || ''), records: [] };
        if (includeSystemRecords && key.indexOf('SYS_') === 0) {
          systemRecordRanges.push('D' + (rowIndex + 1));
          systemKeysByRow[rowIndex + 1] = key;
        }
      }
    });
    if (systemRecordRanges.length) {
      sheet.getRangeList(systemRecordRanges).getRanges().forEach(function(range) {
        const rowIndex = range.getRow();
        const key = systemKeysByRow[rowIndex];
        try { db.customers[key].records = JSON.parse(range.getValue() || '[]'); } catch (err) {}
      });
    }
  }
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
    schemaVersion: DATA_CONTRACT_VERSION,
    dataScope: 'public-client-selection',
    therapists: {},
    schedules: {},
    appointments: {},
    customers: {},
    clientSelections: {}
  };

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
  const existing = findSheetRow_(SHEET_THERAPISTS, data.id);
  const nextPin = cleanPin_(data.pin || '') || cleanPin_(existing && existing[2] || '');
  updateRow(SHEET_THERAPISTS, data.id, [
    sheetText_(data.id),
    String(data.nickname || data.name || existing && existing[1] || ''),
    sheetText_(nextPin)
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
  const key = cleanCellId_(data.phone);
  const incomingRecords = Array.isArray(data.records) ? data.records : [];
  if (key.indexOf('SYS_') !== 0) incomingRecords.forEach(function(record) { saveServiceRecord_(Object.assign({}, record, { customer_key_legacy: key })); });
  const serialized = JSON.stringify(incomingRecords);
  const records = key.indexOf('SYS_') !== 0 && serialized.length > LEGACY_RECORDS_MAX_CHARS ? '[]' : serialized;
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
  const normalizedId = cleanCellId_(id);
  const index = getRowIndex_(sheetName);
  if (index[normalizedId]) {
    sheet.getRange(index[normalizedId], 1, 1, rowData.length).setValues([rowData]);
    return;
  }
  sheet.appendRow(rowData);
  index[normalizedId] = sheet.getLastRow();
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

function ensureSheetHeader_(sheetName, headers) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow()) return;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function getRowIndex_(sheetName) {
  if (ACTIVE_ROW_INDEXES_[sheetName]) return ACTIVE_ROW_INDEXES_[sheetName];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  const index = {};
  if (sheet && sheet.getLastRow()) {
    sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().forEach(function(row, i) {
      const key = cleanCellId_(row[0]);
      if (key && !index[key]) index[key] = i + 1;
    });
  }
  ACTIVE_ROW_INDEXES_[sheetName] = index;
  return index;
}

function serviceRecordId_(data) {
  return cleanCellId_(data && (data.record_id || data.recordId || data.id || data.appointment_id || data.appointmentId)) || Utilities.getUuid();
}

function serviceRecordRow_(data) {
  const now = new Date().toISOString();
  const recordId = serviceRecordId_(data);
  return [
    sheetText_(recordId),
    sheetText_(data.appointment_id || data.appointmentId || data.id || recordId),
    sheetText_(data.customer_key_legacy || data.customerKey || data.phone || ''),
    sheetText_(data.customer_id || data.customerId || ''),
    normalizeDate_(data.date || ''),
    sheetText_(data.therapist_id || data.therapistId || ''),
    String(data.therapist_name || data.therapistName || ''),
    String(data.service || ''),
    String(data.collected_price || data.collectedPrice || ''),
    String(data.notes || ''),
    String(data.created_at || data.createdAt || now),
    now,
    SERVICE_RECORD_SCHEMA
  ];
}

function saveServiceRecord_(data) {
  const key = cleanCellId_(data && (data.customer_key_legacy || data.customerKey || data.phone || ''));
  if (!key || key.indexOf('SYS_') === 0) throw new Error('Invalid service record customer');
  const normalized = Object.assign({}, data || {});
  normalized.record_id = serviceRecordId_(normalized);
  const existingRow = getRowIndex_(SHEET_SERVICE_RECORDS)[normalized.record_id];
  if (existingRow && !normalized.created_at && !normalized.createdAt) {
    normalized.created_at = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SERVICE_RECORDS).getRange(existingRow, 11).getValue();
  }
  const row = serviceRecordRow_(normalized);
  updateRow(SHEET_SERVICE_RECORDS, row[0], row);
  return row[0];
}

function serviceRecordObject_(row) {
  return {
    id: cleanCellId_(row[0]), record_id: cleanCellId_(row[0]), appointment_id: cleanCellId_(row[1]),
    customer_key_legacy: cleanCellId_(row[2]), customer_id: cleanCellId_(row[3]), date: normalizeDate_(row[4]),
    therapistId: cleanCellId_(row[5]), therapistName: String(row[6] || ''), service: String(row[7] || ''),
    collectedPrice: String(row[8] || ''), notes: String(row[9] || ''), created_at: String(row[10] || ''),
    updated_at: String(row[11] || ''), schema_version: String(row[12] || SERVICE_RECORD_SCHEMA)
  };
}

function mergeServiceRecordsIntoCustomers_(customers, rows) {
  const latest = {};
  (rows || []).forEach(function(row) {
    const record = serviceRecordObject_(row);
    if (!record.id || record.id === 'record_id' || !record.customer_key_legacy) return;
    const key = record.customer_key_legacy + '\n' + record.id;
    if (!latest[key] || String(latest[key].updated_at) <= String(record.updated_at)) latest[key] = record;
  });
  Object.keys(latest).forEach(function(composite) {
    const record = latest[composite];
    const customer = customers[record.customer_key_legacy] || (customers[record.customer_key_legacy] = { name: '', notes: '', records: [] });
    customer.records = Array.isArray(customer.records) ? customer.records : [];
    const index = customer.records.findIndex(function(item) { return cleanCellId_(item && item.id) === record.id; });
    if (index >= 0) customer.records[index] = Object.assign({}, customer.records[index], record);
    else customer.records.push(record);
  });
}

function getGatewayCustomerRecords_(data) {
  const customerKey = cleanCellId_(data && data.customerKey);
  const role = String(data && data.role || '');
  const actorId = cleanCellId_(data && data.id);
  const limit = Math.max(1, Math.min(100, Number(data && data.limit || 50)));
  const cursor = Math.max(0, Number(data && data.cursor || 0));
  let records = getSheetData(SHEET_SERVICE_RECORDS).map(serviceRecordObject_).filter(function(record) {
    if (!record.id || record.id === 'record_id') return false;
    if (customerKey && record.customer_key_legacy !== customerKey) return false;
    return role !== 'therapist' || record.therapistId === actorId;
  });
  records.sort(function(a, b) { return String(b.date || b.updated_at).localeCompare(String(a.date || a.updated_at)); });
  return { success: true, records: records.slice(cursor, cursor + limit), nextCursor: cursor + limit < records.length ? cursor + limit : null, total: records.length };
}

function saveMutationResult_(mutationId, result) {
  updateRow(SHEET_MUTATIONS, mutationId, [sheetText_(mutationId), result.verified ? 'verified' : 'failed', JSON.stringify(result), new Date().toISOString()]);
}

function getMutationStatus_(mutationId) {
  const id = cleanCellId_(mutationId);
  if (!id) return { success: true, found: false };
  const row = findSheetRow_(SHEET_MUTATIONS, id);
  if (!row) return { success: true, found: false, mutationId: id };
  let result = null;
  try { result = JSON.parse(row[2] || '{}'); } catch (err) {}
  return { success: true, found: true, mutationId: id, status: String(row[1] || ''), result: result };
}

function actionEntityId_(item) {
  const data = item && item.data || {};
  return cleanCellId_(data.record_id || data.recordId || data.appId || data.id || data.phone || '');
}

function backfillServiceRecords_(data) {
  const cursor = Math.max(0, Number(data && data.cursor || 0));
  const limit = Math.max(1, Math.min(100, Number(data && data.limit || 100)));
  const candidates = [];
  getSheetData(SHEET_CUSTOMERS).forEach(function(row) {
    const customerKey = cleanCellId_(row[0]);
    if (!customerKey || customerKey.indexOf('SYS_') === 0) return;
    let records = [];
    try { records = JSON.parse(row[3] || '[]'); } catch (err) {}
    (records || []).forEach(function(record) {
      candidates.push(Object.assign({}, record, { customer_key_legacy: customerKey }));
    });
  });
  const slice = candidates.slice(cursor, cursor + limit);
  const customerKeys = {};
  slice.forEach(function(record) {
    saveServiceRecord_(record);
    customerKeys[cleanCellId_(record.customer_key_legacy)] = true;
  });
  return {
    processedCustomers: Object.keys(customerKeys).length,
    processedRecords: slice.length,
    totalRecords: candidates.length,
    nextCursor: cursor + limit < candidates.length ? cursor + limit : null
  };
}

function auditServiceRecords_() {
  const legacy = {};
  getSheetData(SHEET_CUSTOMERS).forEach(function(row) {
    const key = cleanCellId_(row[0]);
    if (!key || key.indexOf('SYS_') === 0) return;
    let records = [];
    try { records = JSON.parse(row[3] || '[]'); } catch (err) {}
    legacy[key] = {};
    (records || []).forEach(function(record) { if (record && record.id) legacy[key][cleanCellId_(record.id)] = comparableServiceRecord_(record); });
  });
  const modern = {};
  getSheetData(SHEET_SERVICE_RECORDS).forEach(function(row) {
    const record = serviceRecordObject_(row);
    if (!record.id || record.id === 'record_id') return;
    modern[record.customer_key_legacy] = modern[record.customer_key_legacy] || {};
    modern[record.customer_key_legacy][record.id] = comparableServiceRecord_(record);
  });
  const keys = Array.from(new Set(Object.keys(legacy).concat(Object.keys(modern))));
  const mismatches = [];
  let legacyRecords = 0;
  let modernRecords = 0;
  keys.forEach(function(key) {
    const oldMap = legacy[key] || {};
    const newMap = modern[key] || {};
    legacyRecords += Object.keys(oldMap).length;
    modernRecords += Object.keys(newMap).length;
    const ids = Array.from(new Set(Object.keys(oldMap).concat(Object.keys(newMap))));
    ids.forEach(function(id) {
      if (JSON.stringify(oldMap[id] || null) !== JSON.stringify(newMap[id] || null)) mismatches.push({ customerKey: key, recordId: id });
    });
  });
  return { success: true, customers: keys.length, legacyRecords: legacyRecords, modernRecords: modernRecords, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 100), generatedAt: new Date().toISOString() };
}

function comparableServiceRecord_(record) {
  return {
    id: cleanCellId_(record && (record.id || record.record_id)), date: normalizeDate_(record && record.date || ''),
    therapistId: cleanCellId_(record && (record.therapistId || record.therapist_id)), therapistName: String(record && (record.therapistName || record.therapist_name) || ''),
    service: String(record && record.service || ''), collectedPrice: String(record && (record.collectedPrice || record.collected_price) || ''), notes: String(record && record.notes || '')
  };
}

function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEET_THERAPISTS, SHEET_SCHEDULES, SHEET_ADMINS, SHEET_APPOINTMENTS, SHEET_CUSTOMERS, SHEET_SERVICE_RECORDS, SHEET_MUTATIONS].forEach(name => {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  ensureSheetHeader_(SHEET_SERVICE_RECORDS, ['record_id','appointment_id','customer_key_legacy','customer_id','date','therapist_id','therapist_name','service','collected_price','notes','created_at','updated_at','schema_version']);
  ensureSheetHeader_(SHEET_MUTATIONS, ['mutation_id','status','result_json','updated_at']);
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

/**
 * Install the two staff-reminder schedules. Run this once manually from the
 * Apps Script editor after adding the LINE_* Script Properties described above.
 * The 15-minute check sends an upcoming reminder once per appointment; the
 * morning trigger sends one concise overview of the current business day.
 */
function installLineReminderTriggers() {
  const properties = PropertiesService.getScriptProperties();
  if (!properties.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || !getLineRecipients_().length) {
    throw new Error('請先設定 LINE_CHANNEL_ACCESS_TOKEN 與 LINE_STAFF_RECIPIENTS Script Properties');
  }
  removeLineReminderTriggers_();
  const hour = clampNumber_(properties.getProperty('LINE_REMINDER_HOUR'), 0, 23, 9);
  ScriptApp.newTrigger('sendDailyLineStaffBrief_')
    .timeBased()
    .atHour(hour)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(LINE_REMINDER_TIMEZONE)
    .create();
  ScriptApp.newTrigger('sendUpcomingLineAppointmentAlerts_')
    .timeBased()
    .everyMinutes(15)
    .create();
}

function removeLineReminderTriggers_() {
  ['sendDailyLineStaffBrief_', 'sendUpcomingLineAppointmentAlerts_'].forEach(handler => {
    ScriptApp.getProjectTriggers().forEach(trigger => {
      if (trigger.getHandlerFunction() === handler) ScriptApp.deleteTrigger(trigger);
    });
  });
}

// Safe manual test: sends the same summary that staff receive, without adding a trigger.
function sendLineReminderNow() {
  sendDailyLineStaffBrief_();
}

function sendDailyLineStaffBrief_() {
  const now = new Date();
  const date = Utilities.formatDate(now, LINE_REMINDER_TIMEZONE, 'yyyy-MM-dd');
  const db = getAllData();
  const appointments = appointmentsForDate_(db, date);
  const text = buildDailyLineStaffBrief_(db, appointments, now);
  pushLineToStaff_(text);
}

function sendUpcomingLineAppointmentAlerts_() {
  const now = new Date();
  const date = Utilities.formatDate(now, LINE_REMINDER_TIMEZONE, 'yyyy-MM-dd');
  const leadMinutes = clampNumber_(PropertiesService.getScriptProperties().getProperty('LINE_REMINDER_LEAD_MINUTES'), 15, 180, 60);
  const db = getAllData();
  const appointments = appointmentsForDate_(db, date);
  const sent = PropertiesService.getScriptProperties();
  appointments.forEach(appt => {
    if (appt.isCompleted || !appt.time) return;
    const start = taipeiDateTime_(date, appt.time);
    const minutesAway = Math.round((start.getTime() - now.getTime()) / 60000);
    if (minutesAway < 0 || minutesAway > leadMinutes) return;
    const dedupeKey = 'LINE_APPT_ALERT_' + date + '_' + appt.id;
    if (sent.getProperty(dedupeKey)) return;
    const therapist = getTherapistDisplayName_(db, appt.therapistId);
    const message = '⏰ 即將開始\n' + appt.time + '（約 ' + minutesAway + ' 分鐘後）\n' +
      (appt.customerName || '未填姓名') + '／' + therapist + '／' + (appt.service || '未填服務') + '／' + (appt.room || '未排房');
    pushLineToStaff_(message);
    sent.setProperty(dedupeKey, Utilities.formatDate(now, LINE_REMINDER_TIMEZONE, 'yyyy-MM-dd HH:mm'));
  });
}

function appointmentsForDate_(db, date) {
  return Object.keys(db.appointments || {})
    .map(id => db.appointments[id])
    .filter(appt => appt.date === date)
    .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
}

function buildDailyLineStaffBrief_(db, appointments, now) {
  const today = Utilities.formatDate(now, LINE_REMINDER_TIMEZONE, 'M/d（E）');
  const active = appointments.filter(appt => !appt.isCompleted);
  const completed = appointments.length - active.length;
  const next = active.filter(appt => taipeiDateTime_(appt.date, appt.time).getTime() >= now.getTime()).slice(0, 3);
  const attention = active.filter(appt => !appt.customerName || !appt.therapistId || !appt.time || !appt.room);
  const lines = ['☀️ 今日營運重點｜' + today, '預約 ' + appointments.length + ' 筆｜待服務 ' + active.length + ' 筆｜已完成 ' + completed + ' 筆'];
  if (next.length) {
    lines.push('', '接下來行程：');
    next.forEach(appt => lines.push('• ' + appt.time + ' ' + (appt.customerName || '未填姓名') + '｜' + getTherapistDisplayName_(db, appt.therapistId) + '｜' + (appt.service || '未填服務') + '｜' + (appt.room || '未排房')));
  } else {
    lines.push('', '接下來行程：今日已無待服務預約');
  }
  if (attention.length) lines.push('', '⚠️ 待確認 ' + attention.length + ' 筆：缺少' + Array.from(new Set(attention.flatMap(appt => [!appt.customerName && '顧客', !appt.therapistId && '師傅', !appt.time && '時間', !appt.room && '房間'].filter(Boolean)))).join('、'));
  return lines.join('\n');
}

function getTherapistDisplayName_(db, therapistId) {
  const therapist = db.therapists && db.therapists[therapistId];
  return therapist && therapist.name ? therapist.name : (therapistId || '未排師傅');
}

function taipeiDateTime_(date, time) {
  const parts = String(time || '00:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!parts) return new Date('invalid');
  // Convert a Taiwan wall-clock date/time into an absolute moment without
  // relying on the Apps Script project's default timezone.
  return new Date(date + 'T' + String(parts[1]).padStart(2, '0') + ':' + parts[2] + ':00+08:00');
}

function getLineRecipients_() {
  return String(PropertiesService.getScriptProperties().getProperty('LINE_STAFF_RECIPIENTS') || '')
    .split(',').map(value => value.trim()).filter(Boolean);
}

// Optional self-service recipient linking. Set a long random
// LINE_STAFF_LINK_CODE Script Property, then have a staff member message that
// exact code to the official account. Their user/group ID is appended safely.
function handleLineWebhook_(payload, query) {
  const properties = PropertiesService.getScriptProperties();
  const expectedProxySecret = String(properties.getProperty('LINE_WEBHOOK_PROXY_SECRET') || '').trim();
  if (!expectedProxySecret || String(query && query.proxySecret || '') !== expectedProxySecret) {
    return { success: false, error: 'unauthorized webhook proxy' };
  }
  const expectedCode = String(properties.getProperty('LINE_STAFF_LINK_CODE') || '').trim();
  if (!expectedCode) return { success: true, ignored: true };
  (payload.events || []).forEach(event => {
    const message = event && event.message;
    const source = event && event.source || {};
    const recipientId = String(source.groupId || source.roomId || source.userId || '').trim();
    if (!message || message.type !== 'text' || String(message.text || '').trim() !== expectedCode || !recipientId) return;
    const current = getLineRecipients_();
    if (!current.includes(recipientId)) {
      current.push(recipientId);
      properties.setProperty('LINE_STAFF_RECIPIENTS', current.join(','));
    }
    if (event.replyToken) replyLine_(event.replyToken, '✅ 已加入 Morgan 小編營運提醒。');
  });
  return { success: true };
}

function pushLineToStaff_(text) {
  const token = String(PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '').trim();
  const recipients = getLineRecipients_();
  if (!token || !recipients.length) throw new Error('LINE 尚未完成設定：缺少 token 或收件者 ID');
  recipients.forEach(to => {
    const response = UrlFetchApp.fetch(LINE_PUSH_ENDPOINT, {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: String(text).slice(0, 5000) }] }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      throw new Error('LINE 推播失敗 (' + response.getResponseCode() + '): ' + response.getContentText());
    }
  });
}

function replyLine_(replyToken, text) {
  const token = String(PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '').trim();
  if (!token) return;
  UrlFetchApp.fetch(LINE_REPLY_ENDPOINT, {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true
  });
}

function clampNumber_(value, min, max, fallback) {
  const number = Number(value);
  return isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
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

function getGatewaySecret_() {
  return String(PropertiesService.getScriptProperties().getProperty('GATEWAY_SECRET') || '').trim();
}

function isGatewayAuthorized_(params) {
  const secret = getGatewaySecret_();
  if (secret.length < 24) return false;
  return String(params && params.gatewayToken || '') === secret;
}

function findSheetRow_(sheetName, key) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet || !sheet.getLastRow()) return null;
  const normalizedKey = cleanCellId_(key);
  const firstColumn = sheet.getRange(1, 1, sheet.getLastRow(), 1);
  const match = firstColumn.createTextFinder(String(normalizedKey)).matchEntireCell(true).findNext();
  if (match) return sheet.getRange(match.getRow(), 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
  const values = firstColumn.getValues();
  for (let i = 0; i < values.length; i++) {
    if (cleanCellId_(values[i][0]) === normalizedKey) {
      return sheet.getRange(i + 1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
    }
  }
  return null;
}

function pinMatches_(stored, entered) {
  const storedText = cleanPin_(stored);
  const enteredText = cleanPin_(entered);
  if (storedText === enteredText) return true;
  // Compatibility is limited to legacy numeric cells. String PINs retain
  // leading-zero identity, so "0007" is not treated as the same PIN as "7".
  if (typeof stored === 'number' && /^\d+$/.test(storedText) && /^\d+$/.test(enteredText)) {
    return storedText.replace(/^0+/, '') === enteredText.replace(/^0+/, '');
  }
  return false;
}

function authenticateGatewayUser_(data) {
  const id = cleanCellId_(data && data.id);
  const pin = cleanPin_(data && data.pin);
  if (!id || !pin) return { success: true, authenticated: false };

  const adminRow = findSheetRow_(SHEET_CUSTOMERS, ADMIN_PREFIX + id);
  if (adminRow && cleanCellId_(adminRow[0]) !== ADMIN_LOGIN_LOG_KEY && pinMatches_(adminRow[2], pin)) {
    return {
      success: true,
      authenticated: true,
      identity: { id: id, name: String(adminRow[1] || id), role: 'admin' }
    };
  }

  const legacyAdminRow = findSheetRow_(SHEET_ADMINS, id);
  if (legacyAdminRow && pinMatches_(legacyAdminRow[2], pin)) {
    return {
      success: true,
      authenticated: true,
      identity: { id: id, name: String(legacyAdminRow[1] || id), role: 'admin' }
    };
  }

  const therapistRow = findSheetRow_(SHEET_THERAPISTS, id);
  if (therapistRow && pinMatches_(therapistRow[2], pin)) {
    return {
      success: true,
      authenticated: true,
      identity: { id: id, name: String(therapistRow[1] || id), role: 'therapist' }
    };
  }
  return { success: true, authenticated: false };
}

function addDaysDateKey_(dateKey, offset) {
  const parts = String(dateKey || '').split('-').map(Number);
  const date = new Date(parts[0] || 1970, Math.max(0, (parts[1] || 1) - 1), parts[2] || 1);
  date.setDate(date.getDate() + Number(offset || 0));
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
}

function adminDirectoryFromCustomers_(customers) {
  const admins = {};
  Object.keys(customers || {}).forEach(function(key) {
    if (key.indexOf(ADMIN_PREFIX) !== 0 || key === ADMIN_LOGIN_LOG_KEY) return;
    const id = key.slice(ADMIN_PREFIX.length);
    const record = customers[key] || {};
    let email = '';
    try { email = String(record.records && record.records[0] && record.records[0].email || ''); } catch (err) {}
    admins[id] = { name: String(record.name || id), pin: '', pinConfigured: Boolean(cleanPin_(record.notes)), email: email };
  });
  return admins;
}

function sanitizeSystemCustomer_(key, record) {
  if (key === ADMIN_LOGIN_LOG_KEY || key === FRONTDESK_LOGIN_LOG_KEY || key.indexOf(ADMIN_PREFIX) === 0) return null;
  const safe = {
    name: String(record && record.name || ''),
    notes: String(record && record.notes || ''),
    records: Array.isArray(record && record.records) ? record.records : []
  };
  if (key.indexOf(THERAPIST_PROFILE_PREFIX) === 0) {
    try {
      const profile = JSON.parse(safe.notes || '{}');
      delete profile.pin;
      safe.notes = JSON.stringify(profile);
    } catch (err) {
      safe.notes = '{}';
    }
  }
  return safe;
}

function sanitizeGatewayDb_(full) {
  const safe = {
    therapists: {},
    schedules: full.schedules || {},
    admins: adminDirectoryFromCustomers_(full.customers || {}),
    appointments: full.appointments || {},
    customers: {}
  };
  Object.keys(full.therapists || {}).forEach(function(id) {
    const therapist = full.therapists[id] || {};
    safe.therapists[id] = { name: String(therapist.name || ''), pin: '', pinConfigured: Boolean(cleanPin_(therapist.pin)) };
  });
  Object.keys(full.customers || {}).forEach(function(key) {
    const record = full.customers[key] || {};
    if (key.indexOf('SYS_') === 0) {
      const systemRecord = sanitizeSystemCustomer_(key, record);
      if (systemRecord) safe.customers[key] = systemRecord;
    } else {
      safe.customers[key] = {
        name: String(record.name || ''),
        notes: String(record.notes || ''),
        records: []
      };
    }
  });
  return safe;
}

function filterCustomersForAppointments_(customers, appointments, includeSystem) {
  const selected = {};
  const appointmentIds = {};
  const phones = {};
  Object.keys(appointments || {}).forEach(function(id) {
    appointmentIds[id] = true;
    const phone = cleanCellId_(appointments[id] && appointments[id].phone);
    if (phone) phones[phone] = true;
  });
  Object.keys(customers || {}).forEach(function(key) {
    const record = customers[key] || {};
    if (key.indexOf('SYS_') === 0) {
      if (!includeSystem) return;
      if (key.indexOf(APPOINTMENT_META_PREFIX) === 0 && !appointmentIds[key.slice(APPOINTMENT_META_PREFIX.length)]) return;
      selected[key] = record;
      return;
    }
    if (!phones[key]) return;
    selected[key] = {
      name: String(record.name || ''),
      notes: String(record.notes || ''),
      records: (record.records || []).filter(function(item) { return item && appointmentIds[String(item.id || '')]; })
    };
  });
  return selected;
}

function gatewayDataForRole_(data, identity) {
  const role = String(identity && identity.role || '');
  const id = cleanCellId_(identity && identity.id);
  if (role !== 'therapist') return data;
  const appointments = {};
  Object.keys(data.appointments || {}).forEach(function(key) {
    if (cleanCellId_(data.appointments[key].therapistId) === id) appointments[key] = data.appointments[key];
  });
  const therapists = {};
  if (data.therapists[id]) therapists[id] = data.therapists[id];
  const schedules = {};
  if (data.schedules[id]) schedules[id] = data.schedules[id];
  const customers = filterCustomersForAppointments_(data.customers || {}, appointments, false);
  const appointmentIds = {};
  Object.keys(appointments).forEach(function(appointmentId) { appointmentIds[appointmentId] = true; });
  Object.keys(data.customers || {}).forEach(function(key) {
    const record = data.customers[key] || {};
    if (key === THERAPIST_PROFILE_PREFIX + id) customers[key] = record;
    if (key.indexOf(APPOINTMENT_META_PREFIX) === 0 && appointmentIds[key.slice(APPOINTMENT_META_PREFIX.length)]) {
      customers[key] = record;
    }
    if (key.indexOf('SYS_APPROVAL_') === 0) {
      try {
        if (cleanCellId_(JSON.parse(String(record.notes || '{}')).therapistId) === id) customers[key] = record;
      } catch (err) {}
    }
  });
  return {
    therapists: therapists,
    schedules: schedules,
    admins: {},
    appointments: appointments,
    customers: customers
  };
}

function getGatewayFullData_(identity) {
  const safe = sanitizeGatewayDb_(getCoreDataWithoutRecords_(String(identity && identity.role || '') === 'admin'));
  return {
    success: true,
    data: gatewayDataForRole_(safe, identity || {}),
    meta: { partial: false, generatedAt: new Date().toISOString(), source: 'google-sheets' }
  };
}

function getBootstrapCacheVersion_() {
  return String(PropertiesService.getScriptProperties().getProperty(BOOTSTRAP_CACHE_VERSION_KEY) || '1');
}

function bumpBootstrapCacheVersion_() {
  const properties = PropertiesService.getScriptProperties();
  const next = Number(properties.getProperty(BOOTSTRAP_CACHE_VERSION_KEY) || 1) + 1;
  properties.setProperty(BOOTSTRAP_CACHE_VERSION_KEY, String(next));
}

function getGatewayBootstrap_(identity) {
  const role = String(identity && identity.role || '');
  const id = cleanCellId_(identity && identity.id);
  const date = normalizeDate_(identity && identity.date || new Date());
  const version = getBootstrapCacheVersion_();
  const cacheKey = ['bootstrap-v3', version, role, id, date].join(':');
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    parsed.meta.cache = 'hit';
    return parsed;
  }

  const safe = gatewayDataForRole_(sanitizeGatewayDb_(getCoreDataWithoutRecords_()), identity || {});
  const from = addDaysDateKey_(date, -30);
  const to = addDaysDateKey_(date, 30);
  const appointments = {};
  Object.keys(safe.appointments || {}).forEach(function(key) {
    const appointment = safe.appointments[key] || {};
    if (appointment.date >= from && appointment.date <= to) appointments[key] = appointment;
  });
  const schedules = {};
  Object.keys(safe.schedules || {}).forEach(function(therapistId) {
    const schedule = safe.schedules[therapistId] || {};
    const window = {};
    Object.keys(schedule).forEach(function(day) {
      if (day >= addDaysDateKey_(date, -7) && day <= addDaysDateKey_(date, 7)) window[day] = schedule[day];
    });
    schedules[therapistId] = window;
  });
  const customers = filterCustomersForAppointments_(safe.customers || {}, appointments, role === 'admin');
  if (role === 'therapist') {
    const profileKey = THERAPIST_PROFILE_PREFIX + id;
    if (safe.customers && safe.customers[profileKey]) customers[profileKey] = safe.customers[profileKey];
    Object.keys(safe.customers || {}).forEach(function(key) {
      if (key.indexOf('SYS_APPROVAL_') === 0) customers[key] = safe.customers[key];
      if (key.indexOf(APPOINTMENT_META_PREFIX) === 0 && appointments[key.slice(APPOINTMENT_META_PREFIX.length)]) {
        customers[key] = safe.customers[key];
      }
    });
  }
  const data = {
    therapists: safe.therapists || {},
    schedules: schedules,
    admins: role === 'admin' ? safe.admins || {} : {},
    appointments: appointments,
    customers: customers
  };
  const response = {
    success: true,
    data: data,
    meta: { partial: true, cache: 'miss', generatedAt: new Date().toISOString(), from: from, to: to, source: 'google-sheets' }
  };
  const serialized = JSON.stringify(response);
  if (serialized.length < 90000) cache.put(cacheKey, serialized, BOOTSTRAP_CACHE_TTL_SECONDS);
  return response;
}

function saveAdmin_(data) {
  if (!data || !data.id) throw new Error('Missing admin id');
  const key = ADMIN_PREFIX + cleanCellId_(data.id);
  const existing = findSheetRow_(SHEET_CUSTOMERS, key) || [];
  let records = [];
  try { records = JSON.parse(existing[3] || '[]'); } catch (err) { records = []; }
  const email = String(data.email || records[0] && records[0].email || '');
  const pin = cleanPin_(data.pin || '') || cleanPin_(existing[2] || '');
  if (!pin) throw new Error('Admin PIN is required');
  saveCustomer({
    phone: key,
    name: String(data.name || existing[1] || data.id),
    notes: sheetText_(pin),
    records: [{ email: email }]
  });
}

function verifyGatewayAction_(item) {
  const action = String(item && item.action || '');
  const data = item && item.data || {};
  if (action === 'saveCustomer') {
    const row = findSheetRow_(SHEET_CUSTOMERS, data.phone);
    if (!row) return false;
    return String(row[1] || '') === String(data.name || '') && String(row[2] || '') === String(data.notes || '');
  }
  if (action === 'deleteCustomer') return !findSheetRow_(SHEET_CUSTOMERS, data.phone);
  if (action === 'addAppointment') {
    const row = findSheetRow_(SHEET_APPOINTMENTS, data.appId || data.id);
    return !!row && normalizeDate_(row[1]) === normalizeDate_(data.date) && cleanCellId_(row[3]) === cleanCellId_(data.therapistId);
  }
  if (action === 'deleteAppointment') return !findSheetRow_(SHEET_APPOINTMENTS, data.appId || data.id);
  if (action === 'saveSchedule') {
    const row = findSheetRow_(SHEET_SCHEDULES, data.id);
    if (!row) return false;
    let actual = {};
    try { actual = JSON.parse(row[1] || '{}'); } catch (err) {}
    return Object.keys(data.schedule || {}).every(function(day) { return String(actual[day] || '') === String(data.schedule[day] || ''); });
  }
  if (action === 'addTherapist' || action === 'updatePin') {
    const row = findSheetRow_(SHEET_THERAPISTS, data.id);
    return !!row && (!data.pin || pinMatches_(row[2], data.pin));
  }
  if (action === 'deleteTherapist') return !findSheetRow_(SHEET_THERAPISTS, data.id);
  if (action === 'saveAdmin') {
    const row = findSheetRow_(SHEET_CUSTOMERS, ADMIN_PREFIX + cleanCellId_(data.id));
    return !!row && (!data.pin || pinMatches_(row[2], data.pin));
  }
  if (action === 'saveServiceRecord') {
    const row = findSheetRow_(SHEET_SERVICE_RECORDS, serviceRecordId_(data));
    return !!row && cleanCellId_(row[2]) === cleanCellId_(data.customer_key_legacy || data.customerKey || data.phone);
  }
  return action === 'repairTherapists' || action === 'sendEmailNotification' || action === 'backfillServiceRecords';
}

function verifyGatewayActions_(actions) {
  return (actions || []).every(function(item) {
    if (item && item.action === 'batch') return verifyGatewayActions_(item.data && item.data.actions || []);
    return verifyGatewayAction_(item);
  });
}

function getApiSecret_() {
  return String(PropertiesService.getScriptProperties().getProperty('API_SECRET') || '').trim();
}

function isAuthorized_(params) {
  const secret = getApiSecret_();
  if (!secret) return true;
  return String(params && (params.token || params.apiToken) || '') === secret;
}
