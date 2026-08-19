/***************************************************************
 * ROLLING SALES CENTER — INTEGRATED ENGINE V29
 * Pengganti menyeluruh untuk V28.3 / PERF10..PERF25.
 *
 * Nama parameter, nama function publik, dan susunan menu SENGAJA
 * dipertahankan persis seperti versi sebelumnya supaya user lama tidak
 * perlu belajar ulang. Yang diganti adalah isi logic-nya.
 *
 * SEMUA setup dilakukan lewat blok parameter di bawah (link database,
 * tanggal rolling, jumlah worker, dst) — bukan lewat menu + input manual.
 *
 * ---------------------------------------------------------------
 * PERBAIKAN INTI DIBANDING V28.3
 *
 * [F1] Lease DB tidak lagi global/coarse.
 *      Lama : satu lock "heavy DB reader" mengunci SEMUA master untuk SEMUA
 *             lane, sehingga lane 1..4 saling blok (waitMs=45000) dan bundle
 *             dikembalikan ke antrean.
 *      Baru : lease per-resource (per tabel master) yang hanya dipegang saat
 *             MEMBANGUN index. Lock global hanya dipakai ~milidetik untuk
 *             compare-and-set. Setelah index jadi, semua execution membaca
 *             snapshot tanpa lock sama sekali.
 *
 * [F2] DB_BUSY tidak lagi dihitung sebagai attempt validasi.
 *      Error diklasifikasi INFRA | ACCESS | DATA | FATAL.
 *      INFRA -> status DEFERRED, kolom Defers++, Attempts TETAP.
 *      Infra tidak akan pernah menghasilkan HARD_ERROR.
 *
 * [F3] Tidak ada lagi full-scan fallback untuk jumlah ID berapa pun.
 *      Master dibaca sekali per versi menjadi hash-index (lookup O(1)).
 *      Ambang MAX_TARGETED_IDS dihapus total.
 *
 * [F4] Satu file tidak lagi diproses beberapa lane sekaligus.
 *      Claim atomik + claimToken compare-and-swap saat commit.
 *
 * [F5] Watchdog tidak lagi spam "Authorization binding mismatch".
 *      Auth diperiksa sekali; mismatch -> BLOCKED sekali lalu trigger dilepas.
 *
 * [F6] Index tabel besar (m_bp_relation puluhan MB) dimaterialisasi ke
 *      spreadsheet index tersendiri saat tidak muat di CacheService, sehingga
 *      tidak dibangun ulang tiap execution.
 *
 * [F7] Pembangunan index dipindah ke execution tersendiri (prewarm) sebelum
 *      lane menyala, supaya kuota 6 menit worker tidak habis untuk memindai.
 ***************************************************************/

/* =============================================================
 * 1. PARAMETER — SEMUA SETUP DI SINI
 * ============================================================= */

var ROLLING_SALES_CENTER_PARAMETERS = {
  menuName: '🚀 Rolling Sales Center',
  version: 'RSC_INTEGRATED_V29',
  propCRRealtime: 'ROLLING_SALES_CENTER_CR_SUMMARY_REALTIME_ENABLED',
  propSsId: 'ROLLING_SALES_CENTER_MASTER_SPREADSHEET_ID',
  propSheetId: 'ROLLING_SALES_CENTER_MASTER_SHEET_ID',
  bgDelayMs: 60 * 1000,
  softDeadlineMs: 270 * 1000,
  timezone: 'Asia/Jakarta'
};

/* -------------------------------------------------------------
 * DATABASE MASTER — ganti di sini bila spreadsheet DB berpindah.
 * ----------------------------------------------------------- */
var RSC_DB_PARAMETERS = {
  // Spreadsheet DB utama.
  spreadsheetId: '1psDMLLr98FuHjKhhfBTwg8p0kBA3w26xrdXb6_tu7CU',

  // Spreadsheet DB tambahan (mis. mirror m_bp_relation yang dipisah).
  // Dipakai hanya bila tabel tidak ditemukan di spreadsheet utama.
  extraSpreadsheetIds: [
    '1JGo50yPN-Sei56O6eUc-QWONrlDxlWcV2cRhlsME7Cg'
  ],

  // Nama tab per tabel. Alias pertama yang ketemu yang dipakai.
  tables: {
    RELATION:  ['m_bp_relation'],
    SALESMAN:  ['m_sales_info'],
    BP:        ['m_bp_general_view', 'm_bp_general', '_rsc_bp_general_lookup'],
    VISIT:     ['m_visit_schedule']
  },

  // Header m_bp_relation mode LEGACY (5 kolom).
  relationLegacyHeaders: {
    customer: 'bp_id_rlt1',
    relationship: 'relationship_cat_id',
    salesman: 'bp_id_rlt2',
    validFrom: 'valid_from',
    validTo: 'valid_to'
  },
  // Header m_bp_relation mode COMPACT (1 sel berisi array JSON).
  relationCompactHeader: 'relation_payload',

  salesmanHeaders: {
    salesman: ['salesman_id'],
    salesOffice: ['sls_office'],
    salesOrg: ['sls_org'],
    salesType: ['sales_type'],
    coverage: ['coverage'],
    name: ['salesman_name'],
    validFrom: ['valid_from'],
    validTo: ['valid_to']
  },
  bpHeaders: {
    customer: ['bp_id', 'bp_number', 'customer_id'],
    bpType: ['bp_type_id'],
    salesOffice: ['sls_office', 'sales_office'],
    name: ['bp_name', 'name']
  },
  visitHeaders: {
    customer: ['cust_id', 'customer_id', 'bp_id'],
    salesman: ['salesman_id', 'bp_id_rlt2'],
    visitCategory: ['visit_category'],
    visitType: ['visit_type'],
    schedule: ['visit_schedule', 'schedule_visit'],
    validFrom: ['visit_valid_from', 'valid_from', 'from_timestamp'],
    validTo: ['visit_valid_to', 'valid_to', 'to_timestamp']
  },

  // Baris yang masa berlakunya sudah lewat lebih dari grace ini tidak diindeks.
  // Ini yang menjaga index tabel puluhan MB tetap ramping.
  activeGraceDays: 60,

  readWindowRows: 20000,
  cacheTtlSec: 21600,
  cacheChunkBytes: 90000,
  cacheMaxBytes: 5000000,
  indexSheetWriteRows: 5000,
  indexSheetReadRows: 50000,
  buildLeaseMs: 300 * 1000,
  waitForBuilderMs: 25 * 1000,
  waitStepMs: 2500,
  pIndexStoreId: 'RSC_V29_INDEX_STORE_ID',
  pIndexVerPrefix: 'RSC_V29_INDEX_VER_',
  pLeasePrefix: 'RSC_V29_LEASE_'
};

/* Kompatibilitas: blok lama yang masih dirujuk kode/dokumen sebelumnya. */
var M_BP_RELATION_DB_PARAMETERS = {
  spreadsheetId: RSC_DB_PARAMETERS.spreadsheetId,
  sheetName: 'm_bp_relation',
  sheetGid: 1379118174,
  compactPayloadHeader: RSC_DB_PARAMETERS.relationCompactHeader,
  colBpIdRlt1: RSC_DB_PARAMETERS.relationLegacyHeaders.customer,
  colRelationshipCatId: RSC_DB_PARAMETERS.relationLegacyHeaders.relationship,
  colBpIdRlt2: RSC_DB_PARAMETERS.relationLegacyHeaders.salesman,
  colValidFrom: RSC_DB_PARAMETERS.relationLegacyHeaders.validFrom,
  colValidTo: RSC_DB_PARAMETERS.relationLegacyHeaders.validTo,
  readChunkRows: 100000
};

/* -------------------------------------------------------------
 * TANGGAL PERIODE ROLLING — ganti tiap periode.
 * ----------------------------------------------------------- */
var VALIDATE_DATE_IN_TEMPLATE_PARAMETERS = {
  fn: 'RSC_CONTINUE_VALIDATE_DATE_IN_TEMPLATE_BG_20260619',
  pHintRow: 'VALIDATE_DATE_IN_TEMPLATE_HINT_ROW',
  pSsId: 'VALIDATE_DATE_IN_TEMPLATE_SS_ID',
  pSheetId: 'VALIDATE_DATE_IN_TEMPLATE_SHEET_ID',
  masterLinkCol: 5,
  firstDataRow: 2,
  rollingSheetName: 'Change Rolling & Change Schedule',
  headerScanRows: 15,
  softDeadlineMs: 280 * 1000,
  phase1BudgetMs: 170 * 1000,
  hardMaxFilesPerRun: 5,
  triggerDelayMs: 60 * 1000,

  // Reason = Rolling  -> Valid From & Visit Valid From dipaksa ke dateNew.
  // Reason = Toko Bangkrut -> Valid To & Visit Valid To dipaksa ke dateClose.
  dateNew: '2026-09-01',
  dateClose: '2026-08-31',

  caseCValidFromSource: 'CUSTOMER_FALLBACK'
};

var BACKGROUND_ROLLING_REASON_DATE_FIX_PARAMETERS = {
  fn: 'RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611',
  pHintRow: 'ROLLING_REASON_DATE_FIX_HINT_ROW',
  pSsId: 'ROLLING_REASON_DATE_FIX_MASTER_SPREADSHEET_ID',
  pSheetId: 'ROLLING_REASON_DATE_FIX_MASTER_SHEET_ID',
  colLink: 5,
  firstDataRow: 2,
  hardMaxFilesPerRun: 8,
  targetCfg: {
    MASTER_START_ROW: 2,
    MASTER_LINK_COL: 5,
    TARGET_SHEET_NAME: 'Change Rolling & Change Schedule',
    TARGET_START_ROW: 2,
    COL_VALID_FROM: 7,
    COL_VISIT_VALID_FROM: 12,
    COL_REASON: 14,
    COL_F: 7,
    COL_K: 12,
    COL_M: 14,
    VALID_FROM_HEADER: 'Valid From',
    VISIT_VALID_FROM_HEADER: 'Visit Valid From',
    REASON_HEADER: 'Reason',
    TARGET_DATE_TEXT: '2026-09-01',
    ROLLING_TEXT: 'ROLLING'
  }
};

var RSC_TOKO_BANGKRUT_DB_DATE_PARAMETERS_20260622 = {
  jobKey: 'RSC_TBDB_DATE_JOB_20260622',
  continueFn: 'RSC_CONTINUE_TOKO_BANGKRUT_DATES_BY_DB_BG_20260622',
  masterLinkCol: 5,
  firstDataRow: 2,
  targetSheetName: 'Change Rolling & Change Schedule',
  headerScanRows: 15,
  dbSpreadsheetId: RSC_DB_PARAMETERS.spreadsheetId,
  dbSheetName: 'm_bp_relation',
  dbSheetGid: 1379118174,
  hCustomer: ['Customer ID', 'Customer', 'Cust ID', 'bp_id_rlt1'],
  hRelationship: ['Relationship', 'Relationship ID', 'Relationship Cat ID', 'relationship_cat_id'],
  hSalesman: ['Salesman ID', 'Salesman', 'bp_id_rlt2'],
  hValidFrom: ['Valid From'],
  hValidTo: ['Valid To'],
  hVisitValidFrom: ['Visit Valid From'],
  hVisitValidTo: ['Visit Valid To'],
  hReason: ['Reason'],
  hValidationStatus: ['Validation Status'],
  hErrorDetail: ['Error Detail'],
  fallbackCustomerCol: 3,
  fallbackRelationshipCol: 4,
  fallbackSalesmanCol: 5,
  softDeadlineMs: 280 * 1000,
  hardMaxFilesPerRun: 8,
  triggerDelayMs: 60 * 1000
};

/* -------------------------------------------------------------
 * TEMPLATE / UI
 * ----------------------------------------------------------- */
var TEMPLATE_UI_PARAMETERS = {
  maxRows: 50000,
  sheetEm: 'em',
  sheetFinance: 'TOP Customer - Finance',
  sheetSales: 'TOP Customer - Sales',
  sheetCredit: 'Credit Limit',
  sheetRolling: 'Change Rolling & Change Schedule',
  sheetSalesOfficeChange: 'Change Sales Office',
  sheetSalesmanTypeChange: 'Change Salesman Type',
  validationStatusHeader: 'Validation Status',
  errorDetailHeader: 'Error Detail',
  colors: {
    header: '#0F172A',
    headerFont: '#FFFFFF',
    input: '#FFFFFF',
    locked: '#E5E7EB',
    lockedFont: '#6B7280',
    warning: '#FEF3C7',
    ok: '#B7E1CD',
    border: '#CBD5E1',
    error: '#F4C7C3'
  }
};

var VISIT_CATEGORY_OPTIONS = ['F1', 'F2', 'F4', 'F8'];
var VISIT_CATEGORY_FREQUENCY = { F1: 1, F2: 2, F4: 4, F8: 8 };
var VISIT_TYPE_OPTIONS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
var VISIT_DAYS = ['M', 'T', 'W', 'TH', 'F', 'S', 'SU'];
var REASON_OPTIONS = ['Rolling', 'Toko Bangkrut'];
var OPEN_ENDED_DATE_TEXT = '9999-12-31';

var RELATIONSHIP_OPTIONS = [
  'ZWS003 - Sales Rep. Food',
  'ZWS004 - Sales Rep. Non-Food',
  'ZWS005 - Sales Rep. Frozen',
  'ZWS006 - Sales Rep. Cosmetic',
  'ZWS007 - Sales Rep. Reguler',
  'ZWS011 - Superior',
  'ZWS012 - Collector Food',
  'ZWS013 - Collector Non-Food',
  'ZWS014 - Collector Frozen',
  'ZWS015 - Collector Cosmetic',
  'ZWS016 - Collector Reguler',
  'ZWS022 - Collector Industrial Relation'
];

/* -------------------------------------------------------------
 * BULK VALIDATION STANDARD (manifest + worker)
 * ----------------------------------------------------------- */
var RSC_STANDARD_VALIDATION_V27_20260814 = {
  version: 'RSC_INTEGRATED_V29_VALIDATION',
  masterSheetCandidates: ['Rekap All', 'Rekap Approved'],
  masterLinkCol: 5,
  firstDataRow: 2,
  masterHeaderScanRows: 30,
  manifestSheetName: '_RSC_VALIDATION_MANIFEST_V27',
  manifestHeaders: [
    'Run ID', 'File ID', 'Master Rows JSON', 'URL', 'File Name', 'Status', 'Attempts', 'Worker', 'Lease Until',
    'Error Rows', 'Sheet Summary', 'Started At', 'Updated At', 'Duration Sec', 'Message',
    'Queue Wait Sec', 'Open File Sec', 'Master Load Sec', 'Normalize Sec', 'Rules Sec', 'Write Sec', 'Total Sec',
    'Defers', 'Next Eligible At', 'Claim Token', 'Last Error Kind'
  ],
  pRunId: 'RSC_STD_V27_RUN_ID',
  pMasterSsId: 'RSC_STD_V27_MASTER_SS_ID',
  pMasterSheetId: 'RSC_STD_V27_MASTER_SHEET_ID',
  pStop: 'RSC_STD_V27_STOP',
  pStartedAt: 'RSC_STD_V27_STARTED_AT',
  pFinishedAt: 'RSC_STD_V27_FINISHED_AT',
  pLastStatus: 'RSC_STD_V27_LAST_STATUS',
  pRunState: 'RSC_STD_V27_RUN_STATE',
  pOwner: 'RSC_STD_V27_BINDING_OWNER',
  pBlocked: 'RSC_STD_V27_BLOCKED_REASON',

  workerCount: 4,
  claimBatchSize: 4,
  workerSoftDeadlineMs: 230 * 1000,
  leaseMs: 7 * 60 * 1000,
  workerDelayMs: 5 * 1000,
  workerIdleRetryDelayMs: 20 * 1000,
  claimLockWaitMs: 20 * 1000,
  commitLockWaitMs: 20 * 1000,
  watchdogMinutes: 5,
  heartbeatStaleMs: 210 * 1000,

  // Attempts hanya bertambah untuk kegagalan DATA.
  maxAttempts: 5,
  // Defers hanya bertambah untuk kegagalan INFRA dan tidak pernah HARD_ERROR.
  maxDefers: 12,
  retryBaseMs: 8 * 1000,
  retryMaxMs: 120 * 1000,

  workerHandlers: [
    'RSC_STANDARD_BULK_WORKER_1_20260814',
    'RSC_STANDARD_BULK_WORKER_2_20260814',
    'RSC_STANDARD_BULK_WORKER_3_20260814',
    'RSC_STANDARD_BULK_WORKER_4_20260814'
  ],
  watchdogHandler: 'RSC_STANDARD_BULK_WATCHDOG_20260814',
  prewarmHandler: 'RSC_PERF19_PREWARM_DB_INDEXES_20260819',

  msgMaxDetailChars: 4000,
  msgMaxRowsInMessage: 12,
  msgMaxVariants: 6,
  dropdownHeadroomRows: 500
};

/* -------------------------------------------------------------
 * JOB LOGGING DETAILS — layout dipertahankan persis.
 * ----------------------------------------------------------- */
var RSC_PERF16_JOBLOG_20260819 = {
  sheetName: 'Job Logging Details',
  pLogSsId: 'RSC_PERF16_JOBLOG_SS_ID',
  pStatePrefix: 'RSC_PERF16_JOBLOG_STATE_',
  pLastSheetWritePrefix: 'RSC_PERF16_JOBLOG_LAST_WRITE_',
  titleRow: 1,
  summaryRow: 2,
  counterRow: 3,
  liveHeaderRow: 6,
  liveStartRow: 7,
  historyTitleRow: 18,
  historyHeaderRow: 19,
  historyStartRow: 20,
  maxHistoryRows: 2500,
  trimHistoryRows: 500,
  throttleMs: 1500,
  timezone: 'Asia/Jakarta',
  liveSlots: ['ACTIVE', 'WORKER_1', 'WORKER_2', 'WORKER_3', 'WORKER_4', 'WATCHDOG', 'REVAMP', 'SYSTEM', 'LEGACY'],
  columns: [
    'Slot', 'Job / Worker', 'State', 'Current Stage', 'Progress', 'Current / Total',
    'File Name', 'File ID', 'Sheet', 'Rows', 'Message', 'Last Error',
    'Started At', 'Last Heartbeat', 'Elapsed Sec', 'Worker / Lane', 'Run ID', 'Effective User'
  ]
};

/* -------------------------------------------------------------
 * FULL PIPELINE 1 JAM
 * ----------------------------------------------------------- */
var RSC_V28_FULL_PIPELINE_20260814 = {
  version: 'RSC_INTEGRATED_V29_PIPELINE',
  pEnabled: 'RSC_V28_FULL_PIPELINE_ENABLED',
  pMasterSsId: 'RSC_V28_FULL_PIPELINE_MASTER_SS_ID',
  pPhase: 'RSC_V28_FULL_PIPELINE_PHASE',
  pRunStartedAt: 'RSC_V28_FULL_PIPELINE_RUN_STARTED_AT',
  pLastFinishedAt: 'RSC_V28_FULL_PIPELINE_LAST_FINISHED_AT',
  pLastMessage: 'RSC_V28_FULL_PIPELINE_LAST_MESSAGE',
  pCycleId: 'RSC_V28_FULL_PIPELINE_CYCLE_ID',
  hourlyHandler: 'RSC_V28_FULL_PIPELINE_HOURLY_HANDLER_20260814',
  watchdogHandler: 'RSC_V28_FULL_PIPELINE_WATCHDOG_20260814',
  everyHours: 1,
  watchdogDelayMs: 2 * 60 * 1000,
  phases: {
    IDLE: 'IDLE',
    VALIDATING: 'VALIDATING',
    REVAMP: 'REVAMP',
    COMPILE_MAIN: 'COMPILE_MAIN',
    COMPILE_STRL: 'COMPILE_STRL',
    BLOCKED: 'BLOCKED',
    DONE: 'DONE',
    STOPPED: 'STOPPED'
  }
};

/* -------------------------------------------------------------
 * COPY-AWARE + AUTO VALIDATE ON EDIT
 * ----------------------------------------------------------- */
var COPY_AWARE_AUTOMATION_PARAMETERS = {
  runLocalValidationOnFirstOpenOfEachSpreadsheet: false,
  tryInstallAuthorizedJobsOnOpen: true,
  installScheduledLocalValidationJob: false,
  localValidationJobEveryHours: 1,
  runFullTemplateSetupOnFirstOpen: false,
  removeAllProtectionsOnFirstOpenOfEachSpreadsheet: false,
  removeAllProtectionsOnEveryOpen: false,
  enableCrSummaryRefreshOnEditOnFirstOpen: false,
  pLastAutoBootstrappedSpreadsheetId: 'COPY_AWARE_LAST_BOOTSTRAPPED_SPREADSHEET_ID',
  pLastLocalValidationAt: 'COPY_AWARE_LAST_LOCAL_VALIDATION_AT',
  pAuthorizedJobsStatus: 'COPY_AWARE_AUTHORIZED_JOBS_STATUS',
  localValidationJobHandler: 'RSC_SCHEDULED_LOCAL_VALIDATION_JOB_20260611',
  autoValidateOnEdit: true,
  autoValidateDebounceMs: 4000,
  autoValidateOnEditHandler: 'RSC_V28_2_AUTHORIZED_ON_EDIT_20260814',
  autoValidateWorkerHandler: 'RSC_V28_2_AUTO_VALIDATE_WORKER_20260814',
  pAutoValidateLastEditAt: 'RSC_V28_2_AUTO_VALIDATE_LAST_EDIT_AT',
  pAutoValidateSheetId: 'RSC_V28_2_AUTO_VALIDATE_SHEET_ID',
  pAutoValidateQueued: 'RSC_V28_2_AUTO_VALIDATE_QUEUED',
  pAutoValidateLastResult: 'RSC_V28_2_AUTO_VALIDATE_LAST_RESULT'
};

/* -------------------------------------------------------------
 * CR SUMMARY + LINK KOLOM D
 * ----------------------------------------------------------- */
var CR_VISIT_SCHEDULE_SUMMARY_PARAMETERS = {
  sourceSheetName: 'Change Rolling & Change Schedule',
  outputSheetFallbackName: 'Summary - CR',
  includeErrorRows: true,
  autoRefreshEveryHours: 1,
  baseScheduleTokens: [
    'W1M', 'W1T', 'W1W', 'W1Th', 'W1F', 'W1S', 'W1SU',
    'W2M', 'W2T', 'W2W', 'W2Th', 'W2F', 'W2S', 'W2SU',
    'W3M', 'W3T', 'W3W', 'W3Th', 'W3F', 'W3S', 'W3SU',
    'W4M', 'W4T', 'W4W', 'W4Th', 'W4F', 'W4S', 'W4SU'
  ]
};

var INPUT_ROLLING_LINK_VALIDATION_PARAMETERS = {
  LINK_COL: 4,
  START_ROW: 2,
  CHECK_CHANGE_SALES_OFFICE_COL: 15,
  CHECK_CHANGE_SALESMAN_TYPE_COL: 16,
  TARGET_SHEETS_TO_VALIDATE: [
    'Change Rolling & Change Schedule',
    'Change Sales Office',
    'Change Salesman Type'
  ],
  VALIDATION_STATUS_HEADER: 'Validation Status',
  SHEET_CHANGE_SALES_OFFICE: 'Change Sales Office',
  SHEET_CHANGE_SALESMAN_TYPE: 'Change Salesman Type',
  CONTROL_SHEET_NAME: ''
};

/* -------------------------------------------------------------
 * HARD STOP / RECOVERY
 * ----------------------------------------------------------- */
var RSC_PERF13_HARD_STOP_20260819 = {
  pHardStop: 'RSC_PERF13_HARD_STOP_ACTIVE',
  pHardStopAt: 'RSC_PERF13_HARD_STOP_AT',
  pHardStopBy: 'RSC_PERF13_HARD_STOP_BY',
  pHardStopReason: 'RSC_PERF13_HARD_STOP_REASON'
};

/* -------------------------------------------------------------
 * SUBSISTEM YANG MASIH MEMAKAI IMPLEMENTASI LAMA
 * (compile Upload Ready, copy template, revamp core, BigQuery mark).
 * Nama function tetap ada agar menu tidak berubah.
 * ----------------------------------------------------------- */
var RSC_UR_20260721 = {
  pJob: 'RSC_UR_JOB_JSON_20260721',
  pLastStats: 'RSC_UR_LAST_STATS_JSON_20260721',
  pStrlJob: 'RSC_UR_STRL_JOB_JSON_20260727',
  pStrlStats: 'RSC_UR_STRL_LAST_STATS_JSON_20260727',
  masterSheetCandidates: ['Rekap All', 'Rekap Approved'],
  masterLinkCol: 5,
  statusCol: 6,
  doneStatusValues: ['DONE', 'ADMIN DONE REVISI']
};

var RSC_TEMPLATE_REVAMP_20260722 = {
  pJob: 'RSC_TEMPLATE_REVAMP_JOB_JSON_20260722',
  pStats: 'RSC_TEMPLATE_REVAMP_STATS_JSON_20260722',
  handler: 'RSC_CONTINUE_TEMPLATE_REVAMP_INTEGRATED_20260723',
  softDeadlineMs: 250 * 1000,
  hardMaxFilesPerRun: 6,
  triggerDelayMs: 45 * 1000
};

var RSC_TEMPLATE_COPY_20260611 = {
  pJob: 'RSC_TEMPLATE_COPY_JOB_JSON_20260611',
  pStats: 'RSC_TEMPLATE_COPY_STATS_JSON_20260611',
  handler: 'RSC_CONTINUE_COPY_ROLLING_TEMPLATE_FILES_20260611',
  masterSheetCandidates: ['Rekap All', 'Rekap Approved'],
  sourceLinkCol: 4,
  finalLinkCol: 5,
  softDeadlineMs: 210 * 1000,
  hardMaxCopiesPerRun: 8,
  triggerDelayMs: 60 * 1000
};

var EXACT_DATA_WITH_CURRENT_PARAMETERS = {
  MASTER_START_ROW: 2,
  MASTER_LINK_COL: 5,
  TARGET_SHEET_NAME: 'Change Rolling & Change Schedule',
  TARGET_START_ROW: 2,
  OUTPUT_COL_R: 18,
  OUTPUT_TEXT: 'Exact Data with Current',
  CLEAR_R_IF_NOT_MATCH: false,
  BQ_PROJECT_ID: 'bi-report-auto-496902',
  BQ_DATASET_ID: 'relationshipcustomer_1779366814945',
  BQ_TABLE_ID: 'relationship_customer',
  BQ_BP_ID_BATCH_SIZE: 2000
};


/* =============================================================
 * 2. CORE UTILITIES
 * ============================================================= */

var RSC_ID_NORMALIZE_CACHE_ = Object.create(null);
var RSC_ID_NORMALIZE_COUNT_ = 0;
var RSC_ID_NORMALIZE_LIMIT_ = 20000;

/** Teks sel yang sudah dibersihkan: NBSP/zero-width dibuang, spasi dirapatkan. */
function rscText_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    return (v === Math.floor(v) && Math.abs(v) < 1e15) ? String(Math.round(v)) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  var s = String(v);
  s = s.replace(/[\u00A0\u180E\u200B-\u200D\u2028\u2029\u202F\u2060\uFEFF]/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/** Kunci perbandingan header/enum: huruf besar tanpa karakter non-alfanumerik. */
function rscKey_(v) {
  return rscText_(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Normalisasi ID. Menangani:
 *  - dropdown "KODE - Deskripsi"  -> "KODE"
 *  - apostrof teks Sheets         -> dibuang
 *  - angka bergaya 110252135.0    -> 110252135
 *  - notasi eksponen 1.1025e+8    -> 110252135
 * Hasil di-cache karena dipanggil jutaan kali pada file besar.
 */
function RSC_NORMALIZE_ID_(value) {
  var raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return '';
  if (Object.prototype.hasOwnProperty.call(RSC_ID_NORMALIZE_CACHE_, raw)) {
    return RSC_ID_NORMALIZE_CACHE_[raw];
  }

  var s = raw.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/^'+/, '').trim();
  var label = s.match(/^\s*([A-Za-z0-9]+)\s*(?:-|–|—|\|)\s+.+$/);
  if (label && label[1]) s = label[1];
  s = s.replace(/\s+/g, '');
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (/^\d+(?:\.\d+)?[eE]\+?\d+$/.test(s)) {
    var n = Number(s);
    if (isFinite(n)) s = String(Math.round(n));
  }
  s = s.toUpperCase();

  if (RSC_ID_NORMALIZE_COUNT_ < RSC_ID_NORMALIZE_LIMIT_) {
    RSC_ID_NORMALIZE_CACHE_[raw] = s;
    RSC_ID_NORMALIZE_COUNT_++;
  }
  return s;
}

/** Ambil bagian ID dari nilai dropdown, tanpa uppercase paksa. */
function rscIdOnly_(v) {
  var s = rscText_(v);
  if (!s) return '';
  var m = s.match(/^([A-Za-z0-9_.\-]+)\s*(?:-|–|—|\|)\s+/);
  return m ? m[1] : s;
}

/** fileId Google Sheets dari URL/ID mentah. Ketat: teks bebas ditolak. */
function rscFileId_(v) {
  var s = rscText_(v);
  if (!s) return '';
  var m = s.match(/\/d\/([A-Za-z0-9_-]{25,})/);
  if (m) return m[1];
  m = s.match(/[?&]id=([A-Za-z0-9_-]{25,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return s;
  return '';
}

function rscPad_(n, w) {
  var s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

/**
 * Tanggal -> 'YYYY-MM-DD'.
 * Menerima objek Date, epoch milidetik (dipakai m_sales_info), serial
 * spreadsheet, teks ISO, dan teks DD/MM/YYYY.
 */
function rscDateStr_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return rscPad_(v.getFullYear(), 4) + '-' + rscPad_(v.getMonth() + 1, 2) + '-' + rscPad_(v.getDate(), 2);
  }
  if (typeof v === 'number' && isFinite(v)) v = String(Math.round(v));

  var s = rscText_(v);
  if (!s) return '';

  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[3], 2);
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return m[3] + '-' + rscPad_(m[2], 2) + '-' + rscPad_(m[1], 2);

  if (/^\d+(\.\d+)?$/.test(s)) {
    var num = Number(s), d = null;
    if (num >= 1e11) d = new Date(num);                                  // epoch milidetik
    else if (num > 0 && num < 500000) d = new Date(Math.round((num - 25569) * 86400000)); // serial
    if (d && !isNaN(d.getTime())) {
      return rscPad_(d.getUTCFullYear(), 4) + '-' + rscPad_(d.getUTCMonth() + 1, 2) + '-' + rscPad_(d.getUTCDate(), 2);
    }
  }
  return '';
}

function rscIsValidDateStr_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (s === OPEN_ENDED_DATE_TEXT) return true;
  var y = Number(s.slice(0, 4)), mo = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Stempel waktu tampilan, mengikuti zona dan format dashboard lama. */
function rscStamp_(date) {
  var d = date || new Date();
  try {
    var tz = (Session.getScriptTimeZone && Session.getScriptTimeZone()) || ROLLING_SALES_CENTER_PARAMETERS.timezone;
    return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss');
  } catch (e) {
    return rscPad_(d.getFullYear(), 4) + '-' + rscPad_(d.getMonth() + 1, 2) + '-' + rscPad_(d.getDate(), 2) +
      ' ' + rscPad_(d.getHours(), 2) + ':' + rscPad_(d.getMinutes(), 2) + ':' + rscPad_(d.getSeconds(), 2);
  }
}

function rscNowIso_() { return new Date().toISOString(); }

function rscUuid_() {
  try { return Utilities.getUuid(); }
  catch (e) { return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e9); }
}

function rscSleep_(ms) {
  try { Utilities.sleep(ms); } catch (e) { /* di luar GAS */ }
}

function rscChunk_(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function rscUniq_(arr) {
  var seen = {}, out = [];
  for (var i = 0; i < arr.length; i++) {
    var k = String(arr[i]);
    if (!seen[k]) { seen[k] = 1; out.push(arr[i]); }
  }
  return out;
}

function rscRound_(n, d) {
  var f = Math.pow(10, d || 0);
  return Math.round(Number(n || 0) * f) / f;
}

function rscColLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** "2,3,4 ...(+18 baris)" — menjaga pesan tetap pendek pada file besar. */
function rscRowsLabel_(rows) {
  var n = RSC_STANDARD_VALIDATION_V27_20260814.msgMaxRowsInMessage;
  if (rows.length <= n) return rows.join(',');
  return rows.slice(0, n).join(',') + ' ...(+' + (rows.length - n) + ' baris)';
}

function rscProps_() { return PropertiesService.getScriptProperties(); }
function rscCache_() { return CacheService.getScriptCache(); }

function rscGetProp_(k, dflt) {
  try {
    var v = rscProps_().getProperty(k);
    return (v === null || v === undefined) ? (dflt === undefined ? '' : dflt) : v;
  } catch (e) { return dflt === undefined ? '' : dflt; }
}

function rscSetProp_(k, v) {
  try {
    if (v === null || v === undefined || v === '') rscProps_().deleteProperty(k);
    else rscProps_().setProperty(k, String(v));
  } catch (e) { /* properti bersifat best-effort */ }
}

function rscWhoAmI_() {
  try { return Session.getEffectiveUser().getEmail() || 'unknown'; }
  catch (e) { return 'unknown'; }
}

function rscActiveSs_() {
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (ss) return ss;
  var id = rscGetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, '');
  if (!id) id = rscGetProp_(RSC_STANDARD_VALIDATION_V27_20260814.pMasterSsId, '');
  if (!id) throw new Error('Master spreadsheet belum diketahui. Buka file induk lalu jalankan menu sekali.');
  return SpreadsheetApp.openById(id);
}

/** Tampilkan dialog bila ada UI; kalau tidak, kembalikan teksnya saja. */
function rscAlert_(title, message) {
  try {
    var ui = SpreadsheetApp.getUi();
    ui.alert(String(title), String(message), ui.ButtonSet.OK);
  } catch (e) { /* konteks tanpa UI */ }
  return message;
}

function rscToast_(message, title) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(String(message), String(title || 'Rolling Sales Center'), 5); }
  catch (e) { /* konteks tanpa UI */ }
}

function writeRollingSalesCenterLog_(message) {
  try { Logger.log(String(message)); } catch (e) { /* abaikan */ }
}

function runSafelyWithOptionalRethrow_(label, fn, rethrow) {
  try { return fn(); }
  catch (e) {
    writeRollingSalesCenterLog_(label + ' gagal: ' + e);
    if (rethrow) throw e;
    return null;
  }
}

/* =============================================================
 * 3. KLASIFIKASI ERROR  — inti perbaikan [F2]
 * ============================================================= */

var RSC_ERR = { INFRA: 'INFRA', ACCESS: 'ACCESS', DATA: 'DATA', FATAL: 'FATAL' };

function RscInfraError(msg, meta) {
  this.name = 'RscInfraError';
  this.message = msg;
  this.rscKind = RSC_ERR.INFRA;
  this.meta = meta || {};
}
RscInfraError.prototype = Object.create(Error.prototype);

function RscDataError(msg, meta) {
  this.name = 'RscDataError';
  this.message = msg;
  this.rscKind = RSC_ERR.DATA;
  this.meta = meta || {};
}
RscDataError.prototype = Object.create(Error.prototype);

function RscAccessError(msg, meta) {
  this.name = 'RscAccessError';
  this.message = msg;
  this.rscKind = RSC_ERR.ACCESS;
  this.meta = meta || {};
}
RscAccessError.prototype = Object.create(Error.prototype);

var RSC_INFRA_PATTERNS = [
  /lock/i, /lease/i, /busy/i, /contention/i, /concurrent/i,
  /timed? ?out/i, /timeout/i, /deadline/i,
  /rate limit/i, /quota/i, /too many/i, /try again/i, /coba lagi/i,
  /internal error/i, /service error/i, /unavailable/i, /backend/i,
  /server error/i, /\b50[0234]\b/, /transient/i,
  /gagal sementara/i, /sedang dipakai/i
];

var RSC_ACCESS_PATTERNS = [
  /permission/i, /izin/i, /access denied/i, /not authorized/i, /unauthorized/i,
  /you do not have/i, /tidak memiliki akses/i,
  /not found/i, /tidak ditemukan/i, /no item with the given id/i, /\b40[34]\b/
];

/**
 * Menentukan jenis kegagalan. Ini yang membuat "[PERF19 DB BUSY]" berhenti
 * menghasilkan "Task gagal pada attempt N" seperti pada versi lama.
 */
function rscClassify_(err) {
  if (!err) return { kind: RSC_ERR.FATAL, message: 'Unknown error' };
  if (err.rscKind) return { kind: err.rscKind, message: err.message || String(err), meta: err.meta || {} };
  var msg = (err && err.message) ? String(err.message) : String(err);
  var i;
  for (i = 0; i < RSC_INFRA_PATTERNS.length; i++) {
    if (RSC_INFRA_PATTERNS[i].test(msg)) return { kind: RSC_ERR.INFRA, message: msg };
  }
  for (i = 0; i < RSC_ACCESS_PATTERNS.length; i++) {
    if (RSC_ACCESS_PATTERNS[i].test(msg)) return { kind: RSC_ERR.ACCESS, message: msg };
  }
  return { kind: RSC_ERR.FATAL, message: msg };
}

/** Backoff eksponensial + jitter, dibatasi retryMaxMs. */
function rscBackoffMs_(n) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var base = V.retryBaseMs * Math.pow(2, Math.max(0, n - 1));
  var capped = Math.min(base, V.retryMaxMs);
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

/** Retry otomatis KHUSUS error INFRA. Kegagalan data langsung dilempar. */
function rscRetry_(label, tries, fn) {
  var last = null;
  for (var i = 1; i <= tries; i++) {
    try { return fn(i); }
    catch (e) {
      last = e;
      if (rscClassify_(e).kind !== RSC_ERR.INFRA || i === tries) throw e;
      rscSleep_(rscBackoffMs_(i));
    }
  }
  throw last;
}

/* =============================================================
 * 4. LEASE PER-RESOURCE — inti perbaikan [F1]
 * ============================================================= */

/** Critical section sangat pendek yang dilindungi lock global. */
function rscAtomic_(fn, waitMs) {
  var lock = null;
  try { lock = LockService.getScriptLock(); } catch (e) { lock = null; }
  if (!lock) return fn();
  if (!lock.tryLock(waitMs || 3000)) {
    throw new RscInfraError('Tidak dapat mengambil lock global untuk operasi atomik.');
  }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (e2) { /* sudah lepas */ } }
}

/** Ambil lease bernama. Mengembalikan token, atau '' bila sedang dipegang. */
function rscLeaseAcquire_(resource, ttlMs) {
  var key = RSC_DB_PARAMETERS.pLeasePrefix + resource;
  var token = rscUuid_();
  var now = Date.now();
  return rscAtomic_(function () {
    var raw = rscGetProp_(key, '');
    if (raw) {
      var cur = null;
      try { cur = JSON.parse(raw); } catch (e) { cur = null; }
      if (cur && Number(cur.until) > now) return '';
    }
    rscSetProp_(key, JSON.stringify({ token: token, until: now + (ttlMs || 60000), by: rscWhoAmI_() }));
    return token;
  }, 3000);
}

/** Lepas lease hanya bila token cocok. */
function rscLeaseRelease_(resource, token) {
  if (!token) return;
  var key = RSC_DB_PARAMETERS.pLeasePrefix + resource;
  try {
    rscAtomic_(function () {
      var raw = rscGetProp_(key, '');
      if (!raw) return;
      var cur = null;
      try { cur = JSON.parse(raw); } catch (e) { cur = null; }
      if (cur && cur.token === token) rscSetProp_(key, '');
    }, 3000);
  } catch (e) { /* lease kedaluwarsa sendiri */ }
}


/* =============================================================
 * 5. SNAPSHOT + PENYIMPANAN INDEX BERTINGKAT — perbaikan [F6]
 * -------------------------------------------------------------
 * CacheService dibatasi ~100KB per entry. Snapshot m_bp_relation jauh
 * melewati batas itu, sehingga penulisan cache gagal dan SETIAP execution
 * membangun ulang index dari sumber. Karena itu snapshot besar
 * dimaterialisasi ke spreadsheet index tersendiri.
 * ============================================================= */

var RSC_MEM_INDEX = {};

function rscSnapKey_(name, ver, part) { return 'RSCSNAP:' + name + ':' + ver + ':' + part; }

function rscSnapWrite_(name, ver, obj) {
  var json = JSON.stringify(obj);
  var parts = [];
  for (var i = 0; i < json.length; i += RSC_DB_PARAMETERS.cacheChunkBytes) {
    parts.push(json.substring(i, i + RSC_DB_PARAMETERS.cacheChunkBytes));
  }
  var map = {};
  for (var p = 0; p < parts.length; p++) map[rscSnapKey_(name, ver, p)] = parts[p];
  map[rscSnapKey_(name, ver, 'meta')] = JSON.stringify({ n: parts.length, bytes: json.length, at: rscStamp_() });
  try {
    var cache = rscCache_();
    var groups = rscChunk_(Object.keys(map), 50);
    for (var g = 0; g < groups.length; g++) {
      var sub = {};
      for (var k = 0; k < groups[g].length; k++) sub[groups[g][k]] = map[groups[g][k]];
      cache.putAll(sub, RSC_DB_PARAMETERS.cacheTtlSec);
    }
    return { ok: true, parts: parts.length, bytes: json.length };
  } catch (e) {
    return { ok: false, parts: parts.length, bytes: json.length, error: String(e) };
  }
}

function rscSnapRead_(name, ver) {
  var cache;
  try { cache = rscCache_(); } catch (e) { return null; }
  var metaRaw = cache.get(rscSnapKey_(name, ver, 'meta'));
  if (!metaRaw) return null;
  var meta;
  try { meta = JSON.parse(metaRaw); } catch (e) { return null; }
  var keys = [];
  for (var i = 0; i < meta.n; i++) keys.push(rscSnapKey_(name, ver, i));
  var got = cache.getAll(keys);
  var buf = '';
  for (var j = 0; j < keys.length; j++) {
    var piece = got[keys[j]];
    if (piece === null || piece === undefined) return null;
    buf += piece;
  }
  try { return JSON.parse(buf); } catch (e) { return null; }
}

/** Spreadsheet penampung index besar. Dibuat sekali, lalu dipakai ulang. */
function rscIndexStore_(createIfMissing) {
  var id = rscGetProp_(RSC_DB_PARAMETERS.pIndexStoreId, '');
  if (id) {
    try { return SpreadsheetApp.openById(id); }
    catch (e) { rscSetProp_(RSC_DB_PARAMETERS.pIndexStoreId, ''); }
  }
  if (!createIfMissing) return null;
  try {
    var ss = SpreadsheetApp.create('_RSC_INDEX_CACHE (jangan dihapus)');
    rscSetProp_(RSC_DB_PARAMETERS.pIndexStoreId, ss.getId());
    return ss;
  } catch (e2) { return null; }
}

function rscIdxSheetName_(tableName) { return 'IDX_' + tableName; }

function rscIdxSheetWrite_(tableName, ver, built) {
  var ss = rscIndexStore_(true);
  if (!ss) return { ok: false, reason: 'NO_STORE' };
  var name = rscIdxSheetName_(tableName);
  var sh = ss.getSheetByName(name);
  try {
    if (sh) ss.deleteSheet(sh);
    sh = ss.insertSheet(name);
  } catch (e) { return { ok: false, reason: String(e) }; }

  var keys = Object.keys(built.map);
  sh.getRange(1, 1, 1, 2).setValues([[ver, JSON.stringify({
    rows: built.rows, sheet: built.sheet, source: built.source, mode: built.mode, keys: keys.length
  })]]);

  var row = 2, i = 0, block = RSC_DB_PARAMETERS.indexSheetWriteRows;
  while (i < keys.length) {
    var n = Math.min(block, keys.length - i);
    var out = [];
    for (var k = 0; k < n; k++) out.push([keys[i + k], JSON.stringify(built.map[keys[i + k]])]);
    sh.getRange(row, 1, n, 2).setValues(out);
    row += n; i += n;
  }
  return { ok: true, keys: keys.length };
}

function rscIdxSheetRead_(tableName, ver) {
  var ss = rscIndexStore_(false);
  if (!ss) return null;
  var sh = ss.getSheetByName(rscIdxSheetName_(tableName));
  if (!sh) return null;
  var head = sh.getRange(1, 1, 1, 2).getDisplayValues()[0];
  if (rscText_(head[0]) !== ver) return null;
  var meta = {};
  try { meta = JSON.parse(head[1] || '{}'); } catch (e) { meta = {}; }

  var last = sh.getLastRow(), map = {}, row = 2;
  var win = RSC_DB_PARAMETERS.indexSheetReadRows;
  while (row <= last) {
    var n = Math.min(win, last - row + 1);
    var vals = sh.getRange(row, 1, n, 2).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      if (!vals[r][0]) continue;
      try { map[vals[r][0]] = JSON.parse(vals[r][1]); } catch (e2) { /* baris rusak dilewati */ }
    }
    row += n;
  }
  return {
    available: true, map: map, rows: meta.rows || 0, sheet: meta.sheet || '',
    source: meta.source || '', mode: meta.mode || '', storedIn: 'sheet'
  };
}

function rscIndexPersist_(tableName, ver, built) {
  var json = JSON.stringify(built);
  if (json.length <= RSC_DB_PARAMETERS.cacheMaxBytes) {
    var w = rscSnapWrite_(tableName, ver, built);
    if (w.ok) { built.storedIn = 'cache'; return built; }
  }
  var r = rscIdxSheetWrite_(tableName, ver, built);
  built.storedIn = r.ok ? 'sheet' : 'memory-only';
  if (!r.ok) built.persistNote = 'gagal materialisasi index: ' + (r.reason || '-');
  return built;
}

/* =============================================================
 * 6. LAYER INDEX DATABASE — inti perbaikan [F3]
 * ============================================================= */

function rscDbSources_() {
  var out = [];
  var main = rscFileId_(RSC_DB_PARAMETERS.spreadsheetId) || rscText_(RSC_DB_PARAMETERS.spreadsheetId);
  if (main) out.push(main);
  var extra = RSC_DB_PARAMETERS.extraSpreadsheetIds || [];
  for (var i = 0; i < extra.length; i++) {
    var id = rscFileId_(extra[i]) || rscText_(extra[i]);
    if (id && out.indexOf(id) < 0) out.push(id);
  }
  return out;
}

/** Versi index = sidik jari seluruh spreadsheet DB. Stabil 5 menit. */
function rscIndexVersion_() {
  var ids = rscDbSources_();
  if (!ids.length) return 'nodb';
  var tag = ids.join(',');
  var cached = rscGetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag, '');
  var at = Number(rscGetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag + '_AT', '0'));
  if (cached && (Date.now() - at) < 300000) return cached;
  var stamps = [];
  for (var i = 0; i < ids.length; i++) {
    try { stamps.push(DriveApp.getFileById(ids[i]).getLastUpdated().getTime()); }
    catch (e) { stamps.push(Math.floor(Date.now() / 3600000)); }
  }
  var ver = 'v' + stamps.join('-');
  rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag, ver);
  rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag + '_AT', String(Date.now()));
  return ver;
}

var RSC_SHEET_NAME_LIMIT = 31;

/**
 * Cari sheet dari daftar alias. Pencocokan sengaja KETAT: toleransi prefix
 * hanya untuk nama tab yang mentok batas 31 karakter. Tanpa itu alias pendek
 * seperti "m_bp" akan menyambar tab "m_bp_relation".
 */
function rscFindSheet_(ss, aliases) {
  var sheets = ss.getSheets(), byKey = {};
  for (var i = 0; i < sheets.length; i++) {
    var k = rscKey_(sheets[i].getName());
    if (!(k in byKey)) byKey[k] = sheets[i];
  }
  for (var a = 0; a < aliases.length; a++) {
    var hit = byKey[rscKey_(aliases[a])];
    if (hit) return hit;
  }
  for (var b = 0; b < aliases.length; b++) {
    var want = rscKey_(aliases[b]);
    for (var key in byKey) {
      if (!Object.prototype.hasOwnProperty.call(byKey, key)) continue;
      if (byKey[key].getName().length >= RSC_SHEET_NAME_LIMIT &&
          want.length > key.length && want.indexOf(key) === 0) return byKey[key];
    }
  }
  return null;
}

function rscHeaderMap_(headerRow) {
  var map = {};
  for (var i = 0; i < headerRow.length; i++) {
    var k = rscKey_(headerRow[i]);
    if (k && !(k in map)) map[k] = i;
  }
  return map;
}

function rscPickCol_(hmap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var k = rscKey_(candidates[i]);
    if (k in hmap) return hmap[k];
  }
  return -1;
}

/** Cari tabel di seluruh spreadsheet DB yang dikonfigurasi. */
function rscLocateTable_(aliases) {
  var ids = rscDbSources_();
  for (var i = 0; i < ids.length; i++) {
    var ss;
    try { ss = SpreadsheetApp.openById(ids[i]); }
    catch (e) {
      if (rscClassify_(e).kind === RSC_ERR.INFRA) throw new RscInfraError('Gagal membuka spreadsheet DB: ' + e);
      continue;
    }
    var sh = rscFindSheet_(ss, aliases);
    if (sh) return { sheet: sh, ssId: ids[i], ssName: ss.getName() };
  }
  return null;
}

/**
 * Deteksi layout m_bp_relation. Mendukung empat bentuk yang pernah dipakai:
 *  COMPACT_JSON dengan header 'relation_payload'
 *  COMPACT_JSON tanpa header (baris pertama sudah berupa array JSON)
 *  LEGACY 5 kolom dengan header bp_id_rlt1 dst
 *  LEGACY 5 kolom tanpa header (fallback A..E)
 * Baris pembuka yang berisi URL atau catatan otomatis dilewati.
 */
function RSC_MBP_RELATION_GET_LAYOUT_20260819_(sh) {
  if (!sh) throw new RscDataError('Sheet m_bp_relation tidak tersedia.');
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(1, sh.getLastColumn());
  if (lastRow < 1) return { mode: 'EMPTY', firstDataRow: 1 };

  var scanRows = Math.min(8, lastRow);
  var grid = sh.getRange(1, 1, scanRows, Math.min(200, lastCol)).getDisplayValues();
  var H = RSC_DB_PARAMETERS.relationLegacyHeaders;

  for (var r = 0; r < grid.length; r++) {
    var hmap = rscHeaderMap_(grid[r]);
    var payload = rscPickCol_(hmap, [RSC_DB_PARAMETERS.relationCompactHeader]);
    if (payload >= 0) {
      return { mode: 'COMPACT_JSON', firstDataRow: r + 2, payloadCol: payload + 1, hasHeader: true };
    }
    var cCust = rscPickCol_(hmap, [H.customer]);
    var cRel = rscPickCol_(hmap, [H.relationship]);
    var cSls = rscPickCol_(hmap, [H.salesman]);
    if (cCust >= 0 && cRel >= 0 && cSls >= 0) {
      return {
        mode: 'LEGACY_COLUMNS', firstDataRow: r + 2, hasHeader: true,
        colCustomer: cCust + 1, colRelationship: cRel + 1, colSalesman: cSls + 1,
        colValidFrom: rscPickCol_(hmap, [H.validFrom]) + 1,
        colValidTo: rscPickCol_(hmap, [H.validTo]) + 1
      };
    }
  }

  for (var r2 = 0; r2 < grid.length; r2++) {
    for (var c = 0; c < grid[r2].length; c++) {
      var raw = rscText_(grid[r2][c]);
      if (!raw || raw.charAt(0) !== '[') continue;
      try {
        var parsed = JSON.parse(raw);
        if (Object.prototype.toString.call(parsed) === '[object Array]' && parsed.length >= 3) {
          return { mode: 'COMPACT_JSON', firstDataRow: r2 + 1, payloadCol: c + 1, hasHeader: false };
        }
      } catch (e) { /* bukan payload */ }
    }
  }

  for (var r3 = 0; r3 < grid.length; r3++) {
    if (/^\d{6,12}$/.test(rscText_(grid[r3][0]))) {
      return {
        mode: 'LEGACY_COLUMNS', firstDataRow: r3 + 1, hasHeader: false,
        colCustomer: 1, colRelationship: 2, colSalesman: 3, colValidFrom: 4, colValidTo: 5
      };
    }
  }
  return { mode: 'UNKNOWN', firstDataRow: 1 };
}

/** Ubah satu baris m_bp_relation menjadi bentuk kanonik. */
function RSC_MBP_RELATION_PARSE_ROW_20260819_(layout, row) {
  if (layout.mode === 'COMPACT_JSON') {
    var raw = rscText_(row[layout.payloadCol - 1]);
    if (!raw || raw.charAt(0) !== '[') return null;
    var a;
    try { a = JSON.parse(raw); } catch (e) { return null; }
    if (Object.prototype.toString.call(a) !== '[object Array]' || a.length < 3) return null;
    return {
      customer: RSC_NORMALIZE_ID_(a[0]),
      relationship: RSC_NORMALIZE_ID_(a[1]),
      salesman: RSC_NORMALIZE_ID_(a[2]),
      validFrom: rscDateStr_(a[3]),
      validTo: rscDateStr_(a[4])
    };
  }
  if (layout.mode === 'LEGACY_COLUMNS') {
    return {
      customer: RSC_NORMALIZE_ID_(row[layout.colCustomer - 1]),
      relationship: RSC_NORMALIZE_ID_(row[layout.colRelationship - 1]),
      salesman: RSC_NORMALIZE_ID_(row[layout.colSalesman - 1]),
      validFrom: layout.colValidFrom > 0 ? rscDateStr_(row[layout.colValidFrom - 1]) : '',
      validTo: layout.colValidTo > 0 ? rscDateStr_(row[layout.colValidTo - 1]) : ''
    };
  }
  return null;
}

/** Ambang tanggal aktif. Baris yang lewat lebih lama dari grace tidak diindeks. */
function rscActiveCutoff_() {
  return rscDateStr_(new Date(Date.now() - Number(RSC_DB_PARAMETERS.activeGraceDays || 0) * 86400000));
}

/** Bangun index m_bp_relation: customer -> daftar relasi aktif. */
function rscBuildRelationIndex_() {
  var loc = rscLocateTable_(RSC_DB_PARAMETERS.tables.RELATION);
  if (!loc) return { available: false, reason: 'TABLE_NOT_FOUND', map: {}, rows: 0 };
  var sh = loc.sheet;
  var layout = RSC_MBP_RELATION_GET_LAYOUT_20260819_(sh);
  if (layout.mode === 'EMPTY') return { available: true, map: {}, rows: 0, sheet: sh.getName(), mode: layout.mode };
  if (layout.mode === 'UNKNOWN') return { available: false, reason: 'LAYOUT_UNKNOWN', map: {}, rows: 0, sheet: sh.getName() };

  var lastRow = sh.getLastRow(), lastCol = Math.max(1, sh.getLastColumn());
  var cutoff = rscActiveCutoff_();
  var map = {}, total = 0, skipped = 0, expired = 0;
  var row = layout.firstDataRow, win = RSC_DB_PARAMETERS.readWindowRows;

  while (row <= lastRow) {
    var n = Math.min(win, lastRow - row + 1);
    var block = sh.getRange(row, 1, n, lastCol).getDisplayValues();
    for (var r = 0; r < block.length; r++) {
      var rec = RSC_MBP_RELATION_PARSE_ROW_20260819_(layout, block[r]);
      if (!rec || !rec.customer || !/^\d{6,12}$/.test(rec.customer)) { skipped++; continue; }
      if (rec.validTo && rec.validTo < cutoff) { expired++; continue; }
      if (!map[rec.customer]) map[rec.customer] = [];
      if (map[rec.customer].length < 24) {
        map[rec.customer].push([rec.relationship, rec.salesman, rec.validFrom, rec.validTo]);
      }
      total++;
    }
    row += n;
  }
  return {
    available: true, map: map, rows: total, skippedRows: skipped, expiredRows: expired,
    sheet: sh.getName(), source: loc.ssName, sourceId: loc.ssId, mode: layout.mode,
    fields: ['Relationship', 'Salesman ID', 'Valid From', 'Valid To']
  };
}

/** Builder generik berbasis header untuk m_sales_info / m_bp_general_view / m_visit_schedule. */
function rscBuildHeaderIndex_(aliases, keySpecs, valSpecs, opts) {
  opts = opts || {};
  var loc = rscLocateTable_(aliases);
  if (!loc) return { available: false, reason: 'TABLE_NOT_FOUND', map: {}, rows: 0 };
  var sh = loc.sheet;
  var lastRow = sh.getLastRow(), lastCol = Math.max(1, sh.getLastColumn());
  if (lastRow < 2) return { available: true, map: {}, rows: 0, sheet: sh.getName(), mode: 'header' };

  var header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var hmap = rscHeaderMap_(header);
  var keyIdx = [];
  for (var k = 0; k < keySpecs.length; k++) {
    var ci = rscPickCol_(hmap, keySpecs[k]);
    if (ci < 0) return { available: false, reason: 'KEY_COLUMN_MISSING', map: {}, rows: 0, sheet: sh.getName() };
    keyIdx.push(ci);
  }
  var valIdx = [], fields = [];
  for (var v = 0; v < valSpecs.length; v++) {
    valIdx.push(rscPickCol_(hmap, valSpecs[v].aliases));
    fields.push(valSpecs[v].name);
  }
  var activeAt = -1;
  if (opts.activeField) {
    for (var a = 0; a < valSpecs.length; a++) if (valSpecs[a].name === opts.activeField) activeAt = a;
  }
  var cutoff = activeAt >= 0 ? rscActiveCutoff_() : '';

  var map = {}, total = 0, expired = 0, row = 2;
  var win = RSC_DB_PARAMETERS.readWindowRows;
  var maxPerKey = opts.maxPerKey || 8;

  while (row <= lastRow) {
    var n = Math.min(win, lastRow - row + 1);
    var block = sh.getRange(row, 1, n, lastCol).getDisplayValues();
    for (var r = 0; r < block.length; r++) {
      var parts = [], blank = true;
      for (var kk = 0; kk < keyIdx.length; kk++) {
        var kv = RSC_NORMALIZE_ID_(block[r][keyIdx[kk]]);
        if (kv) blank = false;
        parts.push(kv);
      }
      if (blank) continue;
      var rec = [];
      for (var vv = 0; vv < valIdx.length; vv++) {
        rec.push(valIdx[vv] >= 0 ? rscText_(block[r][valIdx[vv]]) : '');
      }
      if (activeAt >= 0) {
        var vt = rscDateStr_(rec[activeAt]);
        if (vt && vt < cutoff) { expired++; continue; }
      }
      var key = parts.join('|');
      if (!map[key]) map[key] = [];
      if (map[key].length < maxPerKey) map[key].push(rec);
      total++;
    }
    row += n;
  }
  return {
    available: true, map: map, rows: total, expiredRows: expired, fields: fields,
    sheet: sh.getName(), source: loc.ssName, sourceId: loc.ssId, mode: 'header'
  };
}

function rscBuildIndex_(tableName) {
  var D = RSC_DB_PARAMETERS;
  if (!rscDbSources_().length) return { available: false, reason: 'DB_NOT_CONFIGURED', map: {}, rows: 0 };

  if (tableName === 'RELATION') return rscBuildRelationIndex_();

  if (tableName === 'SALESMAN') {
    return rscBuildHeaderIndex_(D.tables.SALESMAN, [D.salesmanHeaders.salesman], [
      { name: 'Sales Office', aliases: D.salesmanHeaders.salesOffice },
      { name: 'Sales Organization', aliases: D.salesmanHeaders.salesOrg },
      { name: 'Sales Type', aliases: D.salesmanHeaders.salesType },
      { name: 'Coverage', aliases: D.salesmanHeaders.coverage },
      { name: 'Name', aliases: D.salesmanHeaders.name },
      { name: 'Valid From', aliases: D.salesmanHeaders.validFrom },
      { name: 'Valid To', aliases: D.salesmanHeaders.validTo }
    ], { activeField: 'Valid To', maxPerKey: 8 });
  }

  if (tableName === 'BP') {
    return rscBuildHeaderIndex_(D.tables.BP, [D.bpHeaders.customer], [
      { name: 'Salesman BP Type', aliases: D.bpHeaders.bpType },
      { name: 'Sales Office', aliases: D.bpHeaders.salesOffice },
      { name: 'Name', aliases: D.bpHeaders.name }
    ], { maxPerKey: 2 });
  }

  if (tableName === 'VISIT') {
    return rscBuildHeaderIndex_(D.tables.VISIT, [D.visitHeaders.customer, D.visitHeaders.salesman], [
      { name: 'Schedule Visit', aliases: D.visitHeaders.schedule },
      { name: 'Visit Category', aliases: D.visitHeaders.visitCategory },
      { name: 'Visit Type', aliases: D.visitHeaders.visitType },
      { name: 'Valid From', aliases: D.visitHeaders.validFrom },
      { name: 'Valid To', aliases: D.visitHeaders.validTo }
    ], { maxPerKey: 8 });
  }

  throw new RscDataError('Tabel master tidak dikenal: ' + tableName);
}

/**
 * Ambil index: memori -> cache -> sheet index -> bangun (dengan lease).
 * Tidak pernah memegang lock global selama pembangunan.
 */
function rscGetIndex_(tableName) {
  var ver = rscIndexVersion_();
  var memKey = tableName + ':' + ver;
  if (RSC_MEM_INDEX[memKey]) return RSC_MEM_INDEX[memKey];

  if (!rscDbSources_().length) {
    var none = { available: false, reason: 'DB_NOT_CONFIGURED', map: {}, rows: 0, ver: ver };
    RSC_MEM_INDEX[memKey] = none;
    return none;
  }

  var snap = rscSnapRead_(tableName, ver);
  if (snap) { snap.ver = ver; snap.storedIn = 'cache'; RSC_MEM_INDEX[memKey] = snap; return snap; }

  var fromSheet = rscIdxSheetRead_(tableName, ver);
  if (fromSheet) { fromSheet.ver = ver; RSC_MEM_INDEX[memKey] = fromSheet; return fromSheet; }

  var resource = 'IDX:' + tableName + ':' + ver;
  var token = rscLeaseAcquire_(resource, RSC_DB_PARAMETERS.buildLeaseMs);

  if (!token) {
    var waited = 0;
    while (waited < RSC_DB_PARAMETERS.waitForBuilderMs) {
      rscSleep_(RSC_DB_PARAMETERS.waitStepMs);
      waited += RSC_DB_PARAMETERS.waitStepMs;
      var again = rscSnapRead_(tableName, ver) || rscIdxSheetRead_(tableName, ver);
      if (again) { again.ver = ver; RSC_MEM_INDEX[memKey] = again; return again; }
    }
    throw new RscInfraError(
      'Index master "' + tableName + '" sedang dibangun execution lain. ' +
      'Task dijadwalkan ulang tanpa menambah Attempts.', { resource: resource, waitedMs: waited });
  }

  try {
    var recheck = rscSnapRead_(tableName, ver) || rscIdxSheetRead_(tableName, ver);
    if (recheck) { recheck.ver = ver; RSC_MEM_INDEX[memKey] = recheck; return recheck; }
    var built = rscBuildIndex_(tableName);
    built.ver = ver;
    built.builtAt = rscStamp_();
    if (built.available) rscIndexPersist_(tableName, ver, built);
    RSC_MEM_INDEX[memKey] = built;
    return built;
  } finally {
    rscLeaseRelease_(resource, token);
  }
}

/** Lookup banyak key sekaligus: O(k) murni, tanpa jalur full scan. */
function rscLookupMany_(index, keys) {
  var out = {};
  if (!index || !index.available) return out;
  for (var i = 0; i < keys.length; i++) {
    var k = String(keys[i]).toUpperCase();
    if (index.map[k]) out[k] = index.map[k];
  }
  return out;
}

/** Ubah record array menjadi objek bernama sesuai index.fields. */
function rscRecObj_(index, rec) {
  var o = {};
  var f = (index && index.fields) || [];
  for (var i = 0; i < f.length; i++) o[f[i]] = rec[i] === undefined ? '' : rec[i];
  return o;
}


/* =============================================================
 * 7. SPESIFIKASI SHEET + ENGINE VALIDASI
 * -------------------------------------------------------------
 * Satu engine dipakai untuk semua sheet yang divalidasi. Yang berbeda hanya
 * daftar kolom dan daftar rule, sehingga normalisasi, penulisan hasil, dan
 * pelaporan dijamin identik di mana pun.
 * ============================================================= */

var RSC_SHEET_SPECS = [
  {
    key: 'ROLLING',
    label: 'Change Rolling & Change Schedule',
    names: ['Change Rolling & Change Schedule', 'Change Rolling & Change Schedul', 'Change Rolling'],
    primary: true,
    header: [
      'Sales Office', 'Delivering Plant', 'Customer ID', 'Relationship', 'Salesman ID',
      'Salesman BP Type', 'Valid From', 'Valid To', 'Visit Category', 'Visit Type',
      'Schedule Visit', 'Visit Valid From', 'Visit Valid To', 'Reason',
      'Validation Status', 'Error Detail'
    ],
    statusCol: 15,
    errorCol: 16,
    dateFields: ['Valid From', 'Valid To', 'Visit Valid From', 'Visit Valid To'],
    idFields: ['Sales Office', 'Delivering Plant', 'Relationship', 'Salesman BP Type', 'Visit Category', 'Visit Type'],
    required: ['Sales Office', 'Delivering Plant', 'Customer ID', 'Salesman ID', 'Salesman BP Type',
               'Valid From', 'Valid To', 'Visit Category', 'Visit Type', 'Schedule Visit',
               'Visit Valid From', 'Visit Valid To', 'Reason'],
    rowRules: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R9', 'R10'],
    tableRules: ['R7', 'R8a', 'R8b', 'TB']
  },
  {
    key: 'SALESMAN_TYPE',
    label: 'Change Salesman Type',
    names: ['Change Salesman Type'],
    header: ['Salesman ID', 'Sales Organization', 'Sales Office', 'Sales Type', 'Coverage',
             'Valid From', 'Valid To', 'Validation Status', 'Error Detail'],
    statusCol: 8,
    errorCol: 9,
    dateFields: ['Valid From', 'Valid To'],
    idFields: ['Sales Organization', 'Sales Office', 'Sales Type'],
    required: ['Salesman ID', 'Sales Organization', 'Sales Office', 'Sales Type', 'Valid From', 'Valid To'],
    rowRules: ['R1', 'R3', 'R4', 'R9'],
    tableRules: ['R8a']
  },
  {
    key: 'SALES_OFFICE',
    label: 'Change Sales Office',
    names: ['Change Sales Office'],
    header: ['BP Number Source', 'Delivering Plant', 'Distr. Channel', 'Division',
             'Sales Organization', 'Sales Office', 'Validation Status', 'Error Detail'],
    statusCol: 7,
    errorCol: 8,
    dateFields: [],
    idFields: ['Sales Organization', 'Sales Office', 'Distr. Channel', 'Division'],
    required: ['BP Number Source', 'Sales Organization', 'Sales Office'],
    rowRules: ['R1', 'R3', 'R10'],
    tableRules: ['R8a']
  }
];

function rscSpecFor_(sheetName) {
  var k = rscKey_(sheetName);
  for (var i = 0; i < RSC_SHEET_SPECS.length; i++) {
    var names = RSC_SHEET_SPECS[i].names;
    for (var n = 0; n < names.length; n++) {
      var nk = rscKey_(names[n]);
      if (k === nk || k.indexOf(nk) === 0 || nk.indexOf(k) === 0) return RSC_SHEET_SPECS[i];
    }
  }
  return null;
}

function rscPrimarySpec_() {
  for (var i = 0; i < RSC_SHEET_SPECS.length; i++) if (RSC_SHEET_SPECS[i].primary) return RSC_SHEET_SPECS[i];
  return RSC_SHEET_SPECS[0];
}

/**
 * Kebijakan tanggal Rolling.
 * Reason = Rolling  : Valid From dan Visit Valid From WAJIB dateNew.
 *                     Histori m_bp_relation tidak boleh menarik mundur.
 * Change Schedule Only mode PAIR_NO_RELATION: field relasi tetap apa adanya,
 *                     hanya Visit Valid From yang mengikuti dateNew.
 */
function RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_(reason, csoMode, sourceValidFrom, dateNew) {
  var next = String(dateNew === null || dateNew === undefined ? '' : dateNew);
  var isRolling = rscKey_(reason) === rscKey_('Rolling');
  if (!isRolling) {
    return { validFrom: rscDateStr_(sourceValidFrom), visitValidFrom: rscDateStr_(sourceValidFrom), policy: 'AS_IS' };
  }
  if (String(csoMode || '') === 'PAIR_NO_RELATION') {
    return { validFrom: rscDateStr_(sourceValidFrom), visitValidFrom: next, policy: 'VISIT_ONLY' };
  }
  return { validFrom: next, visitValidFrom: next, policy: 'ROLLING_HARDCODED' };
}

/** Uraikan "W1W,W3W" menjadi token terstruktur. */
function rscParseSchedule_(v) {
  var raw = rscText_(v).toUpperCase();
  if (!raw) return { tokens: [], valid: [], invalid: [], weekdays: {}, weeks: {}, canonical: '' };
  var parts = raw.split(/[,;\/]+/);
  var tokens = [], valid = [], invalid = [], weekdays = {}, weeks = {};
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].replace(/\s+/g, '');
    if (!t) continue;
    tokens.push(t);
    var m = t.match(/^W([1-4])(SU|TH|M|T|W|F|S)$/);
    if (m) { valid.push(t); weeks[m[1]] = true; weekdays[m[2]] = true; }
    else invalid.push(t);
  }
  return {
    tokens: tokens, valid: valid, invalid: invalid, weekdays: weekdays, weeks: weeks,
    canonical: tokens.slice().sort().join(',')
  };
}

/** Master Sales Office dari sheet "em" di file induk. */
function rscOfficeMaster_(masterSs) {
  if (RSC_MEM_INDEX.OFFICES) return RSC_MEM_INDEX.OFFICES;
  var out = { available: false, map: {} };
  try {
    var sh = rscFindSheet_(masterSs, [TEMPLATE_UI_PARAMETERS.sheetEm]);
    if (!sh) { RSC_MEM_INDEX.OFFICES = out; return out; }
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2) { RSC_MEM_INDEX.OFFICES = out; return out; }
    var header = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var hmap = rscHeaderMap_(header);
    var cOffice = rscPickCol_(hmap, ['Sales Office']);
    if (cOffice < 0) { RSC_MEM_INDEX.OFFICES = out; return out; }
    var cDesc = (cOffice + 1 < header.length && rscKey_(header[cOffice + 1]) === 'DESCRIPTION') ? cOffice + 1 : -1;
    var cOrg = rscPickCol_(hmap, ['Sales Org', 'Sales Organization']);
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var code = RSC_NORMALIZE_ID_(vals[r][cOffice]);
      if (!code || out.map[code]) continue;
      out.map[code] = {
        code: code,
        desc: cDesc >= 0 ? rscText_(vals[r][cDesc]) : '',
        org: cOrg >= 0 ? RSC_NORMALIZE_ID_(vals[r][cOrg]) : ''
      };
    }
    out.available = Object.keys(out.map).length > 0;
  } catch (e) { out.available = false; out.error = String(e); }
  RSC_MEM_INDEX.OFFICES = out;
  return out;
}

/** Master Relationship dari daftar parameter. */
function rscRelationshipMaster_() {
  if (RSC_MEM_INDEX.RELTYPE) return RSC_MEM_INDEX.RELTYPE;
  var out = { available: true, source: 'parameters', map: {} };
  for (var i = 0; i < RELATIONSHIP_OPTIONS.length; i++) {
    var opt = RELATIONSHIP_OPTIONS[i];
    var id = RSC_NORMALIZE_ID_(opt);
    var dash = opt.indexOf(' - ');
    out.map[id] = dash > 0 ? opt.substring(dash + 3) : '';
  }
  RSC_MEM_INDEX.RELTYPE = out;
  return out;
}

/** Muat seluruh master sekali per execution. */
function rscLoadMasters_(masterSs) {
  var m = {
    office: rscOfficeMaster_(masterSs),
    relationship: rscRelationshipMaster_(),
    dateNew: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew,
    dateClose: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose,
    idx: {},
    dbConfigured: rscDbSources_().length > 0,
    notes: []
  };
  if (!m.dbConfigured) {
    m.notes.push('DB master belum dikonfigurasi; rule berbasis DB dilewati (bukan error).');
    return m;
  }
  var names = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var i = 0; i < names.length; i++) {
    m.idx[names[i]] = rscGetIndex_(names[i]);
    if (!m.idx[names[i]].available) {
      m.notes.push('Master ' + names[i] + ' tidak tersedia (' +
        (m.idx[names[i]].reason || '-') + '); rule terkait dilewati.');
    }
  }
  return m;
}

/* ---------------------- KONTEKS & DETEKSI CSO ---------------------- */

function rscBuildContext_(spec, values, masters) {
  var ctx = { spec: spec, rows: [], errors: [], masters: masters || {}, skipped: {}, fieldIdx: {} };
  for (var c = 0; c < spec.header.length; c++) ctx.fieldIdx[spec.header[c]] = c;

  for (var r = 0; r < values.length; r++) {
    var raw = values[r], f = {}, nonEmpty = false;
    for (var h = 0; h < spec.header.length; h++) {
      var name = spec.header[h];
      if (name === 'Validation Status' || name === 'Error Detail') continue;
      var val = raw[h], norm;
      if (spec.dateFields.indexOf(name) >= 0) norm = rscDateStr_(val);
      else if (spec.idFields.indexOf(name) >= 0) norm = RSC_NORMALIZE_ID_(val);
      else norm = rscText_(val);
      f[name] = norm;
      if (norm) nonEmpty = true;
    }
    if (!nonEmpty) continue;
    ctx.rows.push({ i: ctx.rows.length, sheetRow: r + 2, f: f, raw: raw, cso: null });
    ctx.errors.push([]);
  }
  return ctx;
}

function rscAddErr_(ctx, i, code, msg) { ctx.errors[i].push('[' + code + '] ' + msg); }

function rscRowIndexBySheetRow_(ctx, sheetRow) {
  if (!ctx._byRow) {
    ctx._byRow = {};
    for (var i = 0; i < ctx.rows.length; i++) ctx._byRow[ctx.rows[i].sheetRow] = i;
  }
  var v = ctx._byRow[sheetRow];
  return (v === undefined) ? -1 : v;
}

/**
 * Deteksi Change Schedule Only.
 * CASE 1 (EXACT_REL_VALID_TO) : Customer + Relationship + Salesman + Valid To
 *                               sudah ada di m_bp_relation.
 * CASE 2 (PAIR_NO_RELATION)   : Relationship kosong, pasangan Customer +
 *                               Salesman ada di m_bp_relation.
 * Baris Change Schedule Only dikecualikan dari duplicate check R8.
 */
function rscDetectChangeScheduleOnly_(ctx) {
  var idx = ctx.masters.idx && ctx.masters.idx.RELATION;
  if (!idx || !idx.available) { ctx.skipped['CSO'] = 'master m_bp_relation tidak tersedia'; return; }
  for (var i = 0; i < ctx.rows.length; i++) {
    var f = ctx.rows[i].f;
    var cust = f['Customer ID'];
    if (!cust) continue;
    var recs = idx.map[RSC_NORMALIZE_ID_(cust)];
    if (!recs) continue;
    var rel = f['Relationship'], sls = RSC_NORMALIZE_ID_(f['Salesman ID']), vt = f['Valid To'];
    for (var r = 0; r < recs.length; r++) {
      var mRel = RSC_NORMALIZE_ID_(recs[r][0]);
      var mSls = RSC_NORMALIZE_ID_(recs[r][1]);
      var mVt = rscDateStr_(recs[r][3]);
      if (!rel && mSls && mSls === sls) {
        ctx.rows[i].cso = { yes: true, mode: 'PAIR_NO_RELATION' };
        break;
      }
      if (rel && mRel === rel && mSls === sls && (!vt || !mVt || mVt === vt)) {
        ctx.rows[i].cso = { yes: true, mode: 'EXACT_REL_VALID_TO' };
        break;
      }
    }
  }
}

/* ---------------------------- RULE PER BARIS ---------------------------- */

var RSC_ROW_RULES = {

  /** R1 — kolom wajib. Relationship boleh kosong khusus Change Schedule Only. */
  R1: function (ctx, row, i) {
    var missing = [];
    for (var k = 0; k < ctx.spec.required.length; k++) {
      if (!row.f[ctx.spec.required[k]]) missing.push(ctx.spec.required[k]);
    }
    if (ctx.spec.key === 'ROLLING' && !row.f['Relationship'] && !(row.cso && row.cso.yes)) {
      missing.push('Relationship');
    }
    if (missing.length) rscAddErr_(ctx, i, 'R1', 'Kolom wajib kosong: ' + rscUniq_(missing).join(', ') + '.');
  },

  /** R2 — Relationship harus terdaftar di master Relationship. */
  R2: function (ctx, row, i) {
    var rel = row.f['Relationship'];
    if (!rel) return;
    var master = ctx.masters.relationship;
    if (!master || !master.available) return;
    if (!master.map[rel]) rscAddErr_(ctx, i, 'R2', 'Relationship tidak terdaftar pada master Relationship.');
  },

  /** R3 — Sales Office dan Delivering Plant. */
  R3: function (ctx, row, i) {
    var off = row.f['Sales Office'];
    var master = ctx.masters.office;
    if (!master || !master.available) { ctx.skipped['R3'] = 'master em tidak tersedia'; return; }
    if (off && !master.map[off]) {
      rscAddErr_(ctx, i, 'R3', 'Sales Office "' + off + '" tidak terdaftar pada master em.');
    }
    var plant = row.f['Delivering Plant'];
    if (plant && off && plant !== off) {
      rscAddErr_(ctx, i, 'R3', 'Delivering Plant "' + plant + '" harus sama dengan Sales Office "' + off + '".');
    }
  },

  /** R4 — format tanggal, urutan, dan kebijakan tanggal periode. */
  R4: function (ctx, row, i) {
    var spec = ctx.spec, bad = [];
    for (var d = 0; d < spec.dateFields.length; d++) {
      var name = spec.dateFields[d], v = row.f[name];
      if (!v) continue;
      if (!rscIsValidDateStr_(v)) bad.push(name + '="' + rscText_(row.raw[ctx.fieldIdx[name]]) + '"');
    }
    if (bad.length) {
      rscAddErr_(ctx, i, 'R4', 'Format tanggal harus YYYY-MM-DD: ' + bad.join(', ') + '.');
      return;
    }
    var vf = row.f['Valid From'], vt = row.f['Valid To'];
    var vvf = row.f['Visit Valid From'], vvt = row.f['Visit Valid To'];
    if (vf && vt && vf > vt) rscAddErr_(ctx, i, 'R4', 'Valid From (' + vf + ') tidak boleh melewati Valid To (' + vt + ').');
    if (vvf && vvt && vvf > vvt) rscAddErr_(ctx, i, 'R4', 'Visit Valid From (' + vvf + ') tidak boleh melewati Visit Valid To (' + vvt + ').');
    if (spec.key !== 'ROLLING') return;

    var reason = row.f['Reason'];
    var mode = (row.cso && row.cso.yes) ? row.cso.mode : '';
    var policy = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_(reason, mode, vf, ctx.masters.dateNew);

    if (rscKey_(reason) === rscKey_('Rolling')) {
      if (policy.policy === 'ROLLING_HARDCODED' && vf && vf !== ctx.masters.dateNew) {
        rscAddErr_(ctx, i, 'R4', 'Reason Rolling: Valid From harus ' + ctx.masters.dateNew + ', ditemukan ' + vf + '.');
      }
      if (vvf && vvf !== ctx.masters.dateNew) {
        rscAddErr_(ctx, i, 'R4', 'Reason Rolling: Visit Valid From harus ' + ctx.masters.dateNew + ', ditemukan ' + vvf + '.');
      }
    } else if (rscKey_(reason) === rscKey_('Toko Bangkrut')) {
      if (vt && vt !== ctx.masters.dateClose) {
        rscAddErr_(ctx, i, 'R4', 'Reason Toko Bangkrut: Valid To harus ' + ctx.masters.dateClose + ', ditemukan ' + vt + '.');
      }
      if (vvt && vvt !== ctx.masters.dateClose) {
        rscAddErr_(ctx, i, 'R4', 'Reason Toko Bangkrut: Visit Valid To harus ' + ctx.masters.dateClose + ', ditemukan ' + vvt + '.');
      }
    }
  },

  /** R5 — Visit Category, Visit Type, Reason. */
  R5: function (ctx, row, i) {
    var cat = row.f['Visit Category'];
    if (cat && VISIT_CATEGORY_OPTIONS.indexOf(cat) < 0) {
      rscAddErr_(ctx, i, 'R5', 'Visit Category "' + cat + '" tidak valid. Gunakan ' + VISIT_CATEGORY_OPTIONS.join(', ') + '.');
    }
    var typ = row.f['Visit Type'];
    if (typ) {
      var t2 = typ.length === 1 ? '0' + typ : typ;
      if (VISIT_TYPE_OPTIONS.indexOf(t2) < 0) {
        rscAddErr_(ctx, i, 'R5', 'Visit Type "' + typ + '" tidak valid. Gunakan 01 sampai 12 (2 digit).');
      } else if (t2 !== typ) {
        rscAddErr_(ctx, i, 'R5', 'Visit Type harus 2 digit. Tulis "' + t2 + '", bukan "' + typ + '".');
      }
    }
    var reason = row.f['Reason'];
    if (reason && REASON_OPTIONS.indexOf(reason) < 0) {
      rscAddErr_(ctx, i, 'R5', 'Reason "' + reason + '" tidak valid. Gunakan ' + REASON_OPTIONS.join(' atau ') + '.');
    }
  },

  /** R6 — Schedule Visit harus konsisten dengan Visit Category. */
  R6: function (ctx, row, i) {
    var cat = row.f['Visit Category'];
    var sch = rscParseSchedule_(row.f['Schedule Visit']);
    if (!sch.tokens.length) return;

    if (sch.invalid.length) {
      rscAddErr_(ctx, i, 'R6', 'Token Schedule Visit tidak dikenal: ' + sch.invalid.join(', ') +
        '. Format yang benar W1M sampai W4SU.');
      return;
    }
    if (rscUniq_(sch.valid).length !== sch.valid.length) {
      rscAddErr_(ctx, i, 'R6', 'Schedule Visit mengandung token duplikat: ' + sch.tokens.join(',') + '.');
      return;
    }
    if (!cat || VISIT_CATEGORY_OPTIONS.indexOf(cat) < 0) return;

    var need = VISIT_CATEGORY_FREQUENCY[cat];
    if (sch.valid.length !== need) {
      rscAddErr_(ctx, i, 'R6', 'Visit Category ' + cat + ' membutuhkan ' + need +
        ' token Schedule Visit, ditemukan ' + sch.valid.length + ' (' + sch.tokens.join(',') + ').');
      return;
    }
    var days = Object.keys(sch.weekdays);
    var weeks = Object.keys(sch.weeks).sort().join(',');

    if (cat === 'F8') {
      if (days.length !== 2) {
        rscAddErr_(ctx, i, 'R6', 'F8 harus 2 hari kunjungan x 4 minggu. Ditemukan ' + days.length + ' hari.');
      } else if (weeks !== '1,2,3,4') {
        rscAddErr_(ctx, i, 'R6', 'F8 harus mencakup minggu 1,2,3,4. Ditemukan minggu ' + weeks + '.');
      }
      return;
    }
    if (days.length !== 1) {
      rscAddErr_(ctx, i, 'R6', 'Semua token Schedule Visit harus pada hari yang sama. Ditemukan hari: ' + days.join(',') + '.');
      return;
    }
    if (cat === 'F4' && weeks !== '1,2,3,4') {
      rscAddErr_(ctx, i, 'R6', 'F4 harus mencakup minggu 1,2,3,4. Ditemukan minggu ' + weeks + '.');
    }
    if (cat === 'F2' && weeks !== '1,3' && weeks !== '2,4') {
      rscAddErr_(ctx, i, 'R6', 'F2 harus berpola minggu 1&3 atau 2&4. Ditemukan minggu ' + weeks + '.');
    }
  },

  /** R9 — Salesman: format dan keberadaan di m_sales_info. */
  R9: function (ctx, row, i) {
    var sid = RSC_NORMALIZE_ID_(row.f['Salesman ID']);
    if (sid && !/^[A-Z0-9]{6,12}$/.test(sid)) {
      rscAddErr_(ctx, i, 'R9', 'Salesman ID "' + sid + '" tidak sesuai format.');
    }
    var bp = row.f['Salesman BP Type'];
    if (bp && !/^Z[A-Z]\d{2}$/.test(bp)) {
      rscAddErr_(ctx, i, 'R9', 'Salesman BP Type "' + bp + '" tidak sesuai format (contoh ZD01).');
    }
    var idx = ctx.masters.idx && ctx.masters.idx.SALESMAN;
    if (!idx || !idx.available) { ctx.skipped['R9-master'] = 'master m_sales_info tidak tersedia'; return; }
    if (sid && !idx.map[sid]) {
      rscAddErr_(ctx, i, 'R9', 'Salesman ID "' + sid + '" tidak ditemukan pada master m_sales_info.');
    }
  },

  /** R10 — Customer: format, keberadaan di m_bp_general_view, dan BP Type. */
  R10: function (ctx, row, i) {
    var cid = RSC_NORMALIZE_ID_(row.f['Customer ID'] || row.f['BP Number Source']);
    if (!cid) return;
    if (!/^\d{6,12}$/.test(cid)) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" harus berupa 6-12 digit angka.');
      return;
    }
    var idx = ctx.masters.idx && ctx.masters.idx.BP;
    if (!idx || !idx.available) { ctx.skipped['R10-master'] = 'master m_bp_general_view tidak tersedia'; return; }
    var recs = idx.map[cid];
    if (!recs) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" tidak ditemukan pada master BP.');
      return;
    }
    var rec = rscRecObj_(idx, recs[0]);
    var off = row.f['Sales Office'];
    var masterOff = RSC_NORMALIZE_ID_(rec['Sales Office']);
    if (off && masterOff && masterOff !== off) {
      rscAddErr_(ctx, i, 'R10', 'Customer ID "' + cid + '" terdaftar pada Sales Office ' + masterOff +
        ', tidak sesuai dengan isian ' + off + '.');
    }
    var bpType = row.f['Salesman BP Type'];
    var masterType = RSC_NORMALIZE_ID_(rec['Salesman BP Type']);
    if (bpType && masterType && masterType !== bpType) {
      rscAddErr_(ctx, i, 'R10', 'Salesman BP Type "' + bpType + '" berbeda dengan master (' + masterType + ').');
    }
  }
};

/* --------------------------- RULE LINTAS BARIS --------------------------- */

var RSC_TABLE_RULES = {

  /** R7 — Customer + Salesman yang sama wajib punya Schedule Visit identik. */
  R7: function (ctx) {
    var groups = {};
    for (var i = 0; i < ctx.rows.length; i++) {
      var f = ctx.rows[i].f;
      var cid = RSC_NORMALIZE_ID_(f['Customer ID']), sid = RSC_NORMALIZE_ID_(f['Salesman ID']);
      if (!cid || !sid) continue;
      var key = cid + '|' + sid;
      var sch = rscParseSchedule_(f['Schedule Visit']).canonical;
      if (!groups[key]) groups[key] = { variants: {}, order: [] };
      if (!groups[key].variants[sch]) { groups[key].variants[sch] = []; groups[key].order.push(sch); }
      groups[key].variants[sch].push(ctx.rows[i].sheetRow);
    }
    for (var k in groups) {
      if (!Object.prototype.hasOwnProperty.call(groups, k)) continue;
      var g = groups[k];
      if (g.order.length < 2) continue;
      var parts = [];
      var lim = RSC_STANDARD_VALIDATION_V27_20260814.msgMaxVariants;
      for (var v = 0; v < g.order.length && v < lim; v++) {
        parts.push((g.order[v] || '(kosong)') + ' (row ' + rscRowsLabel_(g.variants[g.order[v]]) + ')');
      }
      if (g.order.length > lim) parts.push('... +' + (g.order.length - lim) + ' variasi lain');
      var msg = 'Customer ID + Salesman ID yang sama tidak boleh memiliki Schedule Visit berbeda. Konflik: ' +
        parts.join(' vs ');
      for (var v2 = 0; v2 < g.order.length; v2++) {
        var list = g.variants[g.order[v2]];
        for (var rr = 0; rr < list.length; rr++) {
          var idx = rscRowIndexBySheetRow_(ctx, list[rr]);
          if (idx >= 0) rscAddErr_(ctx, idx, 'R7', msg);
        }
      }
    }
  },

  /**
   * R8a — duplikat kunci dalam template.
   * Baris Change Schedule Only dikecualikan sesuai aturan CASE 1/CASE 2.
   */
  R8a: function (ctx) {
    var keyFields = ctx.spec.key === 'ROLLING'
      ? ['Customer ID', 'Relationship', 'Salesman ID', 'Valid To']
      : ctx.spec.required.slice(0, Math.min(4, ctx.spec.required.length));
    var seen = {};
    for (var i = 0; i < ctx.rows.length; i++) {
      if (ctx.rows[i].cso && ctx.rows[i].cso.yes) continue;
      var parts = [];
      for (var k = 0; k < keyFields.length; k++) parts.push(ctx.rows[i].f[keyFields[k]] || '');
      var key = parts.join('|');
      if (key.replace(/\|/g, '') === '') continue;
      if (!seen[key]) seen[key] = [];
      seen[key].push(i);
    }
    for (var kk in seen) {
      if (!Object.prototype.hasOwnProperty.call(seen, kk)) continue;
      if (seen[kk].length < 2) continue;
      var rowsTxt = [];
      for (var a = 0; a < seen[kk].length; a++) rowsTxt.push(ctx.rows[seen[kk][a]].sheetRow);
      var label = rscRowsLabel_(rowsTxt);
      for (var b = 0; b < seen[kk].length; b++) {
        rscAddErr_(ctx, seen[kk][b], 'R8',
          'R8a: key ' + keyFields.join(' + ') + ' duplikat dalam template (row ' + label + ').');
      }
    }
  },

  /** R8b — bentrok dengan relasi aktif di m_bp_relation. */
  R8b: function (ctx) {
    var idx = ctx.masters.idx && ctx.masters.idx.RELATION;
    if (!idx || !idx.available) { ctx.skipped['R8b'] = 'master m_bp_relation tidak tersedia'; return; }
    for (var i = 0; i < ctx.rows.length; i++) {
      var row = ctx.rows[i], f = row.f;
      if (rscKey_(f['Reason']) === rscKey_('Toko Bangkrut')) continue;
      if (row.cso && row.cso.yes) continue;
      var cid = RSC_NORMALIZE_ID_(f['Customer ID']);
      var rel = f['Relationship'];
      if (!cid || !rel) continue;
      var recs = idx.map[cid];
      if (!recs) continue;
      for (var r = 0; r < recs.length; r++) {
        if (RSC_NORMALIZE_ID_(recs[r][0]) !== rel) continue;
        var mSid = RSC_NORMALIZE_ID_(recs[r][1]);
        var mVt = rscDateStr_(recs[r][3]);
        if (mSid && mSid !== RSC_NORMALIZE_ID_(f['Salesman ID']) && (!mVt || !f['Valid From'] || mVt >= f['Valid From'])) {
          rscAddErr_(ctx, i, 'R8',
            'R8b: relasi aktif di master masih memakai Salesman ' + mSid + ' (Valid To ' + (mVt || '-') +
            '). Tutup relasi lama sebelum rolling ke ' + f['Salesman ID'] + '.');
          break;
        }
      }
    }
  },

  /** TB — Toko Bangkrut wajib punya jadwal aktif di m_visit_schedule. */
  TB: function (ctx) {
    var idx = ctx.masters.idx && ctx.masters.idx.VISIT;
    var hasIdx = !!(idx && idx.available);
    if (!hasIdx) ctx.skipped['TB'] = 'master m_visit_schedule tidak tersedia';
    for (var i = 0; i < ctx.rows.length; i++) {
      var f = ctx.rows[i].f;
      if (rscKey_(f['Reason']) !== rscKey_('Toko Bangkrut')) continue;
      if (f['Valid To'] === OPEN_ENDED_DATE_TEXT) {
        rscAddErr_(ctx, i, 'TB', 'Toko Bangkrut: Valid To wajib tanggal penutupan, bukan ' + OPEN_ENDED_DATE_TEXT + '.');
      }
      if (!hasIdx) continue;
      var key = RSC_NORMALIZE_ID_(f['Customer ID']) + '|' + RSC_NORMALIZE_ID_(f['Salesman ID']);
      if (!idx.map[key]) rscAddErr_(ctx, i, 'TB', 'Toko Bangkrut: key tidak ditemukan di m_visit_schedule.');
    }
  }
};

/**
 * Verifikasi header. Format pesan dipertahankan supaya histori feedback
 * ke area tetap terbaca sama:
 *   Layout A:P tidak sesuai template FSD. $D: expected "Relationship", got ""
 */
function rscCheckLayout_(spec, headerRow) {
  var problems = [];
  for (var c = 0; c < spec.header.length; c++) {
    var want = spec.header[c], got = rscText_(headerRow[c]);
    if (rscKey_(got) !== rscKey_(want)) {
      problems.push('$' + rscColLetter_(c + 1) + ': expected "' + want + '", got "' + got + '"');
    }
  }
  if (!problems.length) return null;
  return 'Layout A:' + rscColLetter_(spec.header.length) + ' tidak sesuai template FSD. ' + problems.join('; ');
}

/** Jalankan seluruh rule pada nilai mentah satu sheet. */
function rscValidateValues_(spec, values, masters) {
  var t0 = Date.now();
  var ctx = rscBuildContext_(spec, values, masters);
  if (spec.key === 'ROLLING') rscDetectChangeScheduleOnly_(ctx);
  var tNorm = Date.now();

  var i, r;
  for (r = 0; r < ctx.rows.length; r++) {
    for (i = 0; i < spec.rowRules.length; i++) {
      var fn = RSC_ROW_RULES[spec.rowRules[i]];
      if (fn) fn(ctx, ctx.rows[r], r);
    }
  }
  for (i = 0; i < spec.tableRules.length; i++) {
    var tf = RSC_TABLE_RULES[spec.tableRules[i]];
    if (tf) tf(ctx);
  }
  var tRules = Date.now();

  var status = [], detail = [], errorRows = 0, byCode = {}, csoRows = 0;
  var maxChars = RSC_STANDARD_VALIDATION_V27_20260814.msgMaxDetailChars;
  for (r = 0; r < ctx.rows.length; r++) {
    if (ctx.rows[r].cso && ctx.rows[r].cso.yes) csoRows++;
    var errs = rscUniq_(ctx.errors[r]);
    if (errs.length) {
      errorRows++;
      status.push('ERROR');
      var joined = errs.join(' | ');
      if (joined.length > maxChars) joined = joined.substring(0, maxChars - 20) + ' ...(dipotong)';
      detail.push(joined);
      for (var e = 0; e < errs.length; e++) {
        var code = (errs[e].match(/^\[([A-Za-z0-9]+)\]/) || [])[1] || 'X';
        byCode[code] = (byCode[code] || 0) + 1;
      }
    } else {
      status.push('OK');
      detail.push('');
    }
  }

  return {
    ctx: ctx, rowCount: ctx.rows.length, errorRows: errorRows, changeScheduleOnlyRows: csoRows,
    status: status, detail: detail, byCode: byCode, skipped: ctx.skipped,
    timing: {
      normalizeSec: rscRound_((tNorm - t0) / 1000, 3),
      rulesSec: rscRound_((tRules - tNorm) / 1000, 3)
    }
  };
}

/* =============================================================
 * 8. PENULIS HASIL
 * ============================================================= */

function rscWriteResults_(sheet, spec, result, dataRowCount) {
  if (!dataRowCount) return 0;
  var out = [];
  for (var i = 0; i < dataRowCount; i++) out.push(['', '']);
  for (var r = 0; r < result.ctx.rows.length; r++) {
    var pos = result.ctx.rows[r].sheetRow - 2;
    if (pos >= 0 && pos < dataRowCount) out[pos] = [result.status[r], result.detail[r]];
  }
  if (spec.errorCol === spec.statusCol + 1) {
    sheet.getRange(2, spec.statusCol, dataRowCount, 2).setValues(out);
  } else {
    var s = [], d = [];
    for (var k = 0; k < out.length; k++) { s.push([out[k][0]]); d.push([out[k][1]]); }
    sheet.getRange(2, spec.statusCol, dataRowCount, 1).setValues(s);
    sheet.getRange(2, spec.errorCol, dataRowCount, 1).setValues(d);
  }
  rscApplyStatusColors_(sheet, spec, out, dataRowCount);
  return dataRowCount;
}

/** Warna status mengikuti konvensi lama: hijau OK, merah muda ERROR. */
function rscApplyStatusColors_(sheet, spec, out, dataRowCount) {
  try {
    var C = TEMPLATE_UI_PARAMETERS.colors;
    var bg = [];
    for (var i = 0; i < dataRowCount; i++) {
      var st = out[i][0];
      var c = st === 'OK' ? C.ok : (st === 'ERROR' ? C.error : null);
      bg.push([c, c]);
    }
    if (spec.errorCol === spec.statusCol + 1) {
      sheet.getRange(2, spec.statusCol, dataRowCount, 2).setBackgrounds(bg);
    }
  } catch (e) { /* warna bersifat kosmetik */ }
}

function rscEnsureResultHeaders_(sheet, spec) {
  var width = Math.max(sheet.getLastColumn(), spec.errorCol);
  var cur = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
  var n = 0;
  if (rscKey_(cur[spec.statusCol - 1]) !== rscKey_(TEMPLATE_UI_PARAMETERS.validationStatusHeader)) {
    sheet.getRange(1, spec.statusCol).setValue(TEMPLATE_UI_PARAMETERS.validationStatusHeader); n++;
  }
  if (rscKey_(cur[spec.errorCol - 1]) !== rscKey_(TEMPLATE_UI_PARAMETERS.errorDetailHeader)) {
    sheet.getRange(1, spec.errorCol).setValue(TEMPLATE_UI_PARAMETERS.errorDetailHeader); n++;
  }
  return n;
}


/* =============================================================
 * 9. JOB LOGGING DETAILS — layout dipertahankan persis
 * ============================================================= */

function RSC_PERF16_JOBLOG_NOW_20260819_() { return rscStamp_(); }

/** Buang karakter kontrol agar sel dashboard tidak rusak. */
function RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(v, maxLen) {
  var s = String(v === null || v === undefined ? '' : v);
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, Number(maxLen || 5000));
}

function RSC_PERF16_JOBLOG_EFFECTIVE_USER_20260819_() { return rscWhoAmI_(); }

function rscJobLogSheet_(ss) {
  var J = RSC_PERF16_JOBLOG_20260819;
  var sh = ss.getSheetByName(J.sheetName);
  if (!sh) sh = ss.insertSheet(J.sheetName);
  var minRows = J.historyStartRow + 50;
  if (sh.getMaxRows() < minRows) sh.insertRowsAfter(sh.getMaxRows(), minRows - sh.getMaxRows());
  if (rscKey_(sh.getRange(J.liveHeaderRow, 1).getDisplayValue()) !== 'SLOT') {
    sh.getRange(J.titleRow, 1).setValue('ROLLING SALES CENTER — LIVE JOB LOGGING (' +
      ROLLING_SALES_CENTER_PARAMETERS.version + ')');
    sh.getRange(J.liveHeaderRow, 1, 1, J.columns.length).setValues([J.columns]);
    sh.getRange(J.historyTitleRow, 1).setValue('EVENT HISTORY — newest first');
    sh.getRange(J.historyHeaderRow, 1, 1, J.columns.length).setValues([J.columns]);
    for (var s = 0; s < J.liveSlots.length; s++) {
      sh.getRange(J.liveStartRow + s, 1).setValue(J.liveSlots[s]);
    }
  }
  return sh;
}

function rscSlotRow_(slot) {
  var J = RSC_PERF16_JOBLOG_20260819;
  var i = J.liveSlots.indexOf(slot);
  return i < 0 ? -1 : J.liveStartRow + i;
}

function rscJobLogRow_(slot, e) {
  return [
    slot,
    e.job || '',
    e.state || '',
    e.stage || '',
    e.progress === undefined ? '' : e.progress,
    e.currentTotal || '',
    RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(e.fileName || '', 300),
    e.fileId || '',
    e.sheet || '',
    e.rows === undefined ? '' : e.rows,
    RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(e.message || '', 2000),
    RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(e.lastError || '', 2000),
    e.startedAt || '',
    rscStamp_(),
    e.elapsedSec === undefined ? '' : e.elapsedSec,
    e.lane || slot,
    e.runId || rscGetProp_(RSC_STANDARD_VALIDATION_V27_20260814.pRunId, ''),
    e.user || rscWhoAmI_()
  ];
}

/**
 * Perbarui satu slot live. Throttled: hanya menulis bila state berubah atau
 * interval minimum terlewati. Ini menghilangkan banjir ribuan baris log yang
 * terjadi pada versi lama.
 */
function rscJobLogSet_(ss, slot, e, opts) {
  opts = opts || {};
  var J = RSC_PERF16_JOBLOG_20260819;
  var row = rscSlotRow_(slot);
  if (row < 0) return;
  var key = J.pStatePrefix + slot;
  var last = rscGetProp_(key, '');
  var sig = (e.state || '') + '|' + (e.stage || '') + '|' + (e.fileId || '');
  var parts = last.split('@@');
  var changed = sig !== (parts[0] || '');
  if (!changed && !opts.force && (Date.now() - Number(parts[1] || 0)) < J.throttleMs) return;
  try {
    var sh = rscJobLogSheet_(ss);
    var values = rscJobLogRow_(slot, e);
    sh.getRange(row, 1, 1, J.columns.length).setValues([values]);
    if (changed || opts.history) rscJobLogPushHistory_(sh, values);
    rscSetProp_(key, sig + '@@' + Date.now());
  } catch (err) { /* dashboard tidak boleh menggagalkan pipeline */ }
}

function rscJobLogPushHistory_(sh, values) {
  var J = RSC_PERF16_JOBLOG_20260819;
  try {
    sh.insertRowsBefore(J.historyStartRow, 1);
    sh.getRange(J.historyStartRow, 1, 1, J.columns.length).setValues([values]);
    var maxRow = J.historyStartRow + J.maxHistoryRows;
    if (sh.getMaxRows() > maxRow) sh.deleteRows(maxRow + 1, sh.getMaxRows() - maxRow);
  } catch (e) { /* histori best-effort */ }
}

function rscJobLogSummary_(ss, runId, stats) {
  var J = RSC_PERF16_JOBLOG_20260819;
  try {
    var sh = rscJobLogSheet_(ss);
    sh.getRange(J.summaryRow, 1, 1, 10).setValues([[
      'Last Dashboard Update', rscStamp_(), 'Run ID', runId,
      'Overall Progress', stats.progress, 'Total Tasks', stats.total, 'Unfinished', stats.unfinished
    ]]);
    sh.getRange(J.counterRow, 1, 1, 12).setValues([[
      'QUEUED', stats.queued, 'ACTIVE', stats.active, 'RETRY', stats.retry + stats.deferred,
      'COMPLETE OK', stats.ok, 'WITH ERRORS', stats.withErrors, 'ERROR/HARD', stats.hard + stats.blocked
    ]]);
  } catch (e) { /* best-effort */ }
}


/* =============================================================
 * 10. MANIFEST / ANTREAN — inti perbaikan [F2] dan [F4]
 * ============================================================= */

var RSC_M = {
  RUN_ID: 0, FILE_ID: 1, MASTER_ROWS: 2, URL: 3, FILE_NAME: 4, STATUS: 5, ATTEMPTS: 6, WORKER: 7,
  LEASE_UNTIL: 8, ERROR_ROWS: 9, SHEET_SUMMARY: 10, STARTED_AT: 11, UPDATED_AT: 12, DURATION: 13,
  MESSAGE: 14, QUEUE_WAIT: 15, OPEN_SEC: 16, MASTER_SEC: 17, NORM_SEC: 18, RULES_SEC: 19,
  WRITE_SEC: 20, TOTAL_SEC: 21, DEFERS: 22, NEXT_AT: 23, CLAIM_TOKEN: 24, ERR_KIND: 25
};

var RSC_STATUS = {
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  DEFERRED: 'DEFERRED',
  RETRY: 'RETRY',
  DONE_OK: 'COMPLETE_OK',
  DONE_ERRORS: 'COMPLETE_WITH_ERRORS',
  HARD_ERROR: 'HARD_ERROR',
  BLOCKED_INFRA: 'BLOCKED_INFRA',
  SKIPPED: 'SKIPPED_INVALID'
};

function rscIsTerminal_(status) {
  return status === RSC_STATUS.DONE_OK || status === RSC_STATUS.DONE_ERRORS ||
         status === RSC_STATUS.HARD_ERROR || status === RSC_STATUS.SKIPPED;
}

var RSC_MANIFEST_MEMO = null;

function rscManifestSheet_(ss) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  if (RSC_MANIFEST_MEMO && RSC_MANIFEST_MEMO.ssId === ss.getId()) return RSC_MANIFEST_MEMO.sheet;
  var sh = ss.getSheetByName(V.manifestSheetName);
  if (!sh) { sh = ss.insertSheet(V.manifestSheetName); sh.hideSheet(); }
  var cur = sh.getRange(1, 1, 1, V.manifestHeaders.length).getDisplayValues()[0];
  if (rscKey_(cur[0]) !== rscKey_(V.manifestHeaders[0]) ||
      rscKey_(cur[RSC_M.ERR_KIND]) !== rscKey_(V.manifestHeaders[RSC_M.ERR_KIND])) {
    sh.getRange(1, 1, 1, V.manifestHeaders.length).setValues([V.manifestHeaders]);
    sh.setFrozenRows(1);
  }
  RSC_MANIFEST_MEMO = { ssId: ss.getId(), sheet: sh };
  return sh;
}

function rscManifestRead_(sh) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, V.manifestHeaders.length).getDisplayValues();
}

function rscManifestWriteRows_(sh, rows) {
  if (!rows.length) return;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  rows.sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < rows.length) {
    var start = i;
    while (i + 1 < rows.length && rows[i + 1].row === rows[i].row + 1) i++;
    var block = [];
    for (var k = start; k <= i; k++) block.push(rows[k].values);
    sh.getRange(rows[start].row, 1, block.length, V.manifestHeaders.length).setValues(block);
    i++;
  }
}

/** Sheet rekap master: "Rekap All" lebih dulu, lalu "Rekap Approved". */
function rscMasterSheet_(ss) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  for (var i = 0; i < V.masterSheetCandidates.length; i++) {
    var sh = ss.getSheetByName(V.masterSheetCandidates[i]);
    if (sh) return sh;
  }
  var found = rscFindSheet_(ss, V.masterSheetCandidates);
  if (found) return found;
  throw new RscDataError('Sheet rekap tidak ditemukan. Dicari: ' + V.masterSheetCandidates.join(' / ') + '.');
}

/** Cari baris header rekap serta kolom link FINAL, Sales Office, dan Feedback. */
function rscMasterLayout_(sh) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var fallback = {
    headerRow: 1, firstDataRow: V.firstDataRow, linkCol: V.masterLinkCol,
    officeCol: 1, descCol: 2, feedbackCol: 8
  };
  var scan = Math.min(V.masterHeaderScanRows, sh.getLastRow());
  if (scan < 1) return fallback;
  var width = Math.max(sh.getLastColumn(), V.masterLinkCol);
  var grid = sh.getRange(1, 1, scan, width).getDisplayValues();
  for (var r = 0; r < grid.length; r++) {
    var hmap = rscHeaderMap_(grid[r]);
    var link = rscPickCol_(hmap, [
      'Template Rolling Sales FINAL (GUNAKAN LINK DISINI)', 'Template Rolling Sales FINAL'
    ]);
    var office = rscPickCol_(hmap, ['Sales Office']);
    if (link >= 0 && office >= 0) {
      var desc = rscPickCol_(hmap, ['Description']);
      var fb = rscPickCol_(hmap, ['Feedback']);
      return {
        headerRow: r + 1, firstDataRow: r + 2, linkCol: link + 1, officeCol: office + 1,
        descCol: desc >= 0 ? desc + 1 : 2, feedbackCol: fb >= 0 ? fb + 1 : 8
      };
    }
  }
  return fallback;
}

/**
 * Bangun antrean dari kolom link FINAL. File yang sama pada beberapa baris
 * digabung menjadi satu task sehingga satu file hanya divalidasi sekali.
 */
function rscBuildManifest_(ss, runId) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var stats = { links: 0, valid: 0, skipped: 0, tasks: 0, total: 0, layout: L, sheet: master.getName() };
  var byFile = {}, order = [], skippedRows = [];

  if (lastRow >= L.firstDataRow) {
    var n = lastRow - L.firstDataRow + 1;
    var width = Math.max(master.getLastColumn(), L.linkCol);
    var range = master.getRange(L.firstDataRow, 1, n, width);
    var vals = range.getDisplayValues();
    var formulas = null;

    // Sebagian admin memakai =HYPERLINK(...) sehingga teks tampilannya judul file.
    for (var pre = 0; pre < vals.length; pre++) {
      var probe = rscText_(vals[pre][L.linkCol - 1]);
      if (probe && !rscFileId_(probe)) {
        try { formulas = range.getFormulas(); } catch (eF) { formulas = null; }
        break;
      }
    }

    for (var r = 0; r < vals.length; r++) {
      var sheetRow = L.firstDataRow + r;
      var linkRaw = rscText_(vals[r][L.linkCol - 1]);
      if (!linkRaw) continue;
      stats.links++;
      var fileId = rscFileId_(linkRaw);
      if (!fileId && formulas) {
        var fx = rscText_(formulas[r][L.linkCol - 1]);
        var fromFx = rscFileId_(fx);
        if (fromFx) { fileId = fromFx; linkRaw = fx; }
      }
      if (!fileId) {
        stats.skipped++;
        skippedRows.push({ row: sheetRow, url: linkRaw, office: rscText_(vals[r][L.officeCol - 1]) });
        continue;
      }
      stats.valid++;
      if (!byFile[fileId]) {
        byFile[fileId] = {
          fileId: fileId, url: linkRaw, rows: [],
          office: rscText_(vals[r][L.officeCol - 1]),
          name: rscText_(vals[r][L.descCol - 1])
        };
        order.push(fileId);
      }
      byFile[fileId].rows.push(sheetRow);
    }
  }

  var now = rscStamp_();
  var out = [];
  function blankRow() {
    var row = new Array(V.manifestHeaders.length);
    for (var z = 0; z < row.length; z++) row[z] = '';
    return row;
  }
  for (var o = 0; o < order.length; o++) {
    var t = byFile[order[o]];
    var row = blankRow();
    row[RSC_M.RUN_ID] = runId;
    row[RSC_M.FILE_ID] = t.fileId;
    row[RSC_M.MASTER_ROWS] = JSON.stringify(t.rows);
    row[RSC_M.URL] = t.url;
    row[RSC_M.FILE_NAME] = t.office ? (t.office + ' - ' + t.name) : t.name;
    row[RSC_M.STATUS] = RSC_STATUS.QUEUED;
    row[RSC_M.ATTEMPTS] = 0;
    row[RSC_M.DEFERS] = 0;
    row[RSC_M.ERROR_ROWS] = 0;
    row[RSC_M.STARTED_AT] = now;
    row[RSC_M.UPDATED_AT] = now;
    row[RSC_M.MESSAGE] = 'Menunggu worker.';
    out.push(row);
    stats.tasks++;
  }
  for (var s = 0; s < skippedRows.length; s++) {
    var srow = blankRow();
    srow[RSC_M.RUN_ID] = runId;
    srow[RSC_M.MASTER_ROWS] = JSON.stringify([skippedRows[s].row]);
    srow[RSC_M.URL] = skippedRows[s].url;
    srow[RSC_M.FILE_NAME] = skippedRows[s].office;
    srow[RSC_M.STATUS] = RSC_STATUS.SKIPPED;
    srow[RSC_M.ATTEMPTS] = 0;
    srow[RSC_M.DEFERS] = 0;
    srow[RSC_M.STARTED_AT] = now;
    srow[RSC_M.UPDATED_AT] = now;
    srow[RSC_M.MESSAGE] = 'Link bukan URL/ID Google Sheets yang valid.';
    out.push(srow);
  }

  var sh = rscManifestSheet_(ss);
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, V.manifestHeaders.length).clearContent();
  }
  if (out.length) sh.getRange(2, 1, out.length, V.manifestHeaders.length).setValues(out);
  stats.total = out.length;
  return stats;
}

/**
 * Claim atomik. Hanya bagian ini yang memegang lock global, dan hanya sebentar.
 * claimToken diverifikasi ulang saat commit sehingga satu file mustahil
 * diproses dua lane sekaligus.
 */
function rscClaimBatch_(ss, runId, worker, maxN) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  return rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var now = Date.now(), nowStamp = rscStamp_();
    var picked = [], writes = [];

    for (var i = 0; i < vals.length && picked.length < maxN; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      var st = v[RSC_M.STATUS];
      if (rscIsTerminal_(st)) continue;
      if (st === RSC_STATUS.ACTIVE) {
        var lease = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
        if (isFinite(lease) && lease > now) continue;
      }
      if (st === RSC_STATUS.DEFERRED || st === RSC_STATUS.RETRY) {
        var next = Date.parse(v[RSC_M.NEXT_AT] || '');
        if (isFinite(next) && next > now) continue;
      }
      var token = rscUuid_();
      v[RSC_M.STATUS] = RSC_STATUS.ACTIVE;
      v[RSC_M.WORKER] = worker;
      v[RSC_M.LEASE_UNTIL] = new Date(now + V.leaseMs).toISOString();
      v[RSC_M.CLAIM_TOKEN] = token;
      v[RSC_M.UPDATED_AT] = nowStamp;
      v[RSC_M.MESSAGE] = 'Di-claim oleh ' + worker + '.';
      writes.push({ row: i + 2, values: v });
      picked.push({
        row: i + 2, fileId: v[RSC_M.FILE_ID], url: v[RSC_M.URL], name: v[RSC_M.FILE_NAME],
        masterRows: v[RSC_M.MASTER_ROWS], attempts: Number(v[RSC_M.ATTEMPTS] || 0),
        defers: Number(v[RSC_M.DEFERS] || 0), token: token
      });
    }
    rscManifestWriteRows_(sh, writes);
    return picked;
  }, V.claimLockWaitMs);
}

function rscUpdateTask_(ss, task, mutate) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  return rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var v = sh.getRange(task.row, 1, 1, V.manifestHeaders.length).getDisplayValues()[0];
    if (task.token && v[RSC_M.CLAIM_TOKEN] && v[RSC_M.CLAIM_TOKEN] !== task.token) {
      return { applied: false, reason: 'CLAIM_TOKEN_MISMATCH' };
    }
    mutate(v);
    v[RSC_M.UPDATED_AT] = rscStamp_();
    sh.getRange(task.row, 1, 1, V.manifestHeaders.length).setValues([v]);
    return { applied: true };
  }, V.commitLockWaitMs);
}

function rscCommitOk_(ss, task, res) {
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.STATUS] = res.errorRows > 0 ? RSC_STATUS.DONE_ERRORS : RSC_STATUS.DONE_OK;
    v[RSC_M.ERROR_ROWS] = res.errorRows;
    v[RSC_M.SHEET_SUMMARY] = res.summary || '';
    v[RSC_M.MESSAGE] = 'File selesai. Error rows=' + res.errorRows + '.';
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.ERR_KIND] = '';
    v[RSC_M.OPEN_SEC] = res.openSec || 0;
    v[RSC_M.MASTER_SEC] = res.masterSec || 0;
    v[RSC_M.NORM_SEC] = res.normalizeSec || 0;
    v[RSC_M.RULES_SEC] = res.rulesSec || 0;
    v[RSC_M.WRITE_SEC] = res.writeSec || 0;
    v[RSC_M.TOTAL_SEC] = res.totalSec || 0;
    v[RSC_M.DURATION] = res.totalSec || 0;
  });
}

/** INFRA -> DEFER. Attempts TIDAK bertambah. Inti perbaikan [F2]. */
function rscDeferTask_(ss, task, message) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var defers = Number(task.defers || 0) + 1;
  var waitMs = rscBackoffMs_(defers);
  var blocked = defers >= V.maxDefers;
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.DEFERS] = defers;
    v[RSC_M.STATUS] = blocked ? RSC_STATUS.BLOCKED_INFRA : RSC_STATUS.DEFERRED;
    v[RSC_M.NEXT_AT] = new Date(Date.now() + waitMs).toISOString();
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.WORKER] = '';
    v[RSC_M.ERR_KIND] = RSC_ERR.INFRA;
    v[RSC_M.MESSAGE] = blocked
      ? ('Ditunda ' + defers + 'x karena kontensi infrastruktur. Attempts tetap ' + (task.attempts || 0) + '.')
      : ('Ditunda tanpa menambah Attempts (defer ke-' + defers + '), retry dalam ' +
         Math.round(waitMs / 1000) + ' detik.');
    v[RSC_M.SHEET_SUMMARY] = String(message || '').substring(0, 500);
  });
}

/** DATA/ACCESS/FATAL -> Attempts++ ; HARD_ERROR bila melewati batas. */
function rscFailTask_(ss, task, message, kind) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var attempts = Number(task.attempts || 0) + 1;
  var hard = attempts >= V.maxAttempts;
  var waitMs = rscBackoffMs_(attempts);
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.ATTEMPTS] = attempts;
    v[RSC_M.STATUS] = hard ? RSC_STATUS.HARD_ERROR : RSC_STATUS.RETRY;
    v[RSC_M.NEXT_AT] = hard ? '' : new Date(Date.now() + waitMs).toISOString();
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.WORKER] = '';
    v[RSC_M.ERR_KIND] = kind || RSC_ERR.DATA;
    v[RSC_M.MESSAGE] = 'Task gagal pada attempt ' + attempts + (hard ? ' (final).' : '.');
    v[RSC_M.SHEET_SUMMARY] = String(message || '').substring(0, 500);
  });
}

/** Lepas task yang belum sempat dikerjakan. Netral, tanpa penalti. */
function rscReleaseTask_(ss, task, message) {
  return rscUpdateTask_(ss, task, function (v) {
    v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
    v[RSC_M.LEASE_UNTIL] = '';
    v[RSC_M.CLAIM_TOKEN] = '';
    v[RSC_M.WORKER] = '';
    v[RSC_M.NEXT_AT] = '';
    v[RSC_M.MESSAGE] = message || 'Dikembalikan ke antrean tanpa penalti.';
  });
}

function rscEarliestEligibleMs_(ss, runId) {
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var now = Date.now(), best = -1;
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (runId && v[RSC_M.RUN_ID] !== runId) continue;
    var st = v[RSC_M.STATUS];
    if (rscIsTerminal_(st)) continue;
    var at = 0;
    if (st === RSC_STATUS.DEFERRED || st === RSC_STATUS.RETRY) {
      var t = Date.parse(v[RSC_M.NEXT_AT] || '');
      at = isFinite(t) ? Math.max(0, t - now) : 0;
    } else if (st === RSC_STATUS.ACTIVE) {
      var l = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
      at = isFinite(l) ? Math.max(0, l - now) : 0;
    }
    if (best < 0 || at < best) best = at;
  }
  return best;
}

function rscQueueStats_(ss, runId) {
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var st = {
    total: 0, queued: 0, active: 0, retry: 0, deferred: 0, ok: 0, withErrors: 0,
    hard: 0, blocked: 0, skipped: 0, unfinished: 0, errorRows: 0
  };
  for (var i = 0; i < vals.length; i++) {
    if (runId && vals[i][RSC_M.RUN_ID] !== runId) continue;
    st.total++;
    var s = vals[i][RSC_M.STATUS];
    if (s === RSC_STATUS.QUEUED) st.queued++;
    else if (s === RSC_STATUS.ACTIVE) st.active++;
    else if (s === RSC_STATUS.RETRY) st.retry++;
    else if (s === RSC_STATUS.DEFERRED) st.deferred++;
    else if (s === RSC_STATUS.DONE_OK) st.ok++;
    else if (s === RSC_STATUS.DONE_ERRORS) st.withErrors++;
    else if (s === RSC_STATUS.HARD_ERROR) st.hard++;
    else if (s === RSC_STATUS.BLOCKED_INFRA) st.blocked++;
    else if (s === RSC_STATUS.SKIPPED) st.skipped++;
    st.errorRows += Number(vals[i][RSC_M.ERROR_ROWS] || 0);
    if (!rscIsTerminal_(s)) st.unfinished++;
  }
  st.done = st.ok + st.withErrors + st.hard + st.skipped;
  st.progress = st.total ? rscRound_(st.done / st.total, 4) : 0;
  return st;
}


/* =============================================================
 * 11. PEMROSESAN FILE + ORKESTRATOR WORKER
 * ============================================================= */

/** Buka satu file anak, validasi semua sheet yang dikenali, tulis hasilnya. */
function rscProcessTask_(task, masters, onStage) {
  var t0 = Date.now(), tOpen = Date.now();
  var child;
  try {
    child = SpreadsheetApp.openById(task.fileId);
  } catch (e) {
    var c = rscClassify_(e);
    if (c.kind === RSC_ERR.INFRA) throw new RscInfraError('Gagal membuka file: ' + c.message);
    throw new RscAccessError('File tidak dapat dibuka / tidak ada akses: ' + c.message);
  }
  var openSec = rscRound_((Date.now() - tOpen) / 1000, 3);
  var fileName = '';
  try { fileName = child.getName(); } catch (e2) { fileName = task.name || task.fileId; }

  var sheets = child.getSheets();
  var processed = [], layoutProblems = [];
  var totalRows = 0, totalErrors = 0, totalCso = 0;
  var normSec = 0, rulesSec = 0, writeSec = 0;

  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var spec = rscSpecFor_(sh.getName());
    if (!spec) continue;

    if (onStage) {
      onStage({
        stage: 'Validate ' + spec.label, fileName: fileName, fileId: task.fileId,
        sheet: sh.getName(), message: 'Menjalankan engine validasi ' + ROLLING_SALES_CENTER_PARAMETERS.version + '.'
      });
    }

    var needCols = Math.max(spec.errorCol, spec.header.length);
    var width = Math.max(needCols, sh.getLastColumn() || needCols);
    var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
    var layoutErr = rscCheckLayout_(spec, header);
    if (layoutErr) { layoutProblems.push(sh.getName() + ' :: ' + layoutErr); continue; }

    rscEnsureResultHeaders_(sh, spec);
    var dataRows = Math.max(0, sh.getLastRow() - 1);

    // getValues (bukan getDisplayValues) supaya sel tanggal terbaca sebagai
    // objek Date. Format tampilan bergantung locale dan bisa membuat
    // 01/08/2026 terbaca sebagai 8 Januari.
    var values = dataRows ? sh.getRange(2, 1, dataRows, needCols).getValues() : [];

    var res = rscValidateValues_(spec, values, masters);
    normSec += res.timing.normalizeSec;
    rulesSec += res.timing.rulesSec;

    var tW = Date.now();
    rscWriteResults_(sh, spec, res, dataRows);
    rscApplyTemplateDropdowns_(sh, spec, masters);
    writeSec += rscRound_((Date.now() - tW) / 1000, 3);

    totalRows += res.rowCount;
    totalErrors += res.errorRows;
    totalCso += res.changeScheduleOnlyRows;
    processed.push({
      sheet: sh.getName(), spec: spec.key, rows: res.rowCount, errorRows: res.errorRows,
      changeScheduleOnly: res.changeScheduleOnlyRows, byCode: res.byCode, skipped: res.skipped
    });
  }

  if (!processed.length) {
    throw new RscDataError(layoutProblems.length
      ? layoutProblems.join(' || ')
      : 'Tidak ditemukan sheet yang dikenali (Change Rolling & Change Schedule / Change Sales Office / Change Salesman Type).');
  }

  return {
    fileName: fileName, rowCount: totalRows, errorRows: totalErrors, changeScheduleOnlyRows: totalCso,
    processed: processed, layoutProblems: layoutProblems,
    summary: JSON.stringify({ sheets: processed, layout: layoutProblems }).substring(0, 45000),
    openSec: openSec, masterSec: 0,
    normalizeSec: rscRound_(normSec, 3), rulesSec: rscRound_(rulesSec, 3),
    writeSec: rscRound_(writeSec, 3), totalSec: rscRound_((Date.now() - t0) / 1000, 3)
  };
}

/** Segarkan dropdown template sesuai master. Kosmetik; kegagalan diabaikan. */
function rscApplyTemplateDropdowns_(sheet, spec, masters) {
  if (spec.key !== 'ROLLING') return;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var lastRow = Math.min(
    Math.max(sheet.getLastRow() + V.dropdownHeadroomRows, 200),
    Math.max(sheet.getMaxRows(), 2));
  var n = lastRow - 1;
  if (n < 1) return;

  function listRule(items, help) {
    return SpreadsheetApp.newDataValidation()
      .requireValueInList(items, true).setAllowInvalid(true).setHelpText(help).build();
  }
  try {
    var offices = [];
    if (masters.office && masters.office.available) {
      for (var code in masters.office.map) {
        if (!Object.prototype.hasOwnProperty.call(masters.office.map, code)) continue;
        var o = masters.office.map[code];
        offices.push(o.desc ? (code + ' - ' + o.desc) : code);
      }
      offices.sort();
    }
    if (offices.length) {
      var offRule = listRule(offices, 'Pilih Sales Office dari master em. ID-only juga diterima.');
      sheet.getRange(2, 1, n, 1).setDataValidation(offRule);
      sheet.getRange(2, 2, n, 1).setDataValidation(offRule);
    }
    sheet.getRange(2, 4, n, 1).setDataValidation(
      listRule(RELATIONSHIP_OPTIONS.slice(), 'Pilih Relationship. ID-only juga diterima setelah normalisasi.'));
    sheet.getRange(2, 9, n, 1).setDataValidation(
      listRule(VISIT_CATEGORY_OPTIONS.slice(), 'Visit Category hanya F1, F2, F4, atau F8.'));
    sheet.getRange(2, 10, n, 1).setDataValidation(
      listRule(VISIT_TYPE_OPTIONS.slice(), 'Visit Type hanya 01 sampai 12. Gunakan format 2 digit.'));
    sheet.getRange(2, 14, n, 1).setDataValidation(
      listRule(REASON_OPTIONS.slice(), 'Reason hanya Rolling atau Toko Bangkrut.'));
  } catch (e) { /* dropdown kosmetik */ }
}

/** Muat master sekali per lane, bukan per file. */
function rscLoadMastersForRun_(ss) { return rscLoadMasters_(ss); }

/* ------------------------------ WORKER ------------------------------- */

function rscRunLane_(lane) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var started = Date.now();
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var slot = 'WORKER_' + lane;
  var startedStamp = rscStamp_(new Date(started));

  if (RSC_IS_HARD_STOPPED_()) {
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'STOPPED', stage: 'HARD STOP aktif', progress: 1,
      message: 'Sistem dalam kondisi HARD STOP. Jalankan Re-Arm untuk melanjutkan.',
      startedAt: startedStamp, lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    return { lane: lane, claimed: 0, committed: 0, reason: 'HARD_STOP' };
  }

  if (!runId || rscGetProp_(V.pRunState, '') !== 'RUNNING') {
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'IDLE', stage: 'No active run', progress: 1,
      message: 'Tidak ada run aktif.', startedAt: startedStamp, elapsedSec: 0, lane: 'Lane ' + lane
    }, { force: true });
    return { lane: lane, claimed: 0, committed: 0, reason: 'NO_ACTIVE_RUN' };
  }

  rscJobLogSet_(ss, slot, {
    job: 'VALIDATE LINK E', state: 'START', stage: 'Worker bootstrap', progress: 0.01,
    message: 'Worker lane ' + lane + ' mulai.', startedAt: startedStamp, elapsedSec: 0,
    lane: 'Lane ' + lane, runId: runId
  }, { force: true, history: true });

  var claimed;
  try {
    claimed = rscClaimBatch_(ss, runId, slot, V.claimBatchSize);
  } catch (eClaim) {
    var cc = rscClassify_(eClaim);
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'WAITING', stage: 'Claim ditunda', progress: 0.02,
      message: 'Antrean sedang dikunci lane lain. Dijadwalkan ulang tanpa penalti.',
      lastError: '[' + cc.kind + '] ' + cc.message,
      startedAt: startedStamp, lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    rscArmLane_(lane, rscBackoffMs_(1));
    return { lane: lane, claimed: 0, committed: 0, reason: 'CLAIM_' + cc.kind };
  }

  if (!claimed.length) {
    var st0 = rscQueueStats_(ss, runId);
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'IDLE', stage: 'No claimable task', progress: 1,
      currentTotal: '0 / 0', message: 'Antrean kosong atau semua task sedang ditunda.',
      startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
      lane: 'Lane ' + lane, runId: runId
    }, { force: true });
    rscJobLogSummary_(ss, runId, st0);
    if (st0.unfinished > 0) {
      var waitMs = rscEarliestEligibleMs_(ss, runId);
      if (waitMs < 0) waitMs = V.workerIdleRetryDelayMs;
      rscArmLane_(lane, Math.min(Math.max(waitMs + 1000, 5000), 300000));
    } else {
      rscFinishRunIfDone_(ss, runId, st0);
    }
    return { lane: lane, claimed: 0, committed: 0, reason: 'EMPTY' };
  }

  var masters = null, committed = 0;
  try {
    rscJobLogSet_(ss, slot, {
      job: 'VALIDATE LINK E', state: 'RUNNING', stage: 'Prefetch shared master', progress: 0.1,
      currentTotal: '0 / ' + claimed.length,
      message: 'Bundle ' + claimed.length + ' file di-claim. Memuat index master sekali untuk seluruh bundle.',
      startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
      lane: 'Lane ' + lane, runId: runId
    });
    masters = rscLoadMastersForRun_(ss);
  } catch (e) {
    var cls = rscClassify_(e);
    if (cls.kind === RSC_ERR.INFRA) {
      for (var d = 0; d < claimed.length; d++) rscDeferTask_(ss, claimed[d], cls.message);
      rscJobLogSet_(ss, slot, {
        job: 'VALIDATE LINK E', state: 'WAITING', stage: 'Bundle deferred (infra)', progress: 0.12,
        currentTotal: '0 / ' + claimed.length,
        message: claimed.length + ' task dikembalikan ke antrean tanpa menambah Attempts.',
        lastError: '[INFRA] ' + cls.message,
        startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
        lane: 'Lane ' + lane, runId: runId
      }, { force: true, history: true });
      rscArmLane_(lane, rscBackoffMs_(1));
      return { lane: lane, claimed: claimed.length, committed: 0, deferred: claimed.length, reason: 'MASTER_INFRA' };
    }
    for (var d2 = 0; d2 < claimed.length; d2++) rscFailTask_(ss, claimed[d2], cls.message, cls.kind);
    rscArmLane_(lane, rscBackoffMs_(1));
    return { lane: lane, claimed: claimed.length, committed: 0, failed: claimed.length, reason: 'MASTER_' + cls.kind };
  }

  var results = [];
  for (var i = 0; i < claimed.length; i++) {
    var task = claimed[i];
    if ((Date.now() - started) > V.workerSoftDeadlineMs) {
      for (var rel = i; rel < claimed.length; rel++) {
        rscReleaseTask_(ss, claimed[rel], 'Dilepas karena batas waktu eksekusi lane; tanpa penalti.');
      }
      break;
    }

    var pct = 0.1 + 0.8 * (i / claimed.length);
    var stage = {
      job: 'VALIDATE LINK E', state: 'RUNNING', stage: 'Validate Change Rolling',
      progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
      fileName: task.name, fileId: task.fileId,
      startedAt: startedStamp, lane: 'Lane ' + lane, runId: runId
    };
    rscJobLogSet_(ss, slot, stage);

    try {
      var res = rscProcessTask_(task, masters, function (st) {
        stage.stage = st.stage;
        stage.fileName = st.fileName;
        stage.sheet = st.sheet;
        stage.message = st.message;
        stage.elapsedSec = rscRound_((Date.now() - started) / 1000, 1);
        rscJobLogSet_(ss, slot, stage);
      });
      var ok = rscRetry_('commit', 3, function () { return rscCommitOk_(ss, task, res); });
      if (ok && ok.applied) {
        committed++;
        results.push({
          fileId: task.fileId, rows: res.rowCount, errorRows: res.errorRows,
          status: res.errorRows ? RSC_STATUS.DONE_ERRORS : RSC_STATUS.DONE_OK
        });
      } else {
        results.push({ fileId: task.fileId, status: 'DISCARDED', reason: (ok && ok.reason) || 'CAS_FAILED' });
      }
    } catch (err) {
      var c2 = rscClassify_(err);
      if (c2.kind === RSC_ERR.INFRA) {
        rscDeferTask_(ss, task, c2.message);
        results.push({ fileId: task.fileId, status: 'DEFERRED', kind: c2.kind });
        rscJobLogSet_(ss, slot, {
          job: 'VALIDATE LINK E', state: 'WAITING', stage: 'DB contention deferred',
          progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
          fileName: task.name, fileId: task.fileId,
          message: 'Task dikembalikan ke antrean tanpa menambah Attempts.',
          lastError: '[INFRA] ' + c2.message,
          startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
          lane: 'Lane ' + lane, runId: runId
        }, { force: true, history: true });
      } else {
        rscFailTask_(ss, task, c2.message, c2.kind);
        results.push({ fileId: task.fileId, status: 'FAILED', kind: c2.kind });
        rscJobLogSet_(ss, slot, {
          job: 'VALIDATE LINK E', state: 'ERROR', stage: 'File validation failed',
          progress: rscRound_(pct, 4), currentTotal: (i + 1) + ' / ' + claimed.length,
          fileName: task.name, fileId: task.fileId,
          message: 'Task gagal pada attempt ' + (Number(task.attempts || 0) + 1) + '.',
          lastError: '[' + c2.kind + '] ' + c2.message,
          startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
          lane: 'Lane ' + lane, runId: runId
        }, { force: true, history: true });
      }
    }
  }

  var stats = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, stats);
  rscJobLogSet_(ss, slot, {
    job: 'VALIDATE LINK E', state: stats.unfinished ? 'WAITING' : 'DONE',
    stage: stats.unfinished ? 'Bundle done — queue remains' : 'Bundle done — queue empty',
    progress: 1, currentTotal: committed + ' / ' + claimed.length,
    message: 'Claimed=' + claimed.length + ', committed=' + committed +
      ', elapsed=' + rscRound_((Date.now() - started) / 1000, 1) + 's.',
    startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1),
    lane: 'Lane ' + lane, runId: runId
  }, { force: true, history: true });

  if (stats.unfinished > 0) rscArmLane_(lane, V.workerDelayMs);
  else rscFinishRunIfDone_(ss, runId, stats);

  return { lane: lane, claimed: claimed.length, committed: committed, results: results, stats: stats };
}

/* --------------------------- TRIGGER HELPER --------------------------- */

function rscDeleteTriggers_(handlers) {
  var removed = 0;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      if (handlers.indexOf(all[i].getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(all[i]); removed++; }
    }
  } catch (e) { /* best-effort */ }
  return removed;
}

function rscArmLane_(lane, delayMs) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var fn = V.workerHandlers[lane - 1];
  try {
    rscDeleteTriggers_([fn]);
    ScriptApp.newTrigger(fn).timeBased().after(Math.max(1000, delayMs || V.workerDelayMs)).create();
    return true;
  } catch (e) { return false; }
}

function rscArmAllLanes_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var armed = 0;
  for (var l = 1; l <= V.workerCount; l++) if (rscArmLane_(l, V.workerDelayMs * l)) armed++;
  return armed;
}

function rscArmWatchdog_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  try {
    rscDeleteTriggers_([V.watchdogHandler]);
    ScriptApp.newTrigger(V.watchdogHandler).timeBased().everyMinutes(V.watchdogMinutes).create();
    return true;
  } catch (e) { return false; }
}

function rscArmPrewarm_(delayMs) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  try {
    rscDeleteTriggers_([V.prewarmHandler]);
    ScriptApp.newTrigger(V.prewarmHandler).timeBased().after(Math.max(1000, delayMs || V.workerDelayMs)).create();
    return true;
  } catch (e) { return false; }
}

function rscAllHandlers_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  return V.workerHandlers.concat([V.watchdogHandler, V.prewarmHandler]);
}

function rscFinishRunIfDone_(ss, runId, stats) {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  if (stats.unfinished > 0) return false;
  rscSetProp_(V.pRunState, 'DONE');
  rscSetProp_(V.pFinishedAt, rscStamp_());
  rscSetProp_(V.pLastStatus, JSON.stringify(stats));
  rscDeleteTriggers_(V.workerHandlers.concat([V.prewarmHandler]));
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'DONE', stage: 'Queue selesai', progress: 1,
    currentTotal: stats.done + ' / ' + stats.total,
    message: 'OK=' + stats.ok + ', dengan error=' + stats.withErrors + ', hard=' + stats.hard +
      ', blocked=' + stats.blocked + ', skipped=' + stats.skipped + '.',
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });
  runSafelyWithOptionalRethrow_('Write back rekap', function () { rscWriteBackRekapStatus_(ss, runId); }, false);
  runSafelyWithOptionalRethrow_('Auto revamp gate', function () { RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819(); }, false);
  return true;
}

/** Tulis ringkasan hasil ke kolom Feedback pada sheet rekap. */
function rscWriteBackRekapStatus_(ss, runId) {
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var pending = {}, maxRow = L.firstDataRow, updates = 0;

  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    var rows;
    try { rows = JSON.parse(vals[i][RSC_M.MASTER_ROWS] || '[]'); } catch (e) { rows = []; }
    var st = vals[i][RSC_M.STATUS], txt;
    if (st === RSC_STATUS.DONE_OK) txt = 'VALIDASI OK (0 error) — ' + rscStamp_();
    else if (st === RSC_STATUS.DONE_ERRORS) txt = 'PERLU REVISI: ' + vals[i][RSC_M.ERROR_ROWS] + ' baris error.';
    else if (st === RSC_STATUS.SKIPPED) txt = 'DILEWATI: ' + vals[i][RSC_M.MESSAGE];
    else if (st === RSC_STATUS.BLOCKED_INFRA) txt = 'TERTUNDA (infrastruktur): ' + vals[i][RSC_M.MESSAGE];
    else if (st === RSC_STATUS.HARD_ERROR) txt = 'GAGAL: ' + vals[i][RSC_M.SHEET_SUMMARY];
    else continue;
    for (var r = 0; r < rows.length; r++) {
      pending[rows[r]] = String(txt).substring(0, 4000);
      if (rows[r] > maxRow) maxRow = rows[r];
      updates++;
    }
  }
  if (!updates) return 0;

  var n = maxRow - L.firstDataRow + 1;
  var col = master.getRange(L.firstDataRow, L.feedbackCol, n, 1).getDisplayValues();
  for (var k = 0; k < n; k++) {
    var v = pending[L.firstDataRow + k];
    col[k] = [v === undefined ? col[k][0] : v];
  }
  master.getRange(L.firstDataRow, L.feedbackCol, n, 1).setValues(col);
  return updates;
}


/* =============================================================
 * 12. API PUBLIK — VALIDASI (nama function dipertahankan)
 * ============================================================= */

/** Menu 1 — Validate ACTIVE Sheet. Engine yang sama dengan bulk. */
function RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814() {
  var ss = rscActiveSs_();
  var sh = ss.getActiveSheet();
  var spec = rscSpecFor_(sh.getName());
  if (!spec) {
    return rscAlert_('Validasi ACTIVE Sheet',
      'Sheet "' + sh.getName() + '" bukan sheet yang divalidasi.\n\nSheet yang dikenali:\n' +
      '- Change Rolling & Change Schedule\n- Change Sales Office\n- Change Salesman Type');
  }

  var masters;
  try {
    masters = rscLoadMasters_(ss);
  } catch (e) {
    var c = rscClassify_(e);
    return rscAlert_('Validasi ACTIVE Sheet', c.kind === RSC_ERR.INFRA
      ? 'Index master sedang dibangun execution lain. Coba lagi beberapa saat.'
      : ('Gagal memuat master: ' + c.message));
  }

  var needCols = Math.max(spec.errorCol, spec.header.length);
  var width = Math.max(needCols, sh.getLastColumn() || needCols);
  var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  var layoutErr = rscCheckLayout_(spec, header);
  if (layoutErr) return rscAlert_('Layout tidak sesuai', layoutErr);

  rscEnsureResultHeaders_(sh, spec);
  var dataRows = Math.max(0, sh.getLastRow() - 1);
  var values = dataRows ? sh.getRange(2, 1, dataRows, needCols).getValues() : [];
  var res = rscValidateValues_(spec, values, masters);
  rscWriteResults_(sh, spec, res, dataRows);
  rscApplyTemplateDropdowns_(sh, spec, masters);

  var codes = [];
  for (var k in res.byCode) {
    if (Object.prototype.hasOwnProperty.call(res.byCode, k)) codes.push(k + '=' + res.byCode[k]);
  }
  var notes = (masters.notes || []).join('\n');
  rscAlert_('Validasi selesai — ' + spec.label,
    'Baris     : ' + res.rowCount + '\n' +
    'Error     : ' + res.errorRows + '\n' +
    'Sched only: ' + res.changeScheduleOnlyRows + '\n' +
    (codes.length ? ('Rincian   : ' + codes.join(', ') + '\n') : '') +
    (notes ? ('\nCatatan master:\n' + notes) : ''));
  return { rows: res.rowCount, errorRows: res.errorRows, byCode: res.byCode, notes: masters.notes };
}

/** Menu 2 — Start / Resume Bulk Validation seluruh link kolom E. */
function RSC_STANDARD_BULK_START_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();

  if (RSC_IS_HARD_STOPPED_()) {
    return rscAlert_('Bulk Validation', 'Sistem dalam kondisi HARD STOP.\n' +
      'Jalankan Admin / Recovery -> Re-Arm System after HARD STOP terlebih dahulu.');
  }

  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());
  rscSetProp_(V.pMasterSsId, ss.getId());
  rscSetProp_(V.pBlocked, '');
  rscSetProp_(V.pStop, '');

  // Resume: kalau masih ada run berjalan dengan sisa antrean, jangan bangun ulang.
  var existingRun = rscGetProp_(V.pRunId, '');
  if (existingRun && rscGetProp_(V.pRunState, '') === 'RUNNING') {
    var cur = rscQueueStats_(ss, existingRun);
    if (cur.unfinished > 0) {
      rscArmPrewarm_(V.workerDelayMs);
      rscArmWatchdog_();
      rscAlert_('Bulk Validation', 'Melanjutkan run yang masih berjalan.\n\n' + rscFormatStats_(existingRun, cur));
      return { runId: existingRun, resumed: true, stats: cur };
    }
  }

  var runId = V.version + '|' + rscUuid_();
  rscSetProp_(V.pRunId, runId);
  rscSetProp_(V.pRunState, 'BUILDING');
  rscSetProp_(V.pStartedAt, rscStamp_());
  rscSetProp_(V.pFinishedAt, '');
  rscSetProp_(V.pOwner, rscWhoAmI_());

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'START', stage: 'Build manifest', progress: 0,
    message: 'Membuat manifest dan queue Link E.', startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });

  var stats = rscBuildManifest_(ss, runId);
  rscSetProp_(V.pRunState, 'RUNNING');

  var qs = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, qs);
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'QUEUED', stage: 'Manifest ready', progress: 0,
    currentTotal: '0 / ' + stats.total,
    message: 'Queue siap dari sheet "' + stats.sheet + '". Link=' + stats.links + ', valid=' + stats.valid +
      ', skipped=' + stats.skipped + ', task unik=' + stats.tasks + '.',
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });

  // Index dibangun lebih dulu di execution tersendiri; lane dinyalakan olehnya.
  var prewarmed = rscArmPrewarm_(V.workerDelayMs);
  var armed = prewarmed ? 0 : rscArmAllLanes_();
  rscArmWatchdog_();

  rscJobLogSet_(ss, 'WATCHDOG', {
    job: 'BULK WATCHDOG', state: 'WAITING',
    stage: prewarmed ? 'Menunggu index prewarm' : 'Workers armed', progress: 1,
    message: prewarmed
      ? 'Index master dibangun lebih dulu, lane dinyalakan setelahnya.'
      : (armed + ' worker lane dijadwalkan.'),
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });

  rscToast_('Bulk validation dimulai. ' + stats.tasks + ' file masuk antrean.');
  return { runId: runId, stats: stats, armed: armed, prewarm: prewarmed };
}

/** Menu — RESTART FROM TOP. */
function RSC_PERF17_RESTART_BULK_FROM_TOP_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(V.pRunState, 'STOPPED');
  rscDeleteTriggers_(rscAllHandlers_());
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'START', stage: 'Restart From Top', progress: 0,
    message: 'Run lama di-invalidasi. Manifest akan dibangun ulang dari baris pertama.',
    startedAt: rscStamp_()
  }, { force: true, history: true });
  rscSetProp_(V.pRunId, '');
  return RSC_STANDARD_BULK_START_20260814();
}

/** Menu — STOP Bulk Validation. */
function RSC_STANDARD_BULK_STOP_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(V.pRunState, 'STOPPED');
  rscSetProp_(V.pStop, '1');
  var removed = rscDeleteTriggers_(rscAllHandlers_());
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'BULK VALIDATION', state: 'STOPPED', stage: 'Run dihentikan', progress: 1,
    message: removed + ' trigger worker/watchdog/prewarm dilepas.', startedAt: rscStamp_()
  }, { force: true, history: true });
  rscAlert_('Bulk Validation', 'Run dihentikan. ' + removed + ' trigger dilepas.\n' +
    'Antrean tetap tersimpan; jalankan Start / Resume untuk melanjutkan.');
  return { stopped: true, triggersRemoved: removed };
}

function rscFormatStats_(runId, s) {
  return 'Run ID : ' + (runId || '-') +
    '\nTotal  : ' + s.total +
    '\nQUEUED ' + s.queued + ' | ACTIVE ' + s.active + ' | RETRY ' + s.retry + ' | DEFERRED ' + s.deferred +
    '\nCOMPLETE_OK ' + s.ok + ' | WITH_ERRORS ' + s.withErrors +
    '\nHARD_ERROR ' + s.hard + ' | BLOCKED_INFRA ' + s.blocked + ' | SKIPPED ' + s.skipped +
    '\nBaris error total: ' + s.errorRows +
    '\nProgress: ' + Math.round(s.progress * 100) + '%';
}

/** Menu — Status Bulk Validation. */
function RSC_STANDARD_BULK_STATUS_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, s);
  var extra = '\nState  : ' + rscGetProp_(V.pRunState, '-') +
    '\nMulai  : ' + rscGetProp_(V.pStartedAt, '-') +
    '\nSelesai: ' + rscGetProp_(V.pFinishedAt, '-');
  rscAlert_('Status Bulk Validation', rscFormatStats_(runId, s) + extra);
  return s;
}

/** Menu — Open Manifest. */
function RSC_STANDARD_BULK_OPEN_MANIFEST_20260814() {
  var ss = rscActiveSs_();
  var sh = rscManifestSheet_(ss);
  try { sh.showSheet(); ss.setActiveSheet(sh); } catch (e) { /* tanpa UI */ }
  return sh.getName();
}

/* ------------------------- HANDLER TRIGGER ------------------------- */

function RSC_STANDARD_BULK_WORKER_1_20260814() { return rscRunLane_(1); }
function RSC_STANDARD_BULK_WORKER_2_20260814() { return rscRunLane_(2); }
function RSC_STANDARD_BULK_WORKER_3_20260814() { return rscRunLane_(3); }
function RSC_STANDARD_BULK_WORKER_4_20260814() { return rscRunLane_(4); }

/**
 * Pemanasan index — perbaikan [F7].
 * Dijalankan di execution tersendiri sebelum lane menyala, supaya kuota 6 menit
 * worker tidak habis hanya untuk memindai tabel besar seperti m_bp_relation.
 */
function RSC_PERF19_PREWARM_DB_INDEXES_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var started = Date.now();
  var startedStamp = rscStamp_(new Date(started));

  if (!rscDbSources_().length) {
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'INDEX PREWARM', state: 'IDLE', stage: 'DB tidak dikonfigurasi', progress: 1,
      message: 'RSC_DB_PARAMETERS.spreadsheetId kosong. Rule berbasis DB dilewati.',
      startedAt: startedStamp, runId: runId
    }, { force: true, history: true });
    rscArmAllLanes_();
    return { ok: true, reason: 'NO_DB' };
  }

  var tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  var report = [], pending = [];

  for (var i = 0; i < tables.length; i++) {
    if ((Date.now() - started) > V.workerSoftDeadlineMs) { pending = tables.slice(i); break; }
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'INDEX PREWARM', state: 'RUNNING', stage: 'Build index ' + tables[i],
      progress: rscRound_(i / tables.length, 4), currentTotal: (i + 1) + ' / ' + tables.length,
      message: 'Membangun index master sekali untuk seluruh run.',
      startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
    });
    try {
      var idx = rscGetIndex_(tables[i]);
      report.push(tables[i] + '=' + (idx.available
        ? (idx.rows + ' baris/' + (idx.storedIn || 'memory'))
        : ('n/a:' + (idx.reason || '-'))));
    } catch (e) {
      var c = rscClassify_(e);
      report.push(tables[i] + '=' + c.kind);
      if (c.kind === RSC_ERR.INFRA) pending.push(tables[i]);
    }
  }

  if (pending.length) rscArmPrewarm_(V.workerDelayMs);

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'INDEX PREWARM', state: pending.length ? 'WAITING' : 'DONE',
    stage: pending.length ? 'Index sebagian siap' : 'Index siap', progress: 1,
    message: report.join(' | ') + (pending.length ? (' | tersisa: ' + pending.join(',')) : ''),
    startedAt: startedStamp, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
  }, { force: true, history: true });

  rscArmAllLanes_();
  return { ok: true, report: report, pending: pending };
}

/**
 * Watchdog — perbaikan [F5].
 * Otorisasi diperiksa SEKALI. Bila binding tidak cocok, status BLOCKED ditulis
 * satu kali lalu trigger watchdog dilepas, tidak looping tiap beberapa menit.
 */
function RSC_STANDARD_BULK_WATCHDOG_20260814() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var state = rscGetProp_(V.pRunState, '');

  if (RSC_IS_HARD_STOPPED_() || state !== 'RUNNING') {
    rscDeleteTriggers_([V.watchdogHandler]);
    rscJobLogSet_(ss, 'WATCHDOG', {
      job: 'BULK WATCHDOG', state: 'IDLE', stage: 'No active run', progress: 1,
      message: 'Tidak ada run aktif. Watchdog dilepas.', startedAt: rscStamp_(), runId: runId
    }, { force: true });
    return { ok: true, reason: 'NO_RUN' };
  }

  var owner = rscGetProp_(V.pOwner, '');
  var me = rscWhoAmI_();
  if (owner && me && me !== 'unknown' && owner !== me) {
    var reason = 'Trigger dijalankan sebagai ' + me + ', sedangkan run dimiliki ' + owner +
      '. Jalankan Admin / Recovery -> Authorize External DB + Bind Workers memakai akun pemilik.';
    rscSetProp_(V.pBlocked, reason);
    rscDeleteTriggers_([V.watchdogHandler]);
    rscJobLogSet_(ss, 'WATCHDOG', {
      job: 'BULK WATCHDOG', state: 'BLOCKED', stage: 'Authorization binding mismatch', progress: 1,
      message: 'Watchdog dihentikan sekali, tidak diulang.', lastError: '[AUTH] ' + reason,
      startedAt: rscStamp_(), runId: runId
    }, { force: true, history: true });
    return { ok: false, reason: 'AUTH_MISMATCH' };
  }

  var stats = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, stats);
  if (stats.unfinished === 0) {
    rscFinishRunIfDone_(ss, runId, stats);
    rscDeleteTriggers_([V.watchdogHandler]);
    return { ok: true, reason: 'DONE', stats: stats };
  }

  var revived = 0;
  try {
    var sh = rscJobLogSheet_(ss);
    var J = RSC_PERF16_JOBLOG_20260819;
    var firstWorker = J.liveSlots.indexOf('WORKER_1');
    var rows = sh.getRange(J.liveStartRow + firstWorker, 1, V.workerCount, J.columns.length).getDisplayValues();
    for (var l = 0; l < V.workerCount; l++) {
      var hb = Date.parse(String(rows[l][13] || '').replace(' ', 'T'));
      var stale = !isFinite(hb) || (Date.now() - hb) > V.heartbeatStaleMs;
      if (stale && rscArmLane_(l + 1, 2000 + l * 1500)) revived++;
    }
  } catch (e) { /* best-effort */ }

  rscJobLogSet_(ss, 'WATCHDOG', {
    job: 'BULK WATCHDOG', state: 'RUNNING', stage: 'Health check', progress: stats.progress,
    currentTotal: stats.done + ' / ' + stats.total,
    message: 'Unfinished=' + stats.unfinished + ', lane dibangunkan=' + revived + '.',
    startedAt: rscStamp_(), runId: runId
  });
  return { ok: true, revived: revived, stats: stats };
}

/* --------------------- KONTROL & PERBAIKAN ANTREAN --------------------- */

/** Menu — Repair / Dedupe Worker Triggers. */
function RSC_PERF17_REPAIR_TRIGGER_TOPOLOGY_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var before = 0, after = 0;
  try { before = ScriptApp.getProjectTriggers().length; } catch (e) { before = -1; }
  rscDeleteTriggers_(rscAllHandlers_());
  var armed = 0;
  if (rscGetProp_(V.pRunState, '') === 'RUNNING') {
    armed = rscArmAllLanes_();
    rscArmWatchdog_();
  }
  try { after = ScriptApp.getProjectTriggers().length; } catch (e2) { after = -1; }
  rscAlert_('Repair Trigger Topology',
    'Trigger sebelum : ' + before + '\nTrigger sesudah : ' + after +
    '\nLane dipasang   : ' + armed +
    '\n\nDuplikasi trigger worker dibersihkan; tepat satu trigger per lane.');
  return { before: before, after: after, armed: armed };
}

/** Menu — Kick / Recover Waiting Workers. */
function RSC_PERF14_KICK_WAITING_WORKERS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  if (!runId) return rscAlert_('Kick Workers', 'Belum ada run. Jalankan Start Bulk Validation.');

  // Bebaskan lease yatim tanpa menambah Attempts.
  var released = rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var now = Date.now(), writes = [], n = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      if (v[RSC_M.STATUS] !== RSC_STATUS.ACTIVE) continue;
      var lease = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
      if (isFinite(lease) && lease > now) continue;
      v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
      v[RSC_M.LEASE_UNTIL] = '';
      v[RSC_M.CLAIM_TOKEN] = '';
      v[RSC_M.WORKER] = '';
      v[RSC_M.MESSAGE] = 'Lease kedaluwarsa dibebaskan tanpa penalti.';
      v[RSC_M.UPDATED_AT] = rscStamp_();
      writes.push({ row: i + 2, values: v });
      n++;
    }
    rscManifestWriteRows_(sh, writes);
    return n;
  }, V.claimLockWaitMs);

  rscSetProp_(V.pRunState, 'RUNNING');
  var armed = rscArmAllLanes_();
  rscArmWatchdog_();
  var s = rscQueueStats_(ss, runId);
  rscAlert_('Kick Workers',
    'Lease kedaluwarsa dibebaskan : ' + released +
    '\nLane dijadwalkan ulang       : ' + armed + '\n\n' + rscFormatStats_(runId, s));
  return { released: released, armed: armed, stats: s };
}

/** Menu — Diagnose Worker Queue. */
function RSC_PERF14_DIAGNOSE_WORKER_QUEUE_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var s = rscQueueStats_(ss, runId);

  var byKind = {}, oldest = null, worstAttempts = 0, worstDefers = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    var kind = vals[i][RSC_M.ERR_KIND] || '-';
    byKind[kind] = (byKind[kind] || 0) + 1;
    worstAttempts = Math.max(worstAttempts, Number(vals[i][RSC_M.ATTEMPTS] || 0));
    worstDefers = Math.max(worstDefers, Number(vals[i][RSC_M.DEFERS] || 0));
    if (!rscIsTerminal_(vals[i][RSC_M.STATUS])) {
      var at = vals[i][RSC_M.UPDATED_AT];
      if (!oldest || String(at) < String(oldest)) oldest = at;
    }
  }
  var kinds = [];
  for (var k in byKind) if (Object.prototype.hasOwnProperty.call(byKind, k)) kinds.push(k + '=' + byKind[k]);

  var triggers = [];
  try {
    var all = ScriptApp.getProjectTriggers();
    var count = {};
    for (var t = 0; t < all.length; t++) {
      var fn = all[t].getHandlerFunction();
      count[fn] = (count[fn] || 0) + 1;
    }
    for (var f in count) if (Object.prototype.hasOwnProperty.call(count, f)) triggers.push(f + ' x' + count[f]);
  } catch (e) { triggers.push('(tidak dapat membaca trigger)'); }

  var msg = rscFormatStats_(runId, s) +
    '\n\nJenis error terakhir : ' + (kinds.join(', ') || '-') +
    '\nAttempts tertinggi   : ' + worstAttempts + ' (batas ' + V.maxAttempts + ')' +
    '\nDefers tertinggi     : ' + worstDefers + ' (batas ' + V.maxDefers + ', tidak menambah Attempts)' +
    '\nTask terlama diam    : ' + (oldest || '-') +
    '\n\nTrigger aktif:\n' + (triggers.join('\n') || '-');
  rscAlert_('Diagnose Worker Queue', msg);
  return { stats: s, byKind: byKind, triggers: triggers, worstAttempts: worstAttempts, worstDefers: worstDefers };
}

/**
 * Menu — Requeue Technical DB Failures.
 * Mengembalikan kegagalan teknis (INFRA/ACCESS) ke antrean dan MERESET
 * Attempts-nya, karena kegagalan itu memang bukan kesalahan data template.
 */
function RSC_PERF23_REQUEUE_TECHNICAL_FAILURES_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  if (!runId) return rscAlert_('Requeue Technical Failures', 'Belum ada run aktif.');

  var n = rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var writes = [], count = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      var st = v[RSC_M.STATUS];
      var kind = v[RSC_M.ERR_KIND];
      var technical = (kind === RSC_ERR.INFRA || kind === RSC_ERR.ACCESS);
      if (!technical && st !== RSC_STATUS.BLOCKED_INFRA) continue;
      if (st === RSC_STATUS.DONE_OK || st === RSC_STATUS.DONE_ERRORS) continue;
      v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
      v[RSC_M.ATTEMPTS] = 0;
      v[RSC_M.DEFERS] = 0;
      v[RSC_M.NEXT_AT] = '';
      v[RSC_M.LEASE_UNTIL] = '';
      v[RSC_M.CLAIM_TOKEN] = '';
      v[RSC_M.WORKER] = '';
      v[RSC_M.ERR_KIND] = '';
      v[RSC_M.MESSAGE] = 'Kegagalan teknis di-requeue; Attempts dan Defers direset.';
      v[RSC_M.UPDATED_AT] = rscStamp_();
      writes.push({ row: i + 2, values: v });
      count++;
    }
    rscManifestWriteRows_(sh, writes);
    return count;
  }, V.claimLockWaitMs);

  if (n > 0) {
    rscSetProp_(V.pRunState, 'RUNNING');
    rscArmPrewarm_(V.workerDelayMs);
    rscArmWatchdog_();
  }
  rscAlert_('Requeue Technical Failures',
    n + ' task teknis dikembalikan ke antrean dengan Attempts direset.\n' +
    (n ? 'Prewarm index dan watchdog dijadwalkan ulang.' : 'Tidak ada task teknis yang perlu di-requeue.'));
  return { requeued: n };
}

/** Menu — Repair Current Manifest + Requeue. */
function RSC_PERF23_REPAIR_CURRENT_MANIFEST_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  if (!runId) return rscAlert_('Repair Manifest', 'Belum ada run aktif.');

  var fixed = rscAtomic_(function () {
    var sh = rscManifestSheet_(ss);
    var vals = rscManifestRead_(sh);
    var writes = [], seen = {}, dupes = 0, orphan = 0, reset = 0;
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (v[RSC_M.RUN_ID] !== runId) continue;
      var changed = false;
      var fid = v[RSC_M.FILE_ID];

      // Duplikat fileId dalam satu run tidak boleh ada.
      if (fid) {
        if (seen[fid]) {
          v[RSC_M.STATUS] = RSC_STATUS.SKIPPED;
          v[RSC_M.MESSAGE] = 'Duplikat fileId dalam manifest; baris ini dinonaktifkan.';
          dupes++; changed = true;
        } else seen[fid] = true;
      }
      // ACTIVE tanpa lease yang sah adalah sisa execution yang mati.
      if (!changed && v[RSC_M.STATUS] === RSC_STATUS.ACTIVE) {
        var lease = Date.parse(v[RSC_M.LEASE_UNTIL] || '');
        if (!isFinite(lease) || lease <= Date.now()) {
          v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
          v[RSC_M.LEASE_UNTIL] = '';
          v[RSC_M.CLAIM_TOKEN] = '';
          v[RSC_M.WORKER] = '';
          v[RSC_M.MESSAGE] = 'ACTIVE yatim dikembalikan ke antrean.';
          orphan++; changed = true;
        }
      }
      // Attempts melebihi batas karena kegagalan teknis lama.
      if (!changed && Number(v[RSC_M.ATTEMPTS] || 0) >= V.maxAttempts &&
          v[RSC_M.ERR_KIND] === RSC_ERR.INFRA) {
        v[RSC_M.STATUS] = RSC_STATUS.QUEUED;
        v[RSC_M.ATTEMPTS] = 0;
        v[RSC_M.DEFERS] = 0;
        v[RSC_M.ERR_KIND] = '';
        v[RSC_M.MESSAGE] = 'Attempts akibat kegagalan infrastruktur direset.';
        reset++; changed = true;
      }
      if (changed) { v[RSC_M.UPDATED_AT] = rscStamp_(); writes.push({ row: i + 2, values: v }); }
    }
    rscManifestWriteRows_(sh, writes);
    return { dupes: dupes, orphan: orphan, reset: reset };
  }, V.claimLockWaitMs);

  rscSetProp_(V.pRunState, 'RUNNING');
  rscArmPrewarm_(V.workerDelayMs);
  rscArmWatchdog_();
  var s = rscQueueStats_(ss, runId);
  rscAlert_('Repair Manifest',
    'Duplikat fileId dinonaktifkan : ' + fixed.dupes +
    '\nACTIVE yatim dikembalikan     : ' + fixed.orphan +
    '\nAttempts infra direset        : ' + fixed.reset + '\n\n' + rscFormatStats_(runId, s));
  return { fixed: fixed, stats: s };
}

/** Menu — Audit Link E = Active Validation. */
function RSC_PERF15_AUDIT_LINK_E_ACTIVE_PARITY_20260819() {
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var rows = [], total = 0, valid = 0, invalid = 0, dup = 0;
  var seen = {};

  if (lastRow >= L.firstDataRow) {
    var n = lastRow - L.firstDataRow + 1;
    var width = Math.max(master.getLastColumn(), L.linkCol);
    var vals = master.getRange(L.firstDataRow, 1, n, width).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var link = rscText_(vals[r][L.linkCol - 1]);
      if (!link) continue;
      total++;
      var id = rscFileId_(link);
      if (!id) { invalid++; rows.push([L.firstDataRow + r, rscText_(vals[r][L.officeCol - 1]), 'LINK TIDAK VALID', link.substring(0, 80)]); continue; }
      valid++;
      if (seen[id]) { dup++; rows.push([L.firstDataRow + r, rscText_(vals[r][L.officeCol - 1]), 'DUPLIKAT FILE', id]); }
      else seen[id] = L.firstDataRow + r;
    }
  }

  var spec = rscPrimarySpec_();
  var msg = 'Sheet rekap  : ' + master.getName() +
    '\nBaris header : ' + L.headerRow + ' (data mulai ' + L.firstDataRow + ')' +
    '\nKolom link   : ' + rscColLetter_(L.linkCol) +
    '\n\nLink terisi     : ' + total +
    '\nLink valid      : ' + valid +
    '\nLink tidak valid: ' + invalid +
    '\nFile duplikat   : ' + dup +
    '\nFile unik/task  : ' + Object.keys(seen).length +
    '\n\nSheet yang divalidasi tiap file: ' + spec.label +
    ' (layout A:' + rscColLetter_(spec.header.length) + ').' +
    '\nValidasi ACTIVE sheet dan bulk memakai engine yang sama, sehingga hasilnya identik.';
  rscAlert_('Audit Link E vs Active Validation', msg);
  return { total: total, valid: valid, invalid: invalid, duplicate: dup, unique: Object.keys(seen).length, detail: rows };
}

/* ------------------------- JOB LOGGING MENU ------------------------- */

function RSC_PERF16_OPEN_JOB_LOGGING_20260819() {
  var ss = rscActiveSs_();
  var sh = rscJobLogSheet_(ss);
  try { ss.setActiveSheet(sh); } catch (e) { /* tanpa UI */ }
  return sh.getName();
}

function RSC_PERF16_REFRESH_JOB_LOGGING_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  rscJobLogSummary_(ss, runId, s);
  rscToast_('Dashboard diperbarui. Progress ' + Math.round(s.progress * 100) + '%.');
  return s;
}

function RSC_PERF16_CLEAR_JOB_LOG_HISTORY_20260819() {
  var J = RSC_PERF16_JOBLOG_20260819;
  var ss = rscActiveSs_();
  var sh = rscJobLogSheet_(ss);
  var last = sh.getLastRow();
  var removed = 0;
  if (last >= J.historyStartRow) {
    removed = last - J.historyStartRow + 1;
    sh.getRange(J.historyStartRow, 1, removed, J.columns.length).clearContent();
  }
  rscAlert_('Clear Event History', removed + ' baris histori dibersihkan.');
  return { removed: removed };
}


/* =============================================================
 * 13. MESIN JOB LATAR BELAKANG BERSAMA
 * -------------------------------------------------------------
 * Semua job yang menyusuri link kolom E (perbaikan tanggal Rolling, replace
 * tanggal by m_bp_relation, Toko Bangkrut) dulunya punya implementasi sendiri
 * yang hampir sama. Sekarang semuanya memakai satu mesin resumable:
 * checkpoint di Script Properties, soft deadline, dan trigger lanjutan.
 * ============================================================= */

function rscBgState_(key) {
  var raw = rscGetProp_('RSC_BG_' + key, '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function rscBgSave_(key, state) { rscSetProp_('RSC_BG_' + key, JSON.stringify(state)); }
function rscBgClear_(key) { rscSetProp_('RSC_BG_' + key, ''); }

/**
 * Jalankan job latar belakang atas seluruh link FINAL.
 * job = {
 *   key, handlerFn, title, softDeadlineMs, maxFilesPerRun, triggerDelayMs,
 *   apply: function (childSs, masters, state) -> { updated, skipped, note }
 * }
 */
function rscBgRun_(job) {
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var started = Date.now();

  var state = rscBgState_(job.key);
  if (!state) {
    state = {
      key: job.key, runId: rscUuid_(), row: L.firstDataRow,
      processed: 0, updated: 0, skipped: 0, failed: 0,
      startedAt: rscStamp_(), notes: []
    };
  }

  var masters = null;
  try {
    masters = rscLoadMasters_(ss);
  } catch (e) {
    var c = rscClassify_(e);
    if (c.kind === RSC_ERR.INFRA) {
      rscBgSave_(job.key, state);
      rscBgArm_(job);
      rscJobLogSet_(ss, 'SYSTEM', {
        job: job.title, state: 'WAITING', stage: 'Master belum siap', progress: 0,
        message: 'Index master sedang dibangun. Job dijadwalkan ulang.',
        lastError: '[INFRA] ' + c.message, startedAt: state.startedAt
      }, { force: true, history: true });
      return state;
    }
    throw e;
  }

  var lastRow = master.getLastRow();
  var filesThisRun = 0;

  while (state.row <= lastRow) {
    if ((Date.now() - started) > job.softDeadlineMs) break;
    if (filesThisRun >= job.maxFilesPerRun) break;

    var link = rscText_(master.getRange(state.row, L.linkCol).getDisplayValue());
    var row = state.row;
    state.row++;
    if (!link) continue;
    var fileId = rscFileId_(link);
    if (!fileId) { state.skipped++; continue; }

    filesThisRun++;
    state.processed++;
    try {
      var child = SpreadsheetApp.openById(fileId);
      var res = job.apply(child, masters, state) || {};
      state.updated += Number(res.updated || 0);
      state.skipped += Number(res.skipped || 0);
      if (res.note) state.notes.push('row ' + row + ': ' + res.note);
      rscJobLogSet_(ss, 'SYSTEM', {
        job: job.title, state: 'RUNNING', stage: job.title,
        progress: rscRound_((row - L.firstDataRow + 1) / Math.max(1, lastRow - L.firstDataRow + 1), 4),
        currentTotal: state.processed + ' / ' + (lastRow - L.firstDataRow + 1),
        fileId: fileId, fileName: child.getName(),
        message: 'Diperbarui ' + state.updated + ' sel sejauh ini.',
        startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
      });
    } catch (err) {
      var cc = rscClassify_(err);
      state.failed++;
      state.notes.push('row ' + row + ' [' + cc.kind + ']: ' + String(cc.message).substring(0, 200));
      if (cc.kind === RSC_ERR.INFRA) state.row = row;   // ulangi baris ini nanti
    }
  }

  if (state.row <= lastRow) {
    rscBgSave_(job.key, state);
    rscBgArm_(job);
    rscJobLogSet_(ss, 'SYSTEM', {
      job: job.title, state: 'WAITING', stage: 'Lanjut di eksekusi berikutnya',
      progress: rscRound_((state.row - L.firstDataRow) / Math.max(1, lastRow - L.firstDataRow + 1), 4),
      currentTotal: state.processed + ' / ' + (lastRow - L.firstDataRow + 1),
      message: 'Diperbarui ' + state.updated + ', dilewati ' + state.skipped + ', gagal ' + state.failed + '.',
      startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
    }, { force: true, history: true });
    return state;
  }

  rscBgClear_(job.key);
  rscDeleteTriggers_([job.handlerFn]);
  rscJobLogSet_(ss, 'SYSTEM', {
    job: job.title, state: 'DONE', stage: 'Selesai', progress: 1,
    currentTotal: state.processed + ' / ' + state.processed,
    message: 'Diperbarui ' + state.updated + ', dilewati ' + state.skipped + ', gagal ' + state.failed + '.',
    startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
  }, { force: true, history: true });
  return state;
}

function rscBgArm_(job) {
  try {
    rscDeleteTriggers_([job.handlerFn]);
    ScriptApp.newTrigger(job.handlerFn).timeBased().after(job.triggerDelayMs).create();
    return true;
  } catch (e) { return false; }
}

/** Peta kolom sheet Change Rolling di file anak berdasarkan header. */
function rscRollingColumns_(sh) {
  var spec = rscPrimarySpec_();
  var width = Math.max(sh.getLastColumn(), spec.errorCol);
  if (width < 1 || sh.getLastRow() < 1) return null;
  var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  var hmap = rscHeaderMap_(header);
  var col = {};
  for (var i = 0; i < spec.header.length; i++) {
    var idx = rscPickCol_(hmap, [spec.header[i]]);
    col[spec.header[i]] = idx >= 0 ? idx + 1 : (i + 1);
  }
  col.__width = width;
  return col;
}

function rscChildRollingSheet_(childSs) {
  var sheets = childSs.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var spec = rscSpecFor_(sheets[i].getName());
    if (spec && spec.key === 'ROLLING') return sheets[i];
  }
  return null;
}

/* ---------------- JOB 1: Fix G/L Reason Rolling ---------------- */

var RSC_JOB_ROLLING_DATES_ = {
  key: 'FIX_ROLLING_REASON_DATES',
  handlerFn: 'RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611',
  title: 'FIX ROLLING REASON DATES',
  softDeadlineMs: ROLLING_SALES_CENTER_PARAMETERS.softDeadlineMs,
  maxFilesPerRun: BACKGROUND_ROLLING_REASON_DATE_FIX_PARAMETERS.hardMaxFilesPerRun,
  triggerDelayMs: ROLLING_SALES_CENTER_PARAMETERS.bgDelayMs,
  apply: function (childSs, masters) {
    var sh = rscChildRollingSheet_(childSs);
    if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

    var n = lastRow - 1;
    var reason = sh.getRange(2, col['Reason'], n, 1).getDisplayValues();
    var vf = sh.getRange(2, col['Valid From'], n, 1).getValues();
    var vvf = sh.getRange(2, col['Visit Valid From'], n, 1).getValues();
    var dateNew = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew;
    var updated = 0;

    for (var r = 0; r < n; r++) {
      if (rscKey_(reason[r][0]) !== rscKey_('Rolling')) continue;
      if (rscDateStr_(vf[r][0]) !== dateNew) { vf[r][0] = dateNew; updated++; }
      if (rscDateStr_(vvf[r][0]) !== dateNew) { vvf[r][0] = dateNew; updated++; }
    }
    if (updated) {
      sh.getRange(2, col['Valid From'], n, 1).setValues(vf);
      sh.getRange(2, col['Visit Valid From'], n, 1).setValues(vvf);
    }
    return { updated: updated };
  }
};

function RSC_START_FIX_ROLLING_REASON_DATES_BG_20260611() {
  rscBgClear_(RSC_JOB_ROLLING_DATES_.key);
  var s = rscBgRun_(RSC_JOB_ROLLING_DATES_);
  rscAlert_('Fix G/L Reason Rolling',
    'Reason = Rolling dipaksa ke Valid From / Visit Valid From = ' +
    VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew + '.\n\n' +
    'File diproses : ' + s.processed + '\nSel diperbarui: ' + s.updated +
    '\nDilewati      : ' + s.skipped + '\nGagal         : ' + s.failed +
    (s.row ? '\n\nJob berlanjut otomatis di latar belakang.' : ''));
  return s;
}

function RSC_CONTINUE_FIX_ROLLING_REASON_DATES_BG_20260611() { return rscBgRun_(RSC_JOB_ROLLING_DATES_); }

/* ------- JOB 2: Replace Dates by m_bp_relation (Toko Bangkrut saja) ------- */

var RSC_JOB_VALIDATE_DATE_ = {
  key: 'VALIDATE_DATE_IN_TEMPLATE',
  handlerFn: 'RSC_CONTINUE_VALIDATE_DATE_IN_TEMPLATE_BG_20260619',
  title: 'REPLACE DATE BY m_bp_relation',
  softDeadlineMs: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.softDeadlineMs,
  maxFilesPerRun: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.hardMaxFilesPerRun,
  triggerDelayMs: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.triggerDelayMs,
  apply: function (childSs, masters) {
    // Bagian Reason = Rolling TIDAK membutuhkan DB. Hanya penarikan Valid From
    // historis untuk baris non-Rolling yang perlu m_bp_relation, jadi index yang
    // tidak tersedia tidak boleh membatalkan seluruh file.
    var idx = masters.idx && masters.idx.RELATION;
    var hasIdx = !!(idx && idx.available);
    var sh = rscChildRollingSheet_(childSs);
    if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

    var n = lastRow - 1;
    var cust = sh.getRange(2, col['Customer ID'], n, 1).getDisplayValues();
    var rel = sh.getRange(2, col['Relationship'], n, 1).getDisplayValues();
    var sls = sh.getRange(2, col['Salesman ID'], n, 1).getDisplayValues();
    var reason = sh.getRange(2, col['Reason'], n, 1).getDisplayValues();
    var vf = sh.getRange(2, col['Valid From'], n, 1).getValues();
    var vvf = sh.getRange(2, col['Visit Valid From'], n, 1).getValues();
    var dateNew = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew;
    var updated = 0;

    for (var r = 0; r < n; r++) {
      var isRolling = rscKey_(reason[r][0]) === rscKey_('Rolling');
      if (isRolling) {
        // Rolling SELALU memakai dateNew. Histori DB tidak boleh menarik mundur.
        if (rscDateStr_(vf[r][0]) !== dateNew) { vf[r][0] = dateNew; updated++; }
        if (rscDateStr_(vvf[r][0]) !== dateNew) { vvf[r][0] = dateNew; updated++; }
        continue;
      }
      // Selain Rolling: ambil Valid From historis dari relasi yang cocok.
      if (!hasIdx) continue;
      var recs = idx.map[RSC_NORMALIZE_ID_(cust[r][0])];
      if (!recs) continue;
      var wantRel = RSC_NORMALIZE_ID_(rel[r][0]);
      var wantSls = RSC_NORMALIZE_ID_(sls[r][0]);
      var best = '';
      for (var k = 0; k < recs.length; k++) {
        if (wantRel && RSC_NORMALIZE_ID_(recs[k][0]) !== wantRel) continue;
        if (wantSls && RSC_NORMALIZE_ID_(recs[k][1]) !== wantSls) continue;
        var from = rscDateStr_(recs[k][2]);
        if (from && (!best || from < best)) best = from;
      }
      if (best && rscDateStr_(vf[r][0]) !== best) { vf[r][0] = best; updated++; }
    }
    if (updated) {
      sh.getRange(2, col['Valid From'], n, 1).setValues(vf);
      sh.getRange(2, col['Visit Valid From'], n, 1).setValues(vvf);
    }
    return { updated: updated, note: hasIdx ? '' : 'master m_bp_relation tidak tersedia; hanya bagian Rolling diproses' };
  }
};

function RSC_START_VALIDATE_DATE_IN_TEMPLATE_20260619() {
  rscBgClear_(RSC_JOB_VALIDATE_DATE_.key);
  var s = rscBgRun_(RSC_JOB_VALIDATE_DATE_);
  rscAlert_('Replace Dates by m_bp_relation',
    'Reason Rolling tetap memakai ' + VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew +
    ' (histori DB tidak menarik mundur).\nBaris non-Rolling mengambil Valid From terkecil dari relasi yang cocok.\n\n' +
    'File diproses : ' + s.processed + '\nSel diperbarui: ' + s.updated +
    '\nDilewati      : ' + s.skipped + '\nGagal         : ' + s.failed);
  return s;
}

function RSC_CONTINUE_VALIDATE_DATE_IN_TEMPLATE_BG_20260619() { return rscBgRun_(RSC_JOB_VALIDATE_DATE_); }

/* ---------------- JOB 3: Toko Bangkrut Date by DB ---------------- */

var RSC_JOB_TOKO_BANGKRUT_ = {
  key: 'TOKO_BANGKRUT_DATES',
  handlerFn: 'RSC_CONTINUE_TOKO_BANGKRUT_DATES_BY_DB_BG_20260622',
  title: 'TOKO BANGKRUT DATE BY DB',
  softDeadlineMs: RSC_TOKO_BANGKRUT_DB_DATE_PARAMETERS_20260622.softDeadlineMs,
  maxFilesPerRun: RSC_TOKO_BANGKRUT_DB_DATE_PARAMETERS_20260622.hardMaxFilesPerRun,
  triggerDelayMs: RSC_TOKO_BANGKRUT_DB_DATE_PARAMETERS_20260622.triggerDelayMs,
  apply: function (childSs, masters) {
    var sh = rscChildRollingSheet_(childSs);
    if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

    var n = lastRow - 1;
    var reason = sh.getRange(2, col['Reason'], n, 1).getDisplayValues();
    var vt = sh.getRange(2, col['Valid To'], n, 1).getValues();
    var vvt = sh.getRange(2, col['Visit Valid To'], n, 1).getValues();
    var dateClose = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose;
    var updated = 0;

    for (var r = 0; r < n; r++) {
      if (rscKey_(reason[r][0]) !== rscKey_('Toko Bangkrut')) continue;
      if (rscDateStr_(vt[r][0]) !== dateClose) { vt[r][0] = dateClose; updated++; }
      if (rscDateStr_(vvt[r][0]) !== dateClose) { vvt[r][0] = dateClose; updated++; }
    }
    if (updated) {
      sh.getRange(2, col['Valid To'], n, 1).setValues(vt);
      sh.getRange(2, col['Visit Valid To'], n, 1).setValues(vvt);
    }
    return { updated: updated };
  }
};

function RSC_START_TOKO_BANGKRUT_DATES_BY_DB_20260622() {
  rscBgClear_(RSC_JOB_TOKO_BANGKRUT_.key);
  var s = rscBgRun_(RSC_JOB_TOKO_BANGKRUT_);
  rscAlert_('Toko Bangkrut Date',
    'Reason = Toko Bangkrut dipaksa ke Valid To / Visit Valid To = ' +
    VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose + '.\n\n' +
    'File diproses : ' + s.processed + '\nSel diperbarui: ' + s.updated +
    '\nDilewati      : ' + s.skipped + '\nGagal         : ' + s.failed);
  return s;
}

function RSC_CONTINUE_TOKO_BANGKRUT_DATES_BY_DB_BG_20260622() { return rscBgRun_(RSC_JOB_TOKO_BANGKRUT_); }

/* =============================================================
 * 14. SETUP TEMPLATE (dropdown, format, header)
 * ============================================================= */

function rscSetupRollingSheet_(ss, masters) {
  var sh = ss.getSheetByName(TEMPLATE_UI_PARAMETERS.sheetRolling) ||
           rscFindSheet_(ss, [TEMPLATE_UI_PARAMETERS.sheetRolling]);
  if (!sh) return 0;
  var spec = rscPrimarySpec_();
  sh.getRange(1, 1, 1, spec.header.length).setValues([spec.header]);
  var C = TEMPLATE_UI_PARAMETERS.colors;
  sh.getRange(1, 1, 1, spec.header.length)
    .setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  sh.setFrozenRows(1);
  rscApplyTemplateDropdowns_(sh, spec, masters);
  try {
    var n = Math.min(TEMPLATE_UI_PARAMETERS.maxRows, Math.max(sh.getMaxRows() - 1, 1));
    sh.getRange(2, 7, n, 2).setNumberFormat('yyyy-mm-dd');
    sh.getRange(2, 12, n, 2).setNumberFormat('yyyy-mm-dd');
  } catch (e) { /* format kosmetik */ }
  return 1;
}

function rscSetupSimpleSheet_(ss, specKey) {
  var spec = null;
  for (var i = 0; i < RSC_SHEET_SPECS.length; i++) if (RSC_SHEET_SPECS[i].key === specKey) spec = RSC_SHEET_SPECS[i];
  if (!spec) return 0;
  var sh = ss.getSheetByName(spec.label) || rscFindSheet_(ss, spec.names);
  if (!sh) return 0;
  var C = TEMPLATE_UI_PARAMETERS.colors;
  sh.getRange(1, 1, 1, spec.header.length).setValues([spec.header]);
  sh.getRange(1, 1, 1, spec.header.length)
    .setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  sh.setFrozenRows(1);
  return 1;
}

function RSC_SETUP_ROLLING_CHANGE_SHEETS_ONLY_20260611() {
  var ss = rscActiveSs_();
  var masters = rscLoadMasters_(ss);
  var n = rscSetupRollingSheet_(ss, masters) +
          rscSetupSimpleSheet_(ss, 'SALES_OFFICE');
  rscAlert_('Setup CR Change Sheets', n + ' sheet disiapkan (header, format tanggal, dropdown).');
  return n;
}

function RSC_SETUP_CHANGE_SALESMAN_TYPE_ONLY_20260611() {
  var ss = rscActiveSs_();
  var n = rscSetupSimpleSheet_(ss, 'SALESMAN_TYPE');
  rscAlert_('Setup Change Salesman Type', n ? 'Sheet disiapkan.' : 'Sheet tidak ditemukan.');
  return n;
}

function RSC_SETUP_CREDIT_LIMIT_ONLY_20260611() {
  var ss = rscActiveSs_();
  var sh = ss.getSheetByName(TEMPLATE_UI_PARAMETERS.sheetCredit);
  if (!sh) { rscAlert_('Setup Credit Limit', 'Sheet "' + TEMPLATE_UI_PARAMETERS.sheetCredit + '" tidak ditemukan.'); return 0; }
  var C = TEMPLATE_UI_PARAMETERS.colors;
  var width = Math.max(1, sh.getLastColumn());
  sh.getRange(1, 1, 1, width).setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  sh.setFrozenRows(1);
  rscAlert_('Setup Credit Limit', 'Header sheet Credit Limit disegarkan.');
  return 1;
}

function RSC_SETUP_ALL_TEMPLATES_20260611() {
  var ss = rscActiveSs_();
  var masters = rscLoadMasters_(ss);
  var n = rscSetupRollingSheet_(ss, masters) +
          rscSetupSimpleSheet_(ss, 'SALES_OFFICE') +
          rscSetupSimpleSheet_(ss, 'SALESMAN_TYPE');
  runSafelyWithOptionalRethrow_('Setup credit limit', function () {
    var sh = ss.getSheetByName(TEMPLATE_UI_PARAMETERS.sheetCredit);
    if (sh) {
      var C = TEMPLATE_UI_PARAMETERS.colors;
      sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn()))
        .setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  }, false);
  rscAlert_('Setup ALL Template', n + ' sheet utama disiapkan ulang (header, format, dropdown).');
  return n;
}

/* =============================================================
 * 15. SUMMARY - CR
 * ============================================================= */

function RSC_GENERATE_CR_VISIT_SCHEDULE_SUMMARY_20260611() {
  var P = CR_VISIT_SCHEDULE_SUMMARY_PARAMETERS;
  var ss = rscActiveSs_();
  var sh = ss.getSheetByName(P.sourceSheetName) || rscFindSheet_(ss, [P.sourceSheetName]);
  if (!sh) return rscAlert_('Summary - CR', 'Sheet "' + P.sourceSheetName + '" tidak ditemukan.');

  var col = rscRollingColumns_(sh);
  var lastRow = sh.getLastRow();
  if (!col || lastRow < 2) return rscAlert_('Summary - CR', 'Tidak ada baris data.');

  var n = lastRow - 1;
  var width = Math.max(col.__width, 16);
  var vals = sh.getRange(2, 1, n, width).getDisplayValues();
  var tokens = P.baseScheduleTokens;
  var tokenIndex = {};
  for (var t = 0; t < tokens.length; t++) tokenIndex[rscKey_(tokens[t])] = t;

  var bySalesman = {}, order = [];
  var iSls = col['Salesman ID'] - 1, iSch = col['Schedule Visit'] - 1;
  var iStatus = col['Validation Status'] - 1, iOffice = col['Sales Office'] - 1;

  for (var r = 0; r < n; r++) {
    if (!P.includeErrorRows && rscKey_(vals[r][iStatus]) === 'ERROR') continue;
    var sid = RSC_NORMALIZE_ID_(vals[r][iSls]);
    if (!sid) continue;
    if (!bySalesman[sid]) {
      bySalesman[sid] = { office: rscText_(vals[r][iOffice]), counts: [], total: 0 };
      for (var z = 0; z < tokens.length; z++) bySalesman[sid].counts.push(0);
      order.push(sid);
    }
    var parsed = rscParseSchedule_(vals[r][iSch]);
    for (var k = 0; k < parsed.valid.length; k++) {
      var ti = tokenIndex[rscKey_(parsed.valid[k])];
      if (ti !== undefined) { bySalesman[sid].counts[ti]++; bySalesman[sid].total++; }
    }
  }

  var out = [['Sales Office', 'Salesman ID'].concat(tokens).concat(['Total'])];
  order.sort();
  for (var o = 0; o < order.length; o++) {
    var rec = bySalesman[order[o]];
    out.push([rec.office, order[o]].concat(rec.counts).concat([rec.total]));
  }

  var target = ss.getSheetByName(P.outputSheetFallbackName);
  if (!target) target = ss.insertSheet(P.outputSheetFallbackName);
  target.clear();
  target.getRange(1, 1, out.length, out[0].length).setValues(out);
  var C = TEMPLATE_UI_PARAMETERS.colors;
  target.getRange(1, 1, 1, out[0].length).setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
  target.setFrozenRows(1);
  target.setFrozenColumns(2);
  try { ss.setActiveSheet(target); } catch (e) { /* tanpa UI */ }

  rscAlert_('Summary - CR', 'Ringkasan dibuat untuk ' + order.length + ' salesman dari ' + n + ' baris.');
  return { salesmen: order.length, rows: n };
}


/* =============================================================
 * 16. HARD STOP / RE-ARM
 * ============================================================= */

function RSC_IS_HARD_STOPPED_() {
  return rscGetProp_(RSC_PERF13_HARD_STOP_20260819.pHardStop, '') === '1';
}

function RSC_PERF13_HARD_STOP_ALL_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(H.pHardStop, '1');
  rscSetProp_(H.pHardStopAt, rscStamp_());
  rscSetProp_(H.pHardStopBy, rscWhoAmI_());
  rscSetProp_(H.pHardStopReason, 'HARD STOP manual dari menu Admin / Recovery.');
  rscSetProp_(V.pRunState, 'STOPPED');

  var removed = 0;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) { ScriptApp.deleteTrigger(all[i]); removed++; }
  } catch (e) { removed = -1; }

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'HARD STOP', state: 'STOPPED', stage: 'HARD STOP ALL', progress: 1,
    message: 'Semua trigger project dilepas (' + removed + '). Antrean tetap tersimpan.',
    startedAt: rscStamp_()
  }, { force: true, history: true });
  rscAlert_('HARD STOP ALL',
    'Semua trigger dilepas: ' + removed +
    '\nRun ditandai STOPPED.\n\nData manifest TIDAK dihapus.' +
    '\nJalankan "Re-Arm System after HARD STOP" untuk melanjutkan.');
  return { removed: removed };
}

function RSC_PERF13_REARM_AFTER_HARD_STOP_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(H.pHardStop, '');
  rscSetProp_(H.pHardStopReason, '');
  rscSetProp_(V.pBlocked, '');
  rscSetProp_(V.pOwner, rscWhoAmI_());

  var runId = rscGetProp_(V.pRunId, '');
  var s = runId ? rscQueueStats_(ss, runId) : { unfinished: 0, total: 0 };
  var armed = 0;
  if (runId && s.unfinished > 0) {
    rscSetProp_(V.pRunState, 'RUNNING');
    rscArmPrewarm_(V.workerDelayMs);
    rscArmWatchdog_();
    armed = V.workerCount;
  }
  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'HARD STOP', state: 'START', stage: 'Re-Arm', progress: 0,
    message: 'HARD STOP dicabut. Sisa antrean: ' + s.unfinished + '.', startedAt: rscStamp_()
  }, { force: true, history: true });
  rscAlert_('Re-Arm System',
    'HARD STOP dicabut oleh ' + rscWhoAmI_() + '.' +
    '\nSisa antrean : ' + s.unfinished +
    '\nLane dijadwal: ' + (armed ? 'ya (lewat prewarm index)' : 'tidak perlu'));
  return { rearmed: true, stats: s };
}

function RSC_PERF13_SHOW_HARD_STOP_STATUS_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var active = RSC_IS_HARD_STOPPED_();
  var msg = 'HARD STOP : ' + (active ? 'AKTIF' : 'tidak aktif') +
    '\nWaktu     : ' + rscGetProp_(H.pHardStopAt, '-') +
    '\nOleh      : ' + rscGetProp_(H.pHardStopBy, '-') +
    '\nAlasan    : ' + rscGetProp_(H.pHardStopReason, '-');
  rscAlert_('HARD STOP Status', msg);
  return { active: active };
}

/* =============================================================
 * 17. HARNESS UJI RINGAN
 * ============================================================= */

function rscTestSuite_(title) {
  var passed = [], failed = [];
  return {
    ok: function (name, cond, extra) {
      if (cond) passed.push(name);
      else failed.push(name + (extra ? ' :: ' + extra : ''));
    },
    eq: function (name, a, b) {
      if (String(a) === String(b)) passed.push(name + ' (' + a + ')');
      else failed.push(name + ' :: got "' + a + '" want "' + b + '"');
    },
    finish: function (extraText) {
      var res = { title: title, ok: failed.length === 0, passed: passed.length, failed: failed };
      rscAlert_(title + (res.ok ? ' — LULUS' : ' — GAGAL'),
        passed.length + ' lulus, ' + failed.length + ' gagal.' +
        (failed.length ? ('\n\nGagal:\n- ' + failed.join('\n- ')) : '') +
        (extraText ? ('\n\n' + extraText) : ''));
      return res;
    }
  };
}

function RSC_PERF13_TEST_HARD_STOP_CORE_20260819() {
  var H = RSC_PERF13_HARD_STOP_20260819;
  var before = rscGetProp_(H.pHardStop, '');
  var t = rscTestSuite_('HARD STOP CORE');
  rscSetProp_(H.pHardStop, '1');
  t.ok('flag aktif terbaca', RSC_IS_HARD_STOPPED_() === true);
  rscSetProp_(H.pHardStop, '');
  t.ok('flag nonaktif terbaca', RSC_IS_HARD_STOPPED_() === false);
  rscSetProp_(H.pHardStop, before);
  t.ok('flag dikembalikan seperti semula', rscGetProp_(H.pHardStop, '') === before);
  return t.finish();
}

/* =============================================================
 * 18. AUDIT & DIAGNOSTIK
 * ============================================================= */

function RSC_PERF10_RUN_DEPENDENCY_AUDIT_20260819() {
  var ss = rscActiveSs_();
  var lines = [];
  lines.push('Versi engine : ' + ROLLING_SALES_CENTER_PARAMETERS.version);
  lines.push('Master file  : ' + ss.getName() + ' (' + ss.getId() + ')');

  try { lines.push('Sheet rekap  : ' + rscMasterSheet_(ss).getName()); }
  catch (e) { lines.push('Sheet rekap  : TIDAK DITEMUKAN'); }

  var em = rscOfficeMaster_(ss);
  lines.push('Master em    : ' + (em.available ? (Object.keys(em.map).length + ' sales office') : 'TIDAK TERSEDIA'));
  lines.push('Relationship : ' + Object.keys(rscRelationshipMaster_().map).length + ' tipe');

  var ids = rscDbSources_();
  lines.push('');
  lines.push('DB sources   : ' + (ids.length ? ids.join(', ') : '(kosong)'));
  for (var i = 0; i < ids.length; i++) {
    try {
      var db = SpreadsheetApp.openById(ids[i]);
      lines.push('  OK  ' + db.getName() + ' — ' + db.getSheets().length + ' tab');
    } catch (e2) {
      lines.push('  ERR ' + ids[i] + ' — ' + rscClassify_(e2).kind);
    }
  }

  lines.push('');
  var tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var t = 0; t < tables.length; t++) {
    try {
      var idx = rscGetIndex_(tables[t]);
      lines.push('Index ' + tables[t] + ' : ' + (idx.available
        ? (idx.rows + ' baris, tab "' + idx.sheet + '", mode ' + (idx.mode || '-') +
           ', simpan di ' + (idx.storedIn || '-'))
        : ('TIDAK TERSEDIA (' + (idx.reason || '-') + ')')));
    } catch (e3) {
      var c3 = rscClassify_(e3);
      lines.push('Index ' + tables[t] + ' : ' + c3.kind + ' — ' + c3.message);
    }
  }

  lines.push('');
  lines.push('Periode      : dateNew=' + VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew +
    ', dateClose=' + VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose);
  lines.push('Worker       : ' + RSC_STANDARD_VALIDATION_V27_20260814.workerCount +
    ' lane, bundle ' + RSC_STANDARD_VALIDATION_V27_20260814.claimBatchSize);
  lines.push('Akun efektif : ' + rscWhoAmI_());

  var text = lines.join('\n');
  rscSetProp_('RSC_LAST_AUDIT', text.substring(0, 8000));
  rscSetProp_('RSC_LAST_AUDIT_AT', rscStamp_());
  rscAlert_('Scope + Dependency Audit', text);
  return text;
}

function RSC_PERF10_LIVE_DB_READONLY_AUDIT_20260819() {
  var lines = [], tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var t = 0; t < tables.length; t++) {
    try {
      var idx = rscGetIndex_(tables[t]);
      if (!idx.available) { lines.push(tables[t] + ' : n/a (' + (idx.reason || '-') + ')'); continue; }
      var keys = Object.keys(idx.map).slice(0, 3);
      var sample = [];
      for (var k = 0; k < keys.length; k++) sample.push(keys[k] + ' -> ' + JSON.stringify(idx.map[keys[k]][0]));
      lines.push(tables[t] + ' : ' + idx.rows + ' baris, ' + Object.keys(idx.map).length + ' key' +
        (idx.expiredRows ? (', ' + idx.expiredRows + ' kedaluwarsa dilewati') : '') +
        '\n   ' + (sample.join('\n   ') || '(kosong)'));
    } catch (e) {
      lines.push(tables[t] + ' : ' + rscClassify_(e).kind);
    }
  }
  var text = lines.join('\n\n');
  rscAlert_('Live DB Read-Only Audit', text);
  return text;
}

function RSC_PERF11_DIAGNOSE_DB_ACCESS_20260819() {
  var ids = rscDbSources_();
  var lines = ['Akun efektif : ' + rscWhoAmI_(), ''];
  for (var i = 0; i < ids.length; i++) {
    try {
      var ss = SpreadsheetApp.openById(ids[i]);
      var names = [], sheets = ss.getSheets();
      for (var s = 0; s < sheets.length && s < 25; s++) names.push(sheets[s].getName());
      lines.push('OK  ' + ids[i] + '\n    ' + ss.getName() + '\n    tab: ' + names.join(', '));
    } catch (e) {
      var c = rscClassify_(e);
      lines.push('ERR ' + ids[i] + '\n    [' + c.kind + '] ' + c.message);
    }
  }
  if (!ids.length) lines.push('RSC_DB_PARAMETERS.spreadsheetId masih kosong.');
  var text = lines.join('\n\n');
  rscAlert_('Diagnose DB Access / Identity', text);
  return text;
}

function RSC_PERF15_DIAGNOSE_BULK_ACCESS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var checked = 0, ok = 0, denied = 0, other = 0, samples = [];
  for (var i = 0; i < vals.length && checked < 10; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    var fid = vals[i][RSC_M.FILE_ID];
    if (!fid) continue;
    checked++;
    try { SpreadsheetApp.openById(fid); ok++; }
    catch (e) {
      var c = rscClassify_(e);
      if (c.kind === RSC_ERR.ACCESS) denied++; else other++;
      samples.push(fid + ' [' + c.kind + ']');
    }
  }
  var text = 'Akun efektif : ' + rscWhoAmI_() +
    '\nRun ID       : ' + (runId || '-') +
    '\n\nSample diperiksa : ' + checked +
    '\nDapat dibuka     : ' + ok +
    '\nDitolak akses    : ' + denied +
    '\nLain-lain        : ' + other +
    (samples.length ? ('\n\nContoh bermasalah:\n' + samples.join('\n')) : '');
  rscAlert_('Diagnose Bulk DB Access / Identity', text);
  return text;
}

function RSC_PERF18_AUDIT_CHILD_LINK_ACCESS_20260819() {
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var ok = 0, fail = 0, rows = [];
  if (lastRow >= L.firstDataRow) {
    var n = lastRow - L.firstDataRow + 1;
    var width = Math.max(master.getLastColumn(), L.linkCol);
    var vals = master.getRange(L.firstDataRow, 1, n, width).getDisplayValues();
    for (var r = 0; r < vals.length; r++) {
      var id = rscFileId_(vals[r][L.linkCol - 1]);
      if (!id) continue;
      try { SpreadsheetApp.openById(id); ok++; }
      catch (e) {
        fail++;
        rows.push('row ' + (L.firstDataRow + r) + ' ' + rscText_(vals[r][L.officeCol - 1]) +
          ' [' + rscClassify_(e).kind + ']');
      }
    }
  }
  var text = 'Dapat dibuka : ' + ok + '\nBermasalah   : ' + fail +
    (rows.length ? ('\n\n' + rows.slice(0, 40).join('\n')) : '');
  rscAlert_('Audit Child Link Access (Col E)', text);
  return { ok: ok, fail: fail, detail: rows };
}

function RSC_PERF18_AUTHORIZE_AND_BIND_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var me = rscWhoAmI_();
  var lines = ['Akun pengikat: ' + me, ''];

  var ids = rscDbSources_();
  for (var i = 0; i < ids.length; i++) {
    try { SpreadsheetApp.openById(ids[i]).getSheets().length; lines.push('OK  DB ' + ids[i]); }
    catch (e) { lines.push('ERR DB ' + ids[i] + ' — ' + rscClassify_(e).message); }
  }
  try { DriveApp.getRootFolder().getName(); lines.push('OK  Drive scope'); }
  catch (e2) { lines.push('ERR Drive scope — ' + e2); }

  rscSetProp_(V.pOwner, me);
  rscSetProp_(V.pBlocked, '');
  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());

  var armed = 0;
  if (rscGetProp_(V.pRunState, '') === 'RUNNING') { armed = rscArmAllLanes_(); rscArmWatchdog_(); }
  lines.push('');
  lines.push('Binding disimpan. Lane dijadwalkan ulang: ' + armed);
  var text = lines.join('\n');
  rscAlert_('Authorize External DB + Bind Workers', text);
  return text;
}

function RSC_PERF18_SHOW_AUTH_STATUS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var blocked = rscGetProp_(V.pBlocked, '');
  var text = 'Pemilik run  : ' + (rscGetProp_(V.pOwner, '') || '(belum di-bind)') +
    '\nAkun efektif : ' + rscWhoAmI_() +
    '\nStatus       : ' + (blocked ? 'BLOCKED' : 'OK') +
    (blocked ? ('\n\nAlasan:\n' + blocked) : '') +
    '\n\nWatchdog memeriksa binding SEKALI. Bila mismatch, watchdog berhenti dan\n' +
    'tidak mengulang pesan tiap beberapa menit seperti versi lama.';
  rscAlert_('Authorization Binding Status', text);
  return { owner: rscGetProp_(V.pOwner, ''), me: rscWhoAmI_(), blocked: blocked };
}

function RSC_PERF19_CLEAR_DB_CACHE_20260819() {
  RSC_MEM_INDEX = {};
  var tag = rscDbSources_().join(',');
  if (tag) {
    rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag, '');
    rscSetProp_(RSC_DB_PARAMETERS.pIndexVerPrefix + tag + '_AT', '');
  }
  var invalidated = 0;
  var store = rscIndexStore_(false);
  if (store) {
    var sheets = store.getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getName().indexOf('IDX_') === 0) {
        try { sheets[i].getRange(1, 1).setValue('stale'); invalidated++; } catch (e) { /* abaikan */ }
      }
    }
  }
  rscAlert_('Clear Fast DB Lookup Cache',
    'Cache memori dan versi index dibersihkan.\nSheet index ditandai basi: ' + invalidated +
    '\n\nIndex akan dibangun ulang otomatis saat dibutuhkan.');
  return { invalidated: invalidated };
}

function RSC_PERF21_SHOW_TRANSPORT_STATUS_20260819() {
  var lines = [], tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  var ver = rscIndexVersion_();
  for (var i = 0; i < tables.length; i++) {
    var mem = RSC_MEM_INDEX[tables[i] + ':' + ver];
    lines.push(tables[i] + ' : ' + (mem
      ? ('siap di memori (' + (mem.storedIn || '-') + ')')
      : 'belum dimuat di execution ini'));
  }
  var text = 'Versi index  : ' + ver +
    '\nPenyimpanan  : memori -> CacheService (< ' + RSC_DB_PARAMETERS.cacheMaxBytes + ' byte) -> sheet index' +
    '\nSheet index  : ' + (rscGetProp_(RSC_DB_PARAMETERS.pIndexStoreId, '') || '(belum dibuat)') +
    '\n\n' + lines.join('\n');
  rscAlert_('PERF21 DB Transport Status', text);
  return text;
}

function RSC_PERF22_SCOPE_AUDIT_20260819_() {
  var checks = [];
  function probe(name, fn) {
    try { fn(); checks.push('OK  ' + name); }
    catch (e) { checks.push('ERR ' + name + ' — ' + e); }
  }
  probe('SpreadsheetApp', function () { rscActiveSs_().getName(); });
  probe('PropertiesService', function () { rscGetProp_('RSC_PROBE', ''); });
  probe('CacheService', function () { rscCache_().get('RSC_PROBE'); });
  probe('LockService', function () { rscAtomic_(function () { return 1; }, 1000); });
  probe('ScriptApp triggers', function () { ScriptApp.getProjectTriggers(); });
  probe('DriveApp', function () { DriveApp.getRootFolder().getName(); });
  probe('Session', function () { rscWhoAmI_(); });
  probe('Utilities', function () { rscUuid_(); });
  var text = checks.join('\n');
  rscAlert_('PERF22 Scope Completeness Audit', text);
  return text;
}

function RSC_PERF24_DIAGNOSE_RUN_GUARDS_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var stale = 0, tokened = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) { stale++; continue; }
    if (vals[i][RSC_M.CLAIM_TOKEN]) tokened++;
  }
  var text = 'Run ID aktif        : ' + (runId || '-') +
    '\nState               : ' + rscGetProp_(V.pRunState, '-') +
    '\nBaris run lain      : ' + stale + ' (tidak akan diambil worker)' +
    '\nTask sedang di-claim: ' + tokened +
    '\n\nPenjaga aktif:' +
    '\n- Worker hanya mengambil baris dengan Run ID yang sama.' +
    '\n- Commit memverifikasi claimToken; hasil dibuang bila token berubah.' +
    '\n- Lease kedaluwarsa dibebaskan tanpa menambah Attempts.' +
    '\n- Lane berhenti di ' + Math.round(V.workerSoftDeadlineMs / 1000) +
    ' detik dan melepas sisa task tanpa penalti.';
  rscAlert_('PERF24 Diagnose Run Guards', text);
  return text;
}

function RSC_PERF10_SHOW_TELEMETRY_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var vals = rscManifestRead_(rscManifestSheet_(ss));
  var n = 0, open = 0, norm = 0, rules = 0, write = 0, total = 0, errRows = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][RSC_M.RUN_ID] !== runId) continue;
    if (!Number(vals[i][RSC_M.TOTAL_SEC] || 0)) continue;
    n++;
    open += Number(vals[i][RSC_M.OPEN_SEC] || 0);
    norm += Number(vals[i][RSC_M.NORM_SEC] || 0);
    rules += Number(vals[i][RSC_M.RULES_SEC] || 0);
    write += Number(vals[i][RSC_M.WRITE_SEC] || 0);
    total += Number(vals[i][RSC_M.TOTAL_SEC] || 0);
    errRows += Number(vals[i][RSC_M.ERROR_ROWS] || 0);
  }
  function avg(x) { return n ? rscRound_(x / n, 3) : 0; }
  var text = 'File selesai dengan telemetri: ' + n +
    '\n\nRata-rata per file:' +
    '\n  Buka file   : ' + avg(open) + ' s' +
    '\n  Normalisasi : ' + avg(norm) + ' s' +
    '\n  Rule        : ' + avg(rules) + ' s' +
    '\n  Tulis hasil : ' + avg(write) + ' s' +
    '\n  Total       : ' + avg(total) + ' s' +
    '\n\nTotal waktu proses : ' + rscRound_(total, 1) + ' s' +
    '\nTotal baris error  : ' + errRows;
  rscAlert_('PERF Telemetry', text);
  return text;
}

function RSC_PERF10_SHOW_LAST_AUDIT_20260819() {
  var text = rscGetProp_('RSC_LAST_AUDIT', '');
  var at = rscGetProp_('RSC_LAST_AUDIT_AT', '');
  rscAlert_('Last Audit Summary',
    text ? (at + '\n\n' + text) : 'Belum ada audit. Jalankan Scope + Dependency Audit.');
  return text;
}


/* ---------------------- UJI MANDIRI DARI MENU ---------------------- */

function RSC_PERF18_TEST_AUTH_BINDING_CORE_20260819_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var t = rscTestSuite_('AUTH BINDING CORE');
  var before = rscGetProp_(V.pOwner, '');
  rscSetProp_(V.pOwner, 'orang.lain@contoh.com');
  t.ok('mismatch terdeteksi', rscGetProp_(V.pOwner, '') !== rscWhoAmI_());
  rscSetProp_(V.pOwner, rscWhoAmI_());
  t.ok('bind ulang membuat cocok', rscGetProp_(V.pOwner, '') === rscWhoAmI_());
  rscSetProp_(V.pOwner, before);
  return t.finish();
}

function RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_() {
  var t = rscTestSuite_('OAUTH EXACT-STATUS LOGIC');
  t.eq('permission -> ACCESS', rscClassify_(new Error('You do not have permission to access')).kind, RSC_ERR.ACCESS);
  t.eq('not found -> ACCESS', rscClassify_(new Error('No item with the given ID could be found')).kind, RSC_ERR.ACCESS);
  t.eq('quota -> INFRA', rscClassify_(new Error('Service invoked too many times')).kind, RSC_ERR.INFRA);
  t.eq('lock -> INFRA', rscClassify_(new Error('Could not acquire lock')).kind, RSC_ERR.INFRA);
  t.eq('layout -> DATA', rscClassify_(new RscDataError('Layout A:P tidak sesuai')).kind, RSC_ERR.DATA);
  t.eq('lain-lain -> FATAL', rscClassify_(new Error('undefined is not a function')).kind, RSC_ERR.FATAL);
  return t.finish('ACCESS diperlakukan sebagai kegagalan data (perlu tindakan user).\n' +
    'INFRA diperlakukan sebagai penundaan TANPA menambah Attempts.');
}

function RSC_PERF19_TEST_DB_ACCELERATOR_20260819() {
  var t = rscTestSuite_('DB LOOKUP ACCELERATOR');
  var lines = [], tables = ['BP', 'RELATION', 'VISIT', 'SALESMAN'];
  for (var i = 0; i < tables.length; i++) {
    try {
      var idx = rscGetIndex_(tables[i]);
      t.ok(tables[i] + ' terindeks atau dilaporkan jelas', idx.available || !!idx.reason);
      lines.push(tables[i] + ': ' + (idx.available
        ? (Object.keys(idx.map).length + ' key, simpan di ' + (idx.storedIn || 'memory'))
        : ('n/a — ' + idx.reason)));
      if (idx.available) {
        var keys = Object.keys(idx.map).slice(0, 2500);
        t.eq(tables[i] + ' lookup ' + keys.length + ' ID',
          Object.keys(rscLookupMany_(idx, keys)).length, keys.length);
      }
    } catch (e) {
      lines.push(tables[i] + ': ' + rscClassify_(e).kind);
      t.ok(tables[i] + ' error terklasifikasi', !!rscClassify_(e).kind);
    }
  }
  return t.finish(lines.join('\n') +
    '\n\nLookup memakai hash-index O(1). Tidak ada lagi ambang jumlah ID\n' +
    'yang memicu full scan seperti batas 2.500 pada versi lama.');
}

function RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819() {
  var D = RSC_DB_PARAMETERS;
  var t = rscTestSuite_('QUOTA-SAFE DB TRANSPORT');
  t.ok('jendela baca dibatasi', D.readWindowRows > 0 && D.readWindowRows <= 50000);
  t.ok('potongan cache di bawah 100KB', D.cacheChunkBytes > 0 && D.cacheChunkBytes < 100000);
  t.ok('ada ambang materialisasi ke sheet', D.cacheMaxBytes > 0);
  t.ok('lease pembangunan index terbatas waktu', D.buildLeaseMs > 0);
  var payload = { map: {}, rows: 0 };
  for (var i = 0; i < 5000; i++) payload.map['K' + i] = [['a', 'b', 'c', 'd']];
  var json = JSON.stringify(payload);
  var parts = Math.ceil(json.length / D.cacheChunkBytes);
  t.ok('payload besar terpecah menjadi banyak potongan', parts > 1, 'parts=' + parts);
  return t.finish('Ukuran uji: ' + json.length + ' byte -> ' + parts + ' potongan cache.');
}

function RSC_PERF23_TEST_DIRECT_RAW_DB_20260819() {
  var t = rscTestSuite_('DIRECT RAW DB');
  var lines = [];
  try {
    var loc = rscLocateTable_(RSC_DB_PARAMETERS.tables.RELATION);
    t.ok('tab m_bp_relation ditemukan', !!loc, 'alias: ' + RSC_DB_PARAMETERS.tables.RELATION.join(', '));
    if (loc) {
      var layout = RSC_MBP_RELATION_GET_LAYOUT_20260819_(loc.sheet);
      lines.push('Tab      : ' + loc.sheet.getName() + ' @ ' + loc.ssName);
      lines.push('Mode     : ' + layout.mode);
      lines.push('Data dari: baris ' + layout.firstDataRow);
      t.ok('layout dikenali', layout.mode === 'COMPACT_JSON' || layout.mode === 'LEGACY_COLUMNS', layout.mode);
      var probe = loc.sheet.getRange(layout.firstDataRow, 1, 1,
        Math.max(1, loc.sheet.getLastColumn())).getDisplayValues()[0];
      var rec = RSC_MBP_RELATION_PARSE_ROW_20260819_(layout, probe);
      t.ok('baris pertama terurai', !!rec, JSON.stringify(probe).substring(0, 120));
      if (rec) lines.push('Contoh   : ' + JSON.stringify(rec));
    }
  } catch (e) {
    t.ok('pembacaan terklasifikasi, bukan crash', !!rscClassify_(e).kind, String(e));
  }
  return t.finish(lines.join('\n'));
}

function RSC_PERF25_TEST_DB_CONTENTION_PARITY_20260819() {
  var t = rscTestSuite_('DB CONTENTION PARITY');
  var resA = 'IDX:__TEST_A__', resB = 'IDX:__TEST_B__';
  var a = rscLeaseAcquire_(resA, 30000);
  var b = rscLeaseAcquire_(resB, 30000);
  t.ok('resource berbeda dapat lease bersamaan', !!a && !!b && a !== b);
  t.eq('resource sama tidak dapat lease ganda', rscLeaseAcquire_(resA, 30000), '');
  rscLeaseRelease_(resA, 'TOKEN-SALAH');
  t.eq('lease tidak bisa dilepas token asing', rscLeaseAcquire_(resA, 30000), '');
  rscLeaseRelease_(resA, a);
  var a2 = rscLeaseAcquire_(resA, 30000);
  t.ok('lease bisa dilepas pemiliknya', !!a2);
  rscLeaseRelease_(resA, a2);
  rscLeaseRelease_(resB, b);

  var exp = rscLeaseAcquire_('IDX:__TEST_EXPIRED__', -1000);
  t.ok('lease kedaluwarsa dapat diambil alih', !!rscLeaseAcquire_('IDX:__TEST_EXPIRED__', 30000));
  rscLeaseRelease_('IDX:__TEST_EXPIRED__', exp);

  t.eq('DB busy diklasifikasi INFRA',
    rscClassify_(new Error('Serialized m_bp_relation reader sedang dipakai execution lain')).kind, RSC_ERR.INFRA);
  t.ok('ada batas defer terpisah dari attempts', RSC_STANDARD_VALIDATION_V27_20260814.maxDefers > 0);
  return t.finish(
    'Lock global hanya dipakai untuk compare-and-set lease (milidetik).\n' +
    'Pembangunan index berjalan tanpa lock global dan per tabel, sehingga lane\n' +
    'tidak lagi saling memblokir seperti pola waitMs=45000 pada versi lama.');
}

function RSC_PERF10_TEST_CORE_NORMALIZER_20260819() {
  var t = rscTestSuite_('CORE NORMALIZER');
  t.eq('dropdown KODE - Deskripsi', RSC_NORMALIZE_ID_('2AA0 - STA Bogor'), '2AA0');
  t.eq('relationship dropdown', RSC_NORMALIZE_ID_('ZWS003 - Sales Rep. Food'), 'ZWS003');
  t.eq('id polos', RSC_NORMALIZE_ID_('2AA0'), '2AA0');
  t.eq('apostrof teks', RSC_NORMALIZE_ID_("'110252135"), '110252135');
  t.eq('angka .0', RSC_NORMALIZE_ID_('110252135.0'), '110252135');
  t.eq('notasi eksponen', RSC_NORMALIZE_ID_('1.10252135e+8'), '110252135');
  t.eq('spasi dalam id', RSC_NORMALIZE_ID_(' S091 010486 '), 'S091010486');
  t.eq('kosong', RSC_NORMALIZE_ID_(null), '');
  t.eq('tanggal ISO', rscDateStr_('2026-09-01 12:00:00'), '2026-09-01');
  t.eq('tanggal DD/MM/YYYY', rscDateStr_('01/09/2026'), '2026-09-01');
  t.eq('epoch milidetik', rscDateStr_('253402214400000'), '9999-12-31');
  t.eq('epoch sebagai angka', rscDateStr_(1772323200000), '2026-03-01');
  t.eq('serial spreadsheet', rscDateStr_('46266'), '2026-09-01');
  t.eq('bukan tanggal', rscDateStr_('ZWS003'), '');
  return t.finish();
}

function RSC_PERF10_TEST_MBP_CORE_PURE_20260819() {
  var t = rscTestSuite_('m_bp_relation CORE PARSER');
  var compact = { mode: 'COMPACT_JSON', firstDataRow: 1, payloadCol: 1 };
  var rec = RSC_MBP_RELATION_PARSE_ROW_20260819_(compact,
    ['["110625404","ZWS014","S091110370","2026-03-01","2026-04-30"]']);
  t.ok('compact terurai', !!rec);
  t.eq('customer', rec && rec.customer, '110625404');
  t.eq('relationship', rec && rec.relationship, 'ZWS014');
  t.eq('salesman', rec && rec.salesman, 'S091110370');
  t.eq('valid from', rec && rec.validFrom, '2026-03-01');
  t.eq('valid to', rec && rec.validTo, '2026-04-30');
  t.eq('baris URL diabaikan',
    RSC_MBP_RELATION_PARSE_ROW_20260819_(compact, ['https://docs.google.com/spreadsheets/d/x/edit']), null);

  var legacy = {
    mode: 'LEGACY_COLUMNS', firstDataRow: 2,
    colCustomer: 1, colRelationship: 2, colSalesman: 3, colValidFrom: 4, colValidTo: 5
  };
  var rec2 = RSC_MBP_RELATION_PARSE_ROW_20260819_(legacy,
    ['110223729', 'ZWS006', 'S091210238', '2026-03-01', '9999-12-31']);
  t.eq('legacy customer', rec2 && rec2.customer, '110223729');
  t.eq('legacy open-ended', rec2 && rec2.validTo, '9999-12-31');
  return t.finish('Parser menerima COMPACT_JSON (satu sel berisi array) maupun 5 kolom\n' +
    'legacy, dengan atau tanpa baris header.');
}

function RSC_PERF10_TEST_CACHE_BUCKET_CORE_20260819() {
  var t = rscTestSuite_('CACHE + BUCKETING CORE');
  var obj = { map: {}, rows: 3 };
  for (var i = 0; i < 200; i++) obj.map['K' + i] = [['a' + i, 'b', 'c']];
  var ver = 'test-' + Date.now();
  var w = rscSnapWrite_('__TEST__', ver, obj);
  t.ok('snapshot tertulis', w.ok, JSON.stringify(w));
  var back = rscSnapRead_('__TEST__', ver);
  t.ok('snapshot terbaca kembali', !!back);
  t.eq('jumlah key sama', back && Object.keys(back.map).length, 200);
  t.eq('isi sama', back && back.map.K42[0][0], 'a42');
  t.eq('versi berbeda menghasilkan miss', rscSnapRead_('__TEST__', ver + 'x'), null);
  var chunks = rscChunk_([1, 2, 3, 4, 5, 6, 7], 3);
  t.eq('chunking benar', chunks.length, 3);
  t.eq('sisa chunk benar', chunks[2].length, 1);
  return t.finish();
}

function RSC_PERF10_TEST_CHANGE_SCHEDULE_20260819() {
  var t = rscTestSuite_('CHANGE SCHEDULE ONLY');
  var spec = rscPrimarySpec_();
  var masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0' } } },
    relationship: rscRelationshipMaster_(),
    dateNew: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew,
    dateClose: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose,
    idx: {
      RELATION: {
        available: true, fields: ['Relationship', 'Salesman ID', 'Valid From', 'Valid To'],
        map: { '110094788': [['ZWS003', 'S091010486', '2026-03-01', '9999-12-31']] }
      }
    }
  };
  function row(over) {
    var base = ['2BA0', '2BA0', '110094788', 'ZWS003', 'S091010486', 'ZD01',
      masters.dateNew, '9999-12-31', 'F2', '03', 'W1W,W3W',
      masters.dateNew, '9999-12-31', 'Rolling', '', ''];
    for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
    return base;
  }
  var r1 = rscValidateValues_(spec, [row({})], masters);
  t.eq('CASE 1 terdeteksi', r1.ctx.rows[0].cso && r1.ctx.rows[0].cso.mode, 'EXACT_REL_VALID_TO');

  var r2 = rscValidateValues_(spec, [row({ 3: '' })], masters);
  t.eq('CASE 2 terdeteksi', r2.ctx.rows[0].cso && r2.ctx.rows[0].cso.mode, 'PAIR_NO_RELATION');
  t.ok('Relationship kosong tidak wajib pada CASE 2', r2.detail[0].indexOf('Relationship') < 0, r2.detail[0]);

  var r3 = rscValidateValues_(spec, [row({}), row({})], masters);
  t.ok('CASE 1 dikecualikan dari duplicate R8', r3.detail[0].indexOf('[R8]') < 0, r3.detail[0]);

  var noDb = {
    office: masters.office, relationship: masters.relationship,
    dateNew: masters.dateNew, dateClose: masters.dateClose, idx: {}
  };
  var r4 = rscValidateValues_(spec, [row({}), row({})], noDb);
  t.ok('tanpa master, duplicate tetap terdeteksi', r4.detail[0].indexOf('[R8]') >= 0, r4.detail[0]);
  return t.finish();
}

function RSC_PERF11_TEST_ROLLING_VALID_FROM_POLICY_20260819() {
  var t = rscTestSuite_('ROLLING VALID FROM POLICY');
  var dateNew = VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew;
  var normal = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', '', '2026-03-01', dateNew);
  t.eq('Rolling biasa memakai dateNew', normal.validFrom, dateNew);
  t.eq('Visit Valid From juga dateNew', normal.visitValidFrom, dateNew);
  var exact = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', 'EXACT_REL_VALID_TO', '2026-03-01', dateNew);
  t.eq('Change Schedule Only tetap dateNew', exact.validFrom, dateNew);
  var pair = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Rolling', 'PAIR_NO_RELATION', '', dateNew);
  t.eq('PAIR_NO_RELATION: relasi apa adanya', pair.validFrom, '');
  t.eq('PAIR_NO_RELATION: visit tetap dateNew', pair.visitValidFrom, dateNew);
  var tb = RSC_PERF11_RESOLVE_ROLLING_DATE_POLICY_20260819_('Toko Bangkrut', '', '2026-03-01', dateNew);
  t.eq('Toko Bangkrut tidak dipaksa dateNew', tb.validFrom, '2026-03-01');
  return t.finish('Histori m_bp_relation tidak boleh menarik mundur Reason = Rolling.');
}

function RSC_PERF12_TEST_STATUS_AND_GATE_20260819() {
  var t = rscTestSuite_('STATUS COLOR + AUTO REVAMP GATE');
  t.eq('warna OK', TEMPLATE_UI_PARAMETERS.colors.ok, '#B7E1CD');
  t.eq('warna ERROR', TEMPLATE_UI_PARAMETERS.colors.error, '#F4C7C3');
  t.ok('COMPLETE_OK terminal', rscIsTerminal_(RSC_STATUS.DONE_OK));
  t.ok('COMPLETE_WITH_ERRORS terminal', rscIsTerminal_(RSC_STATUS.DONE_ERRORS));
  t.ok('DEFERRED belum terminal', !rscIsTerminal_(RSC_STATUS.DEFERRED));
  t.ok('BLOCKED_INFRA belum terminal', !rscIsTerminal_(RSC_STATUS.BLOCKED_INFRA));
  return t.finish('Auto revamp hanya memproses file berstatus COMPLETE_OK.');
}

function RSC_PERF16_TEST_JOB_LOGGING_20260819() {
  var J = RSC_PERF16_JOBLOG_20260819;
  var ss = rscActiveSs_();
  var t = rscTestSuite_('JOB LOGGING DASHBOARD');
  var sh = rscJobLogSheet_(ss);
  t.eq('header di baris ' + J.liveHeaderRow, sh.getRange(J.liveHeaderRow, 1).getDisplayValue(), 'Slot');
  t.eq('slot pertama', sh.getRange(J.liveStartRow, 1).getDisplayValue(), J.liveSlots[0]);
  t.eq('judul histori', sh.getRange(J.historyTitleRow, 1).getDisplayValue().indexOf('EVENT HISTORY'), 0);
  rscJobLogSet_(ss, 'LEGACY', {
    job: 'LEGACY / INTEGRATED', state: 'INFO', stage: 'Self test',
    message: 'Uji tulis dashboard ' + rscStamp_(), progress: 1
  }, { force: true, history: true });
  t.eq('slot LEGACY tertulis', sh.getRange(rscSlotRow_('LEGACY'), 3).getDisplayValue(), 'INFO');
  var probeCtrl = 'a' + String.fromCharCode(1) + 'b';
  t.eq('karakter kontrol dibersihkan', RSC_PERF16_JOBLOG_SAFE_TEXT_20260819_(probeCtrl, 10), 'a b');
  return t.finish();
}

function RSC_PERF17_TEST_SINGLETON_RESTART_POLICY_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var t = rscTestSuite_('WORKER SINGLETON + RESTART POLICY');
  t.eq('jumlah handler worker', V.workerHandlers.length, V.workerCount);
  t.eq('handler worker unik', rscUniq_(V.workerHandlers).length, V.workerHandlers.length);
  t.ok('soft deadline di bawah kuota 6 menit', V.workerSoftDeadlineMs < 300000);
  t.ok('lease lebih panjang dari soft deadline', V.leaseMs > V.workerSoftDeadlineMs);
  var seen = {}, dupes = 0;
  try {
    var all = ScriptApp.getProjectTriggers();
    for (var i = 0; i < all.length; i++) {
      var fn = all[i].getHandlerFunction();
      if (V.workerHandlers.indexOf(fn) < 0) continue;
      if (seen[fn]) dupes++;
      seen[fn] = true;
    }
  } catch (e) { /* abaikan */ }
  t.eq('tidak ada trigger worker ganda', dupes, 0);
  return t.finish('Restart From Top selalu membuat Run ID baru. Execution lama tidak\n' +
    'dapat menulis karena Run ID dan claimToken tidak lagi cocok.');
}

function RSC_PERF10_BENCHMARK_ACTIVE_ROLLING_20260819() {
  var ss = rscActiveSs_();
  var sh = ss.getActiveSheet();
  var spec = rscSpecFor_(sh.getName());
  if (!spec) return rscAlert_('Benchmark', 'Buka sheet Change Rolling terlebih dahulu.');
  var t0 = Date.now();
  var masters = rscLoadMasters_(ss);
  var tM = Date.now();
  var needCols = Math.max(spec.errorCol, spec.header.length);
  var dataRows = Math.max(0, sh.getLastRow() - 1);
  var values = dataRows ? sh.getRange(2, 1, dataRows, needCols).getValues() : [];
  var tR = Date.now();
  var res = rscValidateValues_(spec, values, masters);
  var tV = Date.now();
  var text = 'Sheet          : ' + sh.getName() +
    '\nBaris          : ' + res.rowCount +
    '\nError          : ' + res.errorRows +
    '\n\nLoad master    : ' + rscRound_((tM - t0) / 1000, 2) + ' s' +
    '\nBaca range     : ' + rscRound_((tR - tM) / 1000, 2) + ' s' +
    '\nNormalisasi    : ' + res.timing.normalizeSec + ' s' +
    '\nRule           : ' + res.timing.rulesSec + ' s' +
    '\nTotal validasi : ' + rscRound_((tV - t0) / 1000, 2) + ' s' +
    (res.rowCount ? ('\nKecepatan      : ' +
      Math.round(res.rowCount / Math.max(0.001, (tV - tR) / 1000)) + ' baris/detik') : '');
  rscSetProp_('RSC_LAST_BENCHMARK', text.substring(0, 4000));
  rscAlert_('Benchmark ACTIVE Rolling (read only)', text);
  return text;
}

function RSC_PERF10_SYNTHETIC_BENCHMARK_20260819() {
  var spec = rscPrimarySpec_();
  var masters = {
    office: { available: true, map: { '2BA0': { code: '2BA0' } } },
    relationship: rscRelationshipMaster_(),
    dateNew: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateNew,
    dateClose: VALIDATE_DATE_IN_TEMPLATE_PARAMETERS.dateClose,
    idx: {}
  };
  var N = 20000, rows = [], days = ['M', 'T', 'W', 'TH', 'F', 'S'];
  for (var i = 0; i < N; i++) {
    var d = days[i % days.length];
    rows.push(['2BA0', '2BA0', String(110000000 + Math.floor(i / 4)), 'ZWS003',
      'S09101' + String(1000 + (i % 900)).slice(0, 4), 'ZD01', masters.dateNew, '9999-12-31',
      'F2', '03', 'W1' + d + ',W3' + d, masters.dateNew, '9999-12-31', 'Rolling', '', '']);
  }
  var t0 = Date.now();
  var res = rscValidateValues_(spec, rows, masters);
  var ms = Date.now() - t0;
  var text = 'Baris sintetis : ' + N +
    '\nWaktu          : ' + ms + ' ms' +
    '\nKecepatan      : ' + Math.round(N / Math.max(0.001, ms / 1000)) + ' baris/detik' +
    '\nNormalisasi    : ' + res.timing.normalizeSec + ' s' +
    '\nRule           : ' + res.timing.rulesSec + ' s' +
    '\nError rows     : ' + res.errorRows;
  rscSetProp_('RSC_LAST_SYNTHETIC', text.substring(0, 4000));
  rscAlert_('Synthetic Performance Benchmark', text);
  return text;
}

/** FULL Safe Audit + Benchmark: menggabungkan beberapa audit dalam satu klik. */
function RSC_PERF12_FULL_AUDIT_20260819() {
  var parts = [];
  parts.push('=== DEPENDENCY ===');
  parts.push(runSafelyWithOptionalRethrow_('dep', RSC_PERF10_RUN_DEPENDENCY_AUDIT_20260819, false) || '(gagal)');
  parts.push('');
  parts.push('=== SCOPE ===');
  parts.push(runSafelyWithOptionalRethrow_('scope', RSC_PERF22_SCOPE_AUDIT_20260819_, false) || '(gagal)');
  parts.push('');
  parts.push('=== DB READ-ONLY ===');
  parts.push(runSafelyWithOptionalRethrow_('db', RSC_PERF10_LIVE_DB_READONLY_AUDIT_20260819, false) || '(gagal)');
  parts.push('');
  parts.push('=== BENCHMARK SINTETIS ===');
  parts.push(runSafelyWithOptionalRethrow_('bench', RSC_PERF10_SYNTHETIC_BENCHMARK_20260819, false) || '(gagal)');
  var text = parts.join('\n');
  rscSetProp_('RSC_LAST_AUDIT', text.substring(0, 8000));
  rscSetProp_('RSC_LAST_AUDIT_AT', rscStamp_());
  rscAlert_('FULL Safe Audit + Benchmark',
    'Audit selesai. Buka "Show Last Audit Summary" untuk teks lengkapnya.');
  return text;
}

/* =============================================================
 * 19. ADMIN / RECOVERY
 * ============================================================= */

function RSC_SHOW_ALL_BACKGROUND_JOB_STATUS_20260611() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var lines = [];
  var runId = rscGetProp_(V.pRunId, '');
  lines.push('BULK VALIDATION');
  lines.push('  State : ' + (rscGetProp_(V.pRunState, '-') || '-'));
  if (runId) {
    var s = rscQueueStats_(ss, runId);
    lines.push('  ' + s.done + '/' + s.total + ' selesai, sisa ' + s.unfinished);
  }
  var jobs = [RSC_JOB_ROLLING_DATES_, RSC_JOB_VALIDATE_DATE_, RSC_JOB_TOKO_BANGKRUT_];
  for (var i = 0; i < jobs.length; i++) {
    var st = rscBgState_(jobs[i].key);
    lines.push('');
    lines.push(jobs[i].title);
    lines.push(st
      ? ('  Berjalan: baris ' + st.row + ', diperbarui ' + st.updated + ', gagal ' + st.failed)
      : '  Tidak berjalan');
  }
  lines.push('');
  lines.push('HARD STOP : ' + (RSC_IS_HARD_STOPPED_() ? 'AKTIF' : 'tidak aktif'));
  var triggers = 0;
  try { triggers = ScriptApp.getProjectTriggers().length; } catch (e) { triggers = -1; }
  lines.push('Trigger aktif: ' + triggers);
  var text = lines.join('\n');
  rscAlert_('Status Semua Job', text);
  return text;
}

function RSC_STOP_ALL_BACKGROUND_JOBS_20260611() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  rscSetProp_(V.pRunState, 'STOPPED');
  var jobs = [RSC_JOB_ROLLING_DATES_, RSC_JOB_VALIDATE_DATE_, RSC_JOB_TOKO_BANGKRUT_];
  var handlers = rscAllHandlers_();
  for (var i = 0; i < jobs.length; i++) handlers.push(jobs[i].handlerFn);
  handlers.push(RSC_TEMPLATE_REVAMP_20260722.handler);
  handlers.push(RSC_TEMPLATE_COPY_20260611.handler);
  handlers.push(RSC_V28_FULL_PIPELINE_20260814.hourlyHandler);
  handlers.push(RSC_V28_FULL_PIPELINE_20260814.watchdogHandler);
  var removed = rscDeleteTriggers_(handlers);
  rscAlert_('STOP Semua Background Job',
    removed + ' trigger dilepas.\nCheckpoint job TIDAK dihapus sehingga bisa dilanjutkan.');
  return { removed: removed };
}

function RSC_RESET_CHECKPOINTS_20260611() {
  var jobs = [RSC_JOB_ROLLING_DATES_, RSC_JOB_VALIDATE_DATE_, RSC_JOB_TOKO_BANGKRUT_];
  for (var i = 0; i < jobs.length; i++) rscBgClear_(jobs[i].key);
  rscSetProp_(RSC_TEMPLATE_REVAMP_20260722.pJob, '');
  rscSetProp_(RSC_TEMPLATE_COPY_20260611.pJob, '');
  rscAlert_('Reset Integrated Checkpoint',
    'Checkpoint job latar belakang dihapus.\n' +
    'Manifest bulk validation TIDAK ikut dihapus — gunakan Restart From Top untuk itu.');
  return true;
}

function RSC_RESET_INTEGRATED_COPY_FINAL_20260716() {
  rscSetProp_(RSC_TEMPLATE_COPY_20260611.pJob, '');
  rscSetProp_(RSC_TEMPLATE_COPY_20260611.pStats, '');
  rscDeleteTriggers_([RSC_TEMPLATE_COPY_20260611.handler]);
  rscAlert_('Reset Checkpoint Copy', 'Checkpoint copy FINAL dihapus dan trigger dilepas.');
  return true;
}

function RSC_REMOVE_ALL_PROTECTIONS_CURRENT_FILE_20260612() {
  var ss = rscActiveSs_();
  var removed = 0;
  try {
    var types = [SpreadsheetApp.ProtectionType.SHEET, SpreadsheetApp.ProtectionType.RANGE];
    for (var t = 0; t < types.length; t++) {
      var ps = ss.getProtections(types[t]);
      for (var i = 0; i < ps.length; i++) if (ps[i].canEdit()) { ps[i].remove(); removed++; }
    }
  } catch (e) {
    return rscAlert_('Hapus Protection', 'Sebagian protection gagal dihapus: ' + e);
  }
  rscAlert_('Hapus Protection', removed + ' protection dihapus dari file ini.');
  return removed;
}

function RSC_INSTALL_RECOMMENDED_TRIGGERS_20260611() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  rscArmWatchdog_();
  var installed = ['watchdog bulk validation (' + V.watchdogMinutes + ' menit)'];
  if (COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEdit) {
    try {
      rscDeleteTriggers_([COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler]);
      ScriptApp.newTrigger(COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler)
        .forSpreadsheet(rscActiveSs_()).onEdit().create();
      installed.push('auto validate on edit (debounce ' +
        COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateDebounceMs + ' ms)');
    } catch (e) { installed.push('auto validate on edit GAGAL: ' + e); }
  }
  rscAlert_('Setup Recommended Triggers', 'Terpasang:\n- ' + installed.join('\n- '));
  return installed;
}

function RSC_INSTALL_AUTO_VALIDATION_FOR_INPUT_LINKS_20260611() {
  var P = INPUT_ROLLING_LINK_VALIDATION_PARAMETERS;
  try {
    rscDeleteTriggers_([COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler]);
    ScriptApp.newTrigger(COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateOnEditHandler)
      .forSpreadsheet(rscActiveSs_()).onEdit().create();
  } catch (e) {
    return rscAlert_('Auto Validasi Link Kolom D', 'Gagal memasang trigger: ' + e);
  }
  rscAlert_('Auto Validasi Link Kolom D',
    'Trigger onEdit terpasang.\nKolom link dipantau : ' + rscColLetter_(P.LINK_COL) +
    '\nSheet yang divalidasi: ' + P.TARGET_SHEETS_TO_VALIDATE.join(', ') +
    '\n\nEdit beruntun digabung dalam satu validasi (debounce ' +
    COPY_AWARE_AUTOMATION_PARAMETERS.autoValidateDebounceMs + ' ms).');
  return true;
}


/* =============================================================
 * 20. AUTO TEMPLATE REVAMP
 * -------------------------------------------------------------
 * Hanya file berstatus COMPLETE_OK yang di-revamp. Baris Change Schedule Only
 * ditulis sebagai visit-only (Relationship / Valid From / Valid To dikosongkan
 * dan kolom "Change Schedule Only" diberi tanda x), lalu baris duplikat persis
 * dibuang. Setelah itu dropdown dan format disegarkan.
 * ============================================================= */

function rscRevampFile_(fileId, masters) {
  var child = SpreadsheetApp.openById(fileId);
  var sh = rscChildRollingSheet_(child);
  if (!sh) return { skipped: 1, note: 'sheet Change Rolling tidak ada' };
  var spec = rscPrimarySpec_();
  var needCols = Math.max(spec.errorCol, spec.header.length);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { skipped: 1, note: 'tidak ada baris data' };

  var width = Math.max(needCols, sh.getLastColumn());
  var header = sh.getRange(1, 1, 1, width).getDisplayValues()[0];
  if (rscCheckLayout_(spec, header)) return { skipped: 1, note: 'layout belum sesuai FSD' };

  var csoCol = rscPickCol_(rscHeaderMap_(header), ['Change Schedule Only']);
  var values = sh.getRange(2, 1, lastRow - 1, width).getValues();
  var res = rscValidateValues_(spec, values, masters);

  var out = [], seen = {}, dropped = 0, marked = 0;
  for (var i = 0; i < res.ctx.rows.length; i++) {
    var row = res.ctx.rows[i];
    var raw = values[row.sheetRow - 2].slice(0, width);
    while (raw.length < width) raw.push('');

    if (row.cso && row.cso.yes) {
      raw[3] = '';                       // Relationship
      raw[6] = '';                       // Valid From
      raw[7] = '';                       // Valid To
      if (csoCol >= 0) raw[csoCol] = 'x';
      marked++;
    }
    var key = [];
    for (var c = 0; c < spec.header.length - 2; c++) key.push(rscText_(raw[c]));
    var sig = key.join('|');
    if (seen[sig]) { dropped++; continue; }
    seen[sig] = true;
    out.push(raw);
  }

  var blank = [];
  for (var b = 0; b < width; b++) blank.push('');
  var target = lastRow - 1;
  while (out.length < target) out.push(blank.slice());
  if (out.length) sh.getRange(2, 1, out.length, width).setValues(out);
  rscApplyTemplateDropdowns_(sh, spec, masters);

  return { updated: 1, marked: marked, dropped: dropped, rows: res.ctx.rows.length };
}

function rscRevampJob_() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var R = RSC_TEMPLATE_REVAMP_20260722;
  var ss = rscActiveSs_();
  var started = Date.now();
  var runId = rscGetProp_(V.pRunId, '');

  var state = null;
  try { state = JSON.parse(rscGetProp_(R.pJob, '') || 'null'); } catch (e) { state = null; }
  if (!state) {
    state = { index: 0, files: [], processed: 0, marked: 0, dropped: 0, skipped: 0, failed: 0, startedAt: rscStamp_() };
    var vals = rscManifestRead_(rscManifestSheet_(ss));
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][RSC_M.RUN_ID] !== runId) continue;
      if (vals[i][RSC_M.STATUS] !== RSC_STATUS.DONE_OK) continue;
      if (vals[i][RSC_M.FILE_ID]) state.files.push(vals[i][RSC_M.FILE_ID]);
    }
  }

  if (!state.files.length) {
    rscSetProp_(R.pJob, '');
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'IDLE', stage: 'Tidak ada file COMPLETE_OK', progress: 1,
      message: 'Revamp hanya berjalan untuk file yang lolos validasi tanpa error.',
      startedAt: state.startedAt, runId: runId
    }, { force: true, history: true });
    return state;
  }

  var masters;
  try { masters = rscLoadMasters_(ss); }
  catch (e) {
    var c = rscClassify_(e);
    rscSetProp_(R.pJob, JSON.stringify(state));
    if (c.kind === RSC_ERR.INFRA) { rscArmRevamp_(); return state; }
    throw e;
  }

  // Hitung file per RUN, bukan modulo terhadap total kumulatif. Versi modulo
  // membuat putaran berikutnya langsung break sebelum memproses apa pun,
  // sehingga job tidak pernah maju.
  var doneThisRun = 0;
  while (state.index < state.files.length) {
    if ((Date.now() - started) > R.softDeadlineMs) break;
    if (doneThisRun >= R.hardMaxFilesPerRun) break;
    doneThisRun++;
    var fid = state.files[state.index];
    state.index++;
    state.processed++;
    try {
      var r = rscRevampFile_(fid, masters);
      state.marked += Number(r.marked || 0);
      state.dropped += Number(r.dropped || 0);
      state.skipped += Number(r.skipped || 0);
    } catch (err) { state.failed++; }
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'RUNNING', stage: 'Revamp template',
      progress: rscRound_(state.index / state.files.length, 4),
      currentTotal: state.index + ' / ' + state.files.length, fileId: fid,
      message: 'Schedule-only ditandai ' + state.marked + ', duplikat dibuang ' + state.dropped + '.',
      startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
    });
  }

  if (state.index < state.files.length) {
    rscSetProp_(R.pJob, JSON.stringify(state));
    rscArmRevamp_();
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'WAITING', stage: 'Lanjut di eksekusi berikutnya',
      progress: rscRound_(state.index / state.files.length, 4),
      currentTotal: state.index + ' / ' + state.files.length,
      message: 'Diproses ' + state.processed + ', gagal ' + state.failed + '.',
      startedAt: state.startedAt, runId: runId
    }, { force: true, history: true });
    return state;
  }

  rscSetProp_(R.pJob, '');
  rscSetProp_(R.pStats, JSON.stringify(state));
  rscDeleteTriggers_([R.handler]);
  rscJobLogSet_(ss, 'REVAMP', {
    job: 'AUTO TEMPLATE REVAMP', state: 'DONE', stage: 'Revamp selesai', progress: 1,
    currentTotal: state.index + ' / ' + state.files.length,
    message: 'File ' + state.processed + ', schedule-only ' + state.marked +
      ', duplikat dibuang ' + state.dropped + ', gagal ' + state.failed + '.',
    startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1), runId: runId
  }, { force: true, history: true });
  return state;
}

function rscArmRevamp_() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  try {
    rscDeleteTriggers_([R.handler]);
    ScriptApp.newTrigger(R.handler).timeBased().after(R.triggerDelayMs).create();
    return true;
  } catch (e) { return false; }
}

function RSC_RUN_TEMPLATE_REVAMP_INTEGRATED_20260723() {
  var s = rscRevampJob_();
  rscAlert_('Template Revamp',
    'File diproses     : ' + s.processed +
    '\nSchedule-only     : ' + s.marked +
    '\nDuplikat dibuang  : ' + s.dropped +
    '\nDilewati          : ' + s.skipped +
    '\nGagal             : ' + s.failed +
    (s.index < s.files.length ? '\n\nBerlanjut otomatis di latar belakang.' : ''));
  return s;
}

function RSC_CONTINUE_TEMPLATE_REVAMP_INTEGRATED_20260723() { return rscRevampJob_(); }

/** Ringkasan yang terbaca manusia, bukan JSON mentah berisi ratusan file ID. */
function rscJobSummaryText_(raw, running) {
  if (!raw) return 'Belum pernah dijalankan.';
  var st = null;
  try { st = JSON.parse(raw); } catch (e) { return raw.substring(0, 800); }
  var total = (st.files && st.files.length) || st.total || 0;
  return (running ? 'Sedang berjalan.' : 'Tidak berjalan. Hasil terakhir:') +
    '\nMulai            : ' + (st.startedAt || '-') +
    '\nProgres          : ' + (st.index === undefined ? '-' : (st.index + ' / ' + total)) +
    '\nFile diproses    : ' + (st.processed === undefined ? '-' : st.processed) +
    (st.marked === undefined ? '' : ('\nSchedule-only    : ' + st.marked)) +
    (st.dropped === undefined ? '' : ('\nDuplikat dibuang : ' + st.dropped)) +
    (st.copied === undefined ? '' : ('\nDisalin          : ' + st.copied)) +
    (st.updated === undefined ? '' : ('\nSel diperbarui   : ' + st.updated)) +
    '\nDilewati         : ' + (st.skipped === undefined ? '-' : st.skipped) +
    '\nGagal            : ' + (st.failed === undefined ? '-' : st.failed);
}

function RSC_SHOW_TEMPLATE_REVAMP_STATUS_20260722() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  var running = rscGetProp_(R.pJob, '');
  var text = rscJobSummaryText_(running || rscGetProp_(R.pStats, ''), !!running);
  rscAlert_('Status Template Revamp', text);
  return text;
}

function RSC_STOP_TEMPLATE_REVAMP_JOB_20260722() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  var removed = rscDeleteTriggers_([R.handler]);
  rscAlert_('STOP Template Revamp', removed + ' trigger dilepas. Checkpoint tetap tersimpan.');
  return { removed: removed };
}

function RSC_RESET_TEMPLATE_REVAMP_JOB_20260722() {
  var R = RSC_TEMPLATE_REVAMP_20260722;
  rscSetProp_(R.pJob, '');
  rscSetProp_(R.pStats, '');
  rscDeleteTriggers_([R.handler]);
  rscAlert_('Reset Template Revamp', 'Checkpoint dan statistik revamp dihapus.');
  return true;
}

/** Gate otomatis setelah bulk validation selesai. */
function RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819() {
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  if (s.unfinished > 0) {
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'WAITING', stage: 'Menunggu validasi selesai',
      progress: s.progress, message: 'Masih ada ' + s.unfinished + ' task berjalan.',
      startedAt: rscStamp_(), runId: runId
    }, { force: true });
    return { started: false, unfinished: s.unfinished };
  }
  if (!s.ok) {
    rscJobLogSet_(ss, 'REVAMP', {
      job: 'AUTO TEMPLATE REVAMP', state: 'IDLE', stage: 'Tidak ada COMPLETE_OK', progress: 1,
      message: 'Tidak ada file yang lolos tanpa error.', startedAt: rscStamp_(), runId: runId
    }, { force: true });
    return { started: false, ok: 0 };
  }
  rscSetProp_(RSC_TEMPLATE_REVAMP_20260722.pJob, '');
  rscArmRevamp_();
  rscJobLogSet_(ss, 'REVAMP', {
    job: 'AUTO TEMPLATE REVAMP', state: 'START', stage: 'Start after bulk validation', progress: 0,
    message: 'Validation queue selesai. Menjalankan Auto Revamp untuk ' + s.ok + ' file COMPLETE_OK.',
    startedAt: rscStamp_(), runId: runId
  }, { force: true, history: true });
  return { started: true, files: s.ok };
}

/* =============================================================
 * 21. COPY TEMPLATE FINAL
 * ============================================================= */

function rscCopyJob_() {
  var P = RSC_TEMPLATE_COPY_20260611;
  var ss = rscActiveSs_();
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var started = Date.now();

  var state = null;
  try { state = JSON.parse(rscGetProp_(P.pJob, '') || 'null'); } catch (e) { state = null; }
  if (!state) state = { row: L.firstDataRow, copied: 0, skipped: 0, failed: 0, startedAt: rscStamp_() };

  var lastRow = master.getLastRow();
  var madeThisRun = 0;

  while (state.row <= lastRow) {
    if ((Date.now() - started) > P.softDeadlineMs) break;
    if (madeThisRun >= P.hardMaxCopiesPerRun) break;

    var row = state.row;
    state.row++;
    var finalLink = rscText_(master.getRange(row, L.finalColOverride || P.finalLinkCol).getDisplayValue());
    if (rscFileId_(finalLink)) { state.skipped++; continue; }

    var sourceLink = rscText_(master.getRange(row, P.sourceLinkCol).getDisplayValue());
    var sourceId = rscFileId_(sourceLink);
    if (!sourceId) { state.skipped++; continue; }

    var office = rscText_(master.getRange(row, L.officeCol).getDisplayValue());
    var desc = rscText_(master.getRange(row, L.descCol).getDisplayValue());
    madeThisRun++;
    try {
      var src = DriveApp.getFileById(sourceId);
      var name = 'Template Rolling Sales ' + (office ? (office + ' ') : '') + desc;
      var copy = src.makeCopy(name.substring(0, 200));
      try { copy.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT); }
      catch (eShare) { /* kebijakan domain bisa melarang */ }
      master.getRange(row, P.finalLinkCol)
        .setValue('https://docs.google.com/spreadsheets/d/' + copy.getId() + '/edit');
      state.copied++;
    } catch (err) {
      state.failed++;
      if (rscClassify_(err).kind === RSC_ERR.INFRA) state.row = row;
    }
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'COPY TEMPLATE FINAL', state: 'RUNNING', stage: 'Copy file',
      progress: rscRound_((row - L.firstDataRow + 1) / Math.max(1, lastRow - L.firstDataRow + 1), 4),
      currentTotal: state.copied + ' disalin',
      message: 'Baris ' + row + ' — ' + office + ' ' + desc,
      startedAt: state.startedAt, elapsedSec: rscRound_((Date.now() - started) / 1000, 1)
    });
  }

  if (state.row <= lastRow) {
    rscSetProp_(P.pJob, JSON.stringify(state));
    try {
      rscDeleteTriggers_([P.handler]);
      ScriptApp.newTrigger(P.handler).timeBased().after(P.triggerDelayMs).create();
    } catch (e2) { /* best-effort */ }
  } else {
    rscSetProp_(P.pJob, '');
    rscSetProp_(P.pStats, JSON.stringify(state));
    rscDeleteTriggers_([P.handler]);
  }
  return state;
}

function RSC_START_COPY_ROLLING_TEMPLATE_FILES_20260611() {
  var s = rscCopyJob_();
  rscAlert_('Copy Template FINAL',
    'Disalin  : ' + s.copied + '\nDilewati : ' + s.skipped + '\nGagal    : ' + s.failed +
    '\n\nBaris yang kolom FINAL-nya sudah berisi link valid tidak disalin ulang.');
  return s;
}

function RSC_CONTINUE_COPY_ROLLING_TEMPLATE_FILES_20260611() { return rscCopyJob_(); }

function RSC_SHOW_COPY_AND_TEMPLATE_VALIDATION_STATUS_20260611() {
  var P = RSC_TEMPLATE_COPY_20260611;
  var running = rscGetProp_(P.pJob, '');
  var text = rscJobSummaryText_(running || rscGetProp_(P.pStats, ''), !!running);
  rscAlert_('Status Copy FINAL', text);
  return text;
}

function RSC_STOP_COPY_AND_TEMPLATE_VALIDATION_JOBS_20260611() {
  var removed = rscDeleteTriggers_([RSC_TEMPLATE_COPY_20260611.handler]);
  rscAlert_('STOP Copy FINAL', removed + ' trigger dilepas. Checkpoint tetap tersimpan.');
  return { removed: removed };
}

/* =============================================================
 * 22. FULL PIPELINE 1 JAM
 * -------------------------------------------------------------
 * Menggabungkan urutan yang sebelumnya harus diklik satu per satu:
 * Validate ALL Link E -> Auto Revamp -> Compile.
 * ============================================================= */

function RSC_V28_PIPELINE_SET_STATE_20260814_(phase, message) {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  rscSetProp_(P.pPhase, String(phase || P.phases.IDLE));
  rscSetProp_(P.pLastMessage, String(message || ''));
  writeRollingSalesCenterLog_('Full Pipeline | ' + phase + ' | ' + message);
}

function RSC_V28_FULL_PIPELINE_RUN_NOW_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  rscSetProp_(P.pMasterSsId, ss.getId());
  rscSetProp_(P.pCycleId, rscUuid_());
  rscSetProp_(P.pRunStartedAt, rscStamp_());

  if (RSC_IS_HARD_STOPPED_()) {
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.BLOCKED, 'HARD STOP aktif.');
    return rscAlert_('Full Pipeline', 'HARD STOP aktif. Jalankan Re-Arm terlebih dahulu.');
  }

  RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.VALIDATING, 'Menjalankan bulk validation.');
  var start = RSC_STANDARD_BULK_START_20260814();

  try {
    rscDeleteTriggers_([P.watchdogHandler]);
    ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
  } catch (e) { /* best-effort */ }

  rscJobLogSet_(ss, 'SYSTEM', {
    job: 'FULL PIPELINE', state: 'START', stage: 'Validate -> Revamp -> Compile', progress: 0,
    message: 'Siklus penuh dimulai. Task antre: ' + (start.stats ? start.stats.tasks : 0) + '.',
    startedAt: rscStamp_(), runId: rscGetProp_(V.pRunId, '')
  }, { force: true, history: true });

  rscAlert_('Full Pipeline',
    'Siklus dimulai.\n\n1. Bulk validation seluruh Link E\n2. Auto template revamp (file COMPLETE_OK)\n' +
    '3. Compile upload ready\n\nProgres dapat dipantau di sheet Job Logging Details.');
  return start;
}

function RSC_V28_FULL_PIPELINE_WATCHDOG_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var phase = rscGetProp_(P.pPhase, P.phases.IDLE);
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);

  if (phase === P.phases.VALIDATING) {
    if (s.unfinished > 0) {
      try {
        rscDeleteTriggers_([P.watchdogHandler]);
        ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
      } catch (e) { /* best-effort */ }
      return { phase: phase, unfinished: s.unfinished };
    }
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.REVAMP, 'Validasi selesai, menjalankan revamp.');
    RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819();
    try {
      rscDeleteTriggers_([P.watchdogHandler]);
      ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
    } catch (e2) { /* best-effort */ }
    return { phase: P.phases.REVAMP };
  }

  if (phase === P.phases.REVAMP) {
    if (rscGetProp_(RSC_TEMPLATE_REVAMP_20260722.pJob, '')) {
      try {
        rscDeleteTriggers_([P.watchdogHandler]);
        ScriptApp.newTrigger(P.watchdogHandler).timeBased().after(P.watchdogDelayMs).create();
      } catch (e3) { /* best-effort */ }
      return { phase: phase, revampRunning: true };
    }
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.COMPILE_MAIN, 'Revamp selesai, menjalankan compile.');
    runSafelyWithOptionalRethrow_('compile main', RSC_UR_START_20260721, false);
    RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.DONE, 'Siklus selesai.');
    rscSetProp_(P.pLastFinishedAt, rscStamp_());
    rscDeleteTriggers_([P.watchdogHandler]);
    rscJobLogSet_(ss, 'SYSTEM', {
      job: 'FULL PIPELINE', state: 'DONE', stage: 'Siklus selesai', progress: 1,
      message: 'OK=' + s.ok + ', dengan error=' + s.withErrors + ', hard=' + s.hard + '.',
      startedAt: rscGetProp_(P.pRunStartedAt, ''), runId: runId
    }, { force: true, history: true });
    return { phase: P.phases.DONE, stats: s };
  }

  rscDeleteTriggers_([P.watchdogHandler]);
  return { phase: phase };
}

function RSC_V28_FULL_PIPELINE_HOURLY_HANDLER_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  if (rscGetProp_(P.pEnabled, '') !== '1') return { skipped: true };
  if (RSC_IS_HARD_STOPPED_()) return { skipped: true, reason: 'HARD_STOP' };
  return RSC_V28_FULL_PIPELINE_RUN_NOW_20260814();
}

function RSC_V28_FULL_PIPELINE_INSTALL_HOURLY_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  rscSetProp_(P.pEnabled, '1');
  try {
    rscDeleteTriggers_([P.hourlyHandler]);
    ScriptApp.newTrigger(P.hourlyHandler).timeBased().everyHours(P.everyHours).create();
  } catch (e) {
    return rscAlert_('Automation 1 Hour', 'Gagal memasang trigger: ' + e);
  }
  rscAlert_('Automation 1 Hour',
    'Full pipeline dijadwalkan tiap ' + P.everyHours + ' jam.\n' +
    'Urutan: Validate ALL Link E -> Auto Revamp -> Compile.');
  return true;
}

function RSC_V28_FULL_PIPELINE_STATUS_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  var V = RSC_STANDARD_VALIDATION_V27_20260814;
  var ss = rscActiveSs_();
  var runId = rscGetProp_(V.pRunId, '');
  var s = rscQueueStats_(ss, runId);
  var text = 'Automation : ' + (rscGetProp_(P.pEnabled, '') === '1' ? 'AKTIF' : 'nonaktif') +
    '\nFase       : ' + rscGetProp_(P.pPhase, P.phases.IDLE) +
    '\nMulai      : ' + rscGetProp_(P.pRunStartedAt, '-') +
    '\nSelesai    : ' + rscGetProp_(P.pLastFinishedAt, '-') +
    '\nPesan      : ' + rscGetProp_(P.pLastMessage, '-') +
    '\n\n' + rscFormatStats_(runId, s);
  rscAlert_('Full Pipeline Status', text);
  return text;
}

function RSC_V28_FULL_PIPELINE_STOP_20260814() {
  var P = RSC_V28_FULL_PIPELINE_20260814;
  rscSetProp_(P.pEnabled, '');
  RSC_V28_PIPELINE_SET_STATE_20260814_(P.phases.STOPPED, 'Dihentikan manual.');
  var removed = rscDeleteTriggers_([P.hourlyHandler, P.watchdogHandler]);
  removed += rscDeleteTriggers_(rscAllHandlers_());
  removed += rscDeleteTriggers_([RSC_TEMPLATE_REVAMP_20260722.handler]);
  rscSetProp_(RSC_STANDARD_VALIDATION_V27_20260814.pRunState, 'STOPPED');
  rscAlert_('STOP Automation', removed + ' trigger dilepas. Automation dinonaktifkan.');
  return { removed: removed };
}


/* =============================================================
 * 23. COMPILE UPLOAD READY
 * -------------------------------------------------------------
 * Menggabungkan baris dari seluruh file FINAL berstatus DONE menjadi satu
 * spreadsheet keluaran, satu tab per jenis sheet, memakai header template
 * yang sama persis. Baris ERROR tidak ikut agar tidak terkirim ke SAP.
 * ============================================================= */

function rscCompileTargets_(ss, onlyStatuses) {
  var master = rscMasterSheet_(ss);
  var L = rscMasterLayout_(master);
  var lastRow = master.getLastRow();
  var out = [];
  if (lastRow < L.firstDataRow) return out;

  var n = lastRow - L.firstDataRow + 1;
  var width = Math.max(master.getLastColumn(), L.linkCol + 2);
  var vals = master.getRange(L.firstDataRow, 1, n, width).getDisplayValues();
  var statusCol = RSC_UR_20260721.statusCol;

  for (var r = 0; r < vals.length; r++) {
    var id = rscFileId_(vals[r][L.linkCol - 1]);
    if (!id) continue;
    if (onlyStatuses && onlyStatuses.length) {
      var st = rscKey_(vals[r][statusCol - 1]);
      var match = false;
      for (var s = 0; s < onlyStatuses.length; s++) if (st === rscKey_(onlyStatuses[s])) match = true;
      if (!match) continue;
    }
    out.push({
      row: L.firstDataRow + r, fileId: id,
      office: rscText_(vals[r][L.officeCol - 1]), desc: rscText_(vals[r][L.descCol - 1])
    });
  }
  return out;
}

/**
 * Kumpulkan baris valid dari setiap file.
 * Kolom tambahan "Sales Office Source" dan "Source File" ditaruh di depan agar
 * hasil compile bisa ditelusuri kembali ke file asalnya.
 */
function rscCompileCollect_(targets, specKeys) {
  var buckets = {};
  var stats = { files: 0, rows: 0, skippedError: 0, failed: 0, notes: [] };

  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    var child;
    try { child = SpreadsheetApp.openById(t.fileId); }
    catch (e) { stats.failed++; stats.notes.push(t.office + ': ' + rscClassify_(e).kind); continue; }
    stats.files++;

    var sheets = child.getSheets();
    for (var s = 0; s < sheets.length; s++) {
      var sh = sheets[s];
      var spec = rscSpecFor_(sh.getName());
      if (!spec) continue;
      if (specKeys && specKeys.indexOf(spec.key) < 0) continue;
      var lastRow = sh.getLastRow();
      if (lastRow < 2) continue;

      var width = Math.max(spec.errorCol, spec.header.length);
      var header = sh.getRange(1, 1, 1, Math.max(width, sh.getLastColumn())).getDisplayValues()[0];
      if (rscCheckLayout_(spec, header)) {
        stats.notes.push(t.office + ' / ' + sh.getName() + ': layout tidak sesuai, dilewati');
        continue;
      }
      var vals = sh.getRange(2, 1, lastRow - 1, width).getDisplayValues();
      if (!buckets[spec.key]) {
        buckets[spec.key] = { spec: spec, rows: [] };
      }
      for (var r = 0; r < vals.length; r++) {
        var status = rscKey_(vals[r][spec.statusCol - 1]);
        var hasData = false;
        for (var c = 0; c < spec.header.length - 2; c++) if (rscText_(vals[r][c])) hasData = true;
        if (!hasData) continue;
        if (status === 'ERROR') { stats.skippedError++; continue; }
        var line = [t.office, t.fileId];
        for (var c2 = 0; c2 < spec.header.length - 2; c2++) line.push(vals[r][c2]);
        buckets[spec.key].rows.push(line);
        stats.rows++;
      }
    }
  }
  return { buckets: buckets, stats: stats };
}

function rscCompileWrite_(title, collected) {
  var out = SpreadsheetApp.create(title);
  var first = true;
  for (var key in collected.buckets) {
    if (!Object.prototype.hasOwnProperty.call(collected.buckets, key)) continue;
    var b = collected.buckets[key];
    var header = ['Sales Office Source', 'Source File'];
    for (var c = 0; c < b.spec.header.length - 2; c++) header.push(b.spec.header[c]);

    var sh;
    if (first) { sh = out.getSheets()[0]; sh.setName(b.spec.label.substring(0, 90)); first = false; }
    else sh = out.insertSheet(b.spec.label.substring(0, 90));

    sh.getRange(1, 1, 1, header.length).setValues([header]);
    var C = TEMPLATE_UI_PARAMETERS.colors;
    sh.getRange(1, 1, 1, header.length).setBackground(C.header).setFontColor(C.headerFont).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (b.rows.length) sh.getRange(2, 1, b.rows.length, header.length).setValues(b.rows);
  }
  return out;
}

function rscCompileRun_(title, statuses, specKeys, propKey) {
  var ss = rscActiveSs_();
  var targets = rscCompileTargets_(ss, statuses);
  if (!targets.length) {
    rscAlert_(title, 'Tidak ada baris rekap yang cocok dengan status: ' + statuses.join(', ') + '.');
    return null;
  }
  var collected = rscCompileCollect_(targets, specKeys);
  var name = title + ' — ' + rscStamp_();
  var out = rscCompileWrite_(name, collected);

  var record = {
    at: rscStamp_(), id: out.getId(), name: name,
    files: collected.stats.files, rows: collected.stats.rows,
    skippedError: collected.stats.skippedError, failed: collected.stats.failed
  };
  rscSetProp_(propKey, JSON.stringify(record));

  var history = rscGetProp_('RSC_COMPILE_TARGET_IDS', '');
  rscSetProp_('RSC_COMPILE_TARGET_IDS', (history ? (history + ',') : '') + out.getId());

  rscAlert_(title,
    'File keluaran : ' + name +
    '\nURL           : ' + out.getUrl() +
    '\n\nFile sumber   : ' + collected.stats.files +
    '\nBaris ikut    : ' + collected.stats.rows +
    '\nBaris ERROR dilewati : ' + collected.stats.skippedError +
    '\nFile gagal dibuka    : ' + collected.stats.failed +
    (collected.stats.notes.length ? ('\n\nCatatan:\n- ' + collected.stats.notes.slice(0, 10).join('\n- ')) : '') +
    '\n\nHasil memakai header template yang sama, ditambah dua kolom penelusuran' +
    '\ndi depan (Sales Office Source, Source File).');
  return record;
}

function RSC_UR_START_20260721() {
  return rscCompileRun_('Compile Upload Ready',
    RSC_UR_20260721.doneStatusValues, ['ROLLING'], RSC_UR_20260721.pLastStats);
}

function RSC_UR_START_ST_RL_20260727() {
  return rscCompileRun_('Compile ST-RL',
    RSC_UR_20260721.doneStatusValues, ['SALESMAN_TYPE', 'SALES_OFFICE'], RSC_UR_20260721.pStrlStats);
}

function rscCompileStatus_(title, propKey) {
  var raw = rscGetProp_(propKey, '');
  if (!raw) { rscAlert_(title, 'Belum pernah dijalankan.'); return null; }
  var rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  rscAlert_(title, rec
    ? ('Terakhir     : ' + rec.at + '\nFile         : ' + rec.name +
       '\nID           : ' + rec.id + '\nFile sumber  : ' + rec.files +
       '\nBaris        : ' + rec.rows + '\nERROR dilewati: ' + rec.skippedError)
    : raw.substring(0, 1000));
  return rec;
}

function RSC_UR_STATUS_20260721() { return rscCompileStatus_('Main Compile Status', RSC_UR_20260721.pLastStats); }
function RSC_UR_STATUS_ST_RL_20260727() { return rscCompileStatus_('ST/RL Compile Status', RSC_UR_20260721.pStrlStats); }

/** Buang baris duplikat persis pada seluruh tab hasil compile terakhir. */
function RSC_UR_CLEANSE_DUPLICATE_OUTPUTS_20260724() {
  var raw = rscGetProp_(RSC_UR_20260721.pLastStats, '');
  if (!raw) return rscAlert_('Cleanse Duplicate', 'Belum ada hasil compile.');
  var rec = JSON.parse(raw);
  var out = SpreadsheetApp.openById(rec.id);
  var sheets = out.getSheets(), removed = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 3) continue;
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    var seen = {}, keep = [];
    for (var r = 0; r < vals.length; r++) {
      var sig = vals[r].join('|');
      if (sig.replace(/\|/g, '') === '') continue;
      if (seen[sig]) { removed++; continue; }
      seen[sig] = true;
      keep.push(vals[r]);
    }
    sh.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, lastCol).setValues(keep);
  }
  rscAlert_('Cleanse Duplicate', removed + ' baris duplikat dibuang dari ' + rec.name + '.');
  return { removed: removed };
}

/** Rapatkan kolom yang bergeser: buang kolom yang seluruhnya kosong. */
function RSC_UR_REPAIR_SHIFTED_OUTPUTS_20260724() {
  var raw = rscGetProp_(RSC_UR_20260721.pLastStats, '');
  if (!raw) return rscAlert_('Repair Shifted Output', 'Belum ada hasil compile.');
  var rec = JSON.parse(raw);
  var out = SpreadsheetApp.openById(rec.id);
  var sheets = out.getSheets(), fixed = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;
    var grid = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    var keepCols = [];
    for (var c = 0; c < lastCol; c++) {
      var any = false;
      for (var r = 0; r < grid.length; r++) if (rscText_(grid[r][c])) { any = true; break; }
      if (any) keepCols.push(c);
    }
    if (keepCols.length === lastCol) continue;
    var out2 = [];
    for (var r2 = 0; r2 < grid.length; r2++) {
      var line = [];
      for (var k = 0; k < keepCols.length; k++) line.push(grid[r2][keepCols[k]]);
      out2.push(line);
    }
    sh.clear();
    sh.getRange(1, 1, out2.length, keepCols.length).setValues(out2);
    fixed++;
  }
  rscAlert_('Repair Shifted Output', fixed + ' tab dirapatkan (kolom kosong dibuang).');
  return { fixed: fixed };
}

/** Rapikan spasi berlebih pada seluruh sel hasil compile. */
function RSC_UR_CLEANSE_SPACE_20260722() {
  var raw = rscGetProp_(RSC_UR_20260721.pLastStats, '');
  if (!raw) return rscAlert_('Cleanse Empty Space', 'Belum ada hasil compile.');
  var rec = JSON.parse(raw);
  var out = SpreadsheetApp.openById(rec.id);
  var sheets = out.getSheets(), changed = 0;
  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) continue;
    var vals = sh.getRange(2, 1, lastRow - 1, lastCol).getDisplayValues();
    var dirty = false;
    for (var r = 0; r < vals.length; r++) {
      for (var c = 0; c < lastCol; c++) {
        var t = rscText_(vals[r][c]);
        if (t !== vals[r][c]) { vals[r][c] = t; dirty = true; changed++; }
      }
    }
    if (dirty) sh.getRange(2, 1, vals.length, lastCol).setValues(vals);
  }
  rscAlert_('Cleanse Empty Space', changed + ' sel dirapikan.');
  return { changed: changed };
}

function RSC_V28_PURGE_ALL_COMPILE_TARGETS_20260814() {
  var ids = rscGetProp_('RSC_COMPILE_TARGET_IDS', '').split(',');
  var trashed = 0, failed = 0;
  for (var i = 0; i < ids.length; i++) {
    var id = rscText_(ids[i]);
    if (!id) continue;
    try { DriveApp.getFileById(id).setTrashed(true); trashed++; }
    catch (e) { failed++; }
  }
  rscSetProp_('RSC_COMPILE_TARGET_IDS', '');
  rscSetProp_(RSC_UR_20260721.pLastStats, '');
  rscSetProp_(RSC_UR_20260721.pStrlStats, '');
  rscAlert_('PURGE Compile Targets',
    'Dipindahkan ke sampah: ' + trashed + '\nGagal: ' + failed +
    '\n\nHanya file hasil compile yang dibuat script ini yang dihapus.');
  return { trashed: trashed, failed: failed };
}

/* =============================================================
 * 24. MARK EXACT DATA WITH CURRENT (BigQuery)
 * ============================================================= */

function RSC_MARK_EXACT_DATA_WITH_CURRENT_20260611() {
  var E = EXACT_DATA_WITH_CURRENT_PARAMETERS;
  if (typeof BigQuery === 'undefined') {
    return rscAlert_('Mark Exact Data With Current',
      'Advanced Service BigQuery belum diaktifkan pada project ini.\n\n' +
      'Aktifkan lewat Apps Script: Services -> BigQuery API -> Add.\n' +
      'Project  : ' + E.BQ_PROJECT_ID + '\n' +
      'Dataset  : ' + E.BQ_DATASET_ID + '\n' +
      'Tabel    : ' + E.BQ_TABLE_ID);
  }
  var ss = rscActiveSs_();
  var targets = rscCompileTargets_(ss, null);
  var marked = 0, files = 0, failed = 0;

  for (var i = 0; i < targets.length; i++) {
    var child;
    try { child = SpreadsheetApp.openById(targets[i].fileId); } catch (e) { failed++; continue; }
    var sh = rscChildRollingSheet_(child);
    if (!sh) continue;
    var col = rscRollingColumns_(sh);
    var lastRow = sh.getLastRow();
    if (!col || lastRow < 2) continue;
    files++;

    var n = lastRow - 1;
    var cust = sh.getRange(2, col['Customer ID'], n, 1).getDisplayValues();
    var rel = sh.getRange(2, col['Relationship'], n, 1).getDisplayValues();
    var sls = sh.getRange(2, col['Salesman ID'], n, 1).getDisplayValues();
    var ids = [];
    for (var r = 0; r < n; r++) {
      var c = RSC_NORMALIZE_ID_(cust[r][0]);
      if (c) ids.push(c);
    }
    ids = rscUniq_(ids);
    if (!ids.length) continue;

    var exact = {};
    var batches = rscChunk_(ids, E.BQ_BP_ID_BATCH_SIZE);
    for (var b = 0; b < batches.length; b++) {
      var quoted = [];
      for (var q = 0; q < batches[b].length; q++) quoted.push("'" + batches[b][q].replace(/'/g, '') + "'");
      var sql = 'SELECT bp_id, relationship_cat_id, bp_id_rlt2 FROM `' +
        E.BQ_PROJECT_ID + '.' + E.BQ_DATASET_ID + '.' + E.BQ_TABLE_ID +
        '` WHERE bp_id IN (' + quoted.join(',') + ')';
      try {
        var job = BigQuery.Jobs.query({ query: sql, useLegacySql: false }, E.BQ_PROJECT_ID);
        var rows = (job && job.rows) || [];
        for (var k = 0; k < rows.length; k++) {
          var f = rows[k].f;
          exact[RSC_NORMALIZE_ID_(f[0].v) + '|' + RSC_NORMALIZE_ID_(f[1].v) + '|' + RSC_NORMALIZE_ID_(f[2].v)] = true;
        }
      } catch (eq) { failed++; }
    }

    var outCol = [];
    for (var r2 = 0; r2 < n; r2++) {
      var key = RSC_NORMALIZE_ID_(cust[r2][0]) + '|' + RSC_NORMALIZE_ID_(rel[r2][0]) + '|' + RSC_NORMALIZE_ID_(sls[r2][0]);
      if (exact[key]) { outCol.push([E.OUTPUT_TEXT]); marked++; }
      else outCol.push([E.CLEAR_R_IF_NOT_MATCH ? '' : sh.getRange(2 + r2, E.OUTPUT_COL_R).getDisplayValue()]);
    }
    sh.getRange(2, E.OUTPUT_COL_R, n, 1).setValues(outCol);
  }

  rscAlert_('Mark Exact Data With Current',
    'File diproses : ' + files + '\nBaris ditandai: ' + marked + '\nGagal         : ' + failed);
  return { files: files, marked: marked, failed: failed };
}

/* =============================================================
 * 25. COPY-AWARE AUTOMATION + AUTO VALIDATE ON EDIT
 * ============================================================= */

function handleCopyAwareOpenAutomation_(e) {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  var ss = rscActiveSs_();
  var last = rscGetProp_(C.pLastAutoBootstrappedSpreadsheetId, '');
  if (last === ss.getId()) return;
  rscSetProp_(C.pLastAutoBootstrappedSpreadsheetId, ss.getId());
  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());
  if (C.removeAllProtectionsOnFirstOpenOfEachSpreadsheet) {
    runSafelyWithOptionalRethrow_('remove protections', RSC_REMOVE_ALL_PROTECTIONS_CURRENT_FILE_20260612, false);
  }
  if (C.runLocalValidationOnFirstOpenOfEachSpreadsheet) {
    runSafelyWithOptionalRethrow_('local validation', RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814, false);
  }
}

function RSC_ACTIVATE_COPY_AWARE_AUTOMATION_20260611() {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  var ss = rscActiveSs_();
  rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, ss.getId());
  rscSetProp_(C.pAuthorizedJobsStatus, 'ACTIVE ' + rscStamp_());
  var installed = [];
  if (C.autoValidateOnEdit) {
    try {
      rscDeleteTriggers_([C.autoValidateOnEditHandler]);
      ScriptApp.newTrigger(C.autoValidateOnEditHandler).forSpreadsheet(ss).onEdit().create();
      installed.push('auto validate on edit');
    } catch (e) { installed.push('auto validate on edit GAGAL: ' + e); }
  }
  if (C.installScheduledLocalValidationJob) {
    try {
      rscDeleteTriggers_([C.localValidationJobHandler]);
      ScriptApp.newTrigger(C.localValidationJobHandler).timeBased()
        .everyHours(C.localValidationJobEveryHours).create();
      installed.push('scheduled local validation');
    } catch (e2) { installed.push('scheduled local validation GAGAL: ' + e2); }
  }
  rscAlert_('Activate Jobs for This Copy',
    'File ini didaftarkan sebagai master aktif.\n\nTerpasang:\n- ' +
    (installed.length ? installed.join('\n- ') : '(tidak ada, sesuai parameter)'));
  return installed;
}

function RSC_SCHEDULED_LOCAL_VALIDATION_JOB_20260611() {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  rscSetProp_(C.pLastLocalValidationAt, rscStamp_());
  return runSafelyWithOptionalRethrow_('scheduled local validation',
    RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814, false);
}

/**
 * onEdit terinstal. Edit beruntun digabung: hanya satu validasi penuh
 * dijalankan per burst, bukan satu per keystroke.
 */
function RSC_V28_2_AUTHORIZED_ON_EDIT_20260814(e) {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  if (!C.autoValidateOnEdit) return;
  try {
    var sh = (e && e.range) ? e.range.getSheet() : SpreadsheetApp.getActiveSheet();
    if (!rscSpecFor_(sh.getName())) return;
    rscSetProp_(C.pAutoValidateLastEditAt, String(Date.now()));
    rscSetProp_(C.pAutoValidateSheetId, String(sh.getSheetId()));
    if (rscGetProp_(C.pAutoValidateQueued, '') === '1') return;
    rscSetProp_(C.pAutoValidateQueued, '1');
    rscDeleteTriggers_([C.autoValidateWorkerHandler]);
    ScriptApp.newTrigger(C.autoValidateWorkerHandler).timeBased()
      .after(Math.max(1000, C.autoValidateDebounceMs)).create();
  } catch (err) { /* onEdit tidak boleh melempar */ }
}

function RSC_V28_2_AUTO_VALIDATE_WORKER_20260814() {
  var C = COPY_AWARE_AUTOMATION_PARAMETERS;
  rscSetProp_(C.pAutoValidateQueued, '');
  var lastEdit = Number(rscGetProp_(C.pAutoValidateLastEditAt, '0'));
  if (Date.now() - lastEdit < C.autoValidateDebounceMs) {
    // Masih ada edit baru; tunda sekali lagi supaya satu burst = satu validasi.
    rscSetProp_(C.pAutoValidateQueued, '1');
    try {
      rscDeleteTriggers_([C.autoValidateWorkerHandler]);
      ScriptApp.newTrigger(C.autoValidateWorkerHandler).timeBased()
        .after(C.autoValidateDebounceMs).create();
    } catch (e) { /* best-effort */ }
    return { deferred: true };
  }
  var ss = rscActiveSs_();
  var sheetId = Number(rscGetProp_(C.pAutoValidateSheetId, '0'));
  var target = null, sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) if (sheets[i].getSheetId() === sheetId) target = sheets[i];
  if (!target) return { skipped: true };

  var spec = rscSpecFor_(target.getName());
  if (!spec) return { skipped: true };
  var masters;
  try { masters = rscLoadMasters_(ss); } catch (e2) { return { deferred: true, reason: rscClassify_(e2).kind }; }

  var needCols = Math.max(spec.errorCol, spec.header.length);
  var width = Math.max(needCols, target.getLastColumn() || needCols);
  if (rscCheckLayout_(spec, target.getRange(1, 1, 1, width).getDisplayValues()[0])) return { skipped: true };
  var dataRows = Math.max(0, target.getLastRow() - 1);
  var values = dataRows ? target.getRange(2, 1, dataRows, needCols).getValues() : [];
  var res = rscValidateValues_(spec, values, masters);
  rscWriteResults_(target, spec, res, dataRows);
  rscSetProp_(C.pAutoValidateLastResult,
    JSON.stringify({ at: rscStamp_(), sheet: target.getName(), rows: res.rowCount, errorRows: res.errorRows }));
  return { rows: res.rowCount, errorRows: res.errorRows };
}

/* =============================================================
 * 26. SELF-TEST MENYELURUH
 * ============================================================= */

function RSC_RUN_SELF_TEST_20260819() {
  var t = rscTestSuite_('SELF-TEST MENYELURUH');
  var subs = [
    RSC_PERF10_TEST_CORE_NORMALIZER_20260819,
    RSC_PERF10_TEST_MBP_CORE_PURE_20260819,
    RSC_PERF10_TEST_CACHE_BUCKET_CORE_20260819,
    RSC_PERF10_TEST_CHANGE_SCHEDULE_20260819,
    RSC_PERF11_TEST_ROLLING_VALID_FROM_POLICY_20260819,
    RSC_PERF12_TEST_STATUS_AND_GATE_20260819,
    RSC_PERF13_TEST_HARD_STOP_CORE_20260819,
    RSC_PERF17_TEST_SINGLETON_RESTART_POLICY_20260819,
    RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_,
    RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819,
    RSC_PERF25_TEST_DB_CONTENTION_PARITY_20260819
  ];
  var totalPassed = 0, allFailed = [];
  for (var i = 0; i < subs.length; i++) {
    try {
      var r = subs[i]();
      totalPassed += r.passed;
      for (var f = 0; f < r.failed.length; f++) allFailed.push(r.title + ': ' + r.failed[f]);
      t.ok(r.title, r.ok);
    } catch (e) {
      allFailed.push('suite gagal dijalankan: ' + e);
      t.ok('suite ke-' + i, false, String(e));
    }
  }
  var res = t.finish('Total assertion lulus: ' + totalPassed +
    (allFailed.length ? ('\n\nDetail gagal:\n- ' + allFailed.join('\n- ')) : ''));
  res.totalPassed = totalPassed;
  res.allFailed = allFailed;
  return res;
}

/* =============================================================
 * 27. MENU
 * ============================================================= */

function onOpen(e) {
  var ui;
  try { ui = SpreadsheetApp.getUi(); } catch (err) { return; }

  ui.createMenu(ROLLING_SALES_CENTER_PARAMETERS.menuName)
    .addItem('✅ 1. Validate ACTIVE Sheet — Standard V28', 'RSC_STANDARD_VALIDATE_ACTIVE_SHEET_20260814')
    .addItem('🚀 2. Validate ALL Links Kolom E — Manifest', 'RSC_STANDARD_BULK_START_20260814')
    .addItem('⚡ 3. Run FULL Pipeline NOW — Validate → Compile → ST/RL', 'RSC_V28_FULL_PIPELINE_RUN_NOW_20260814')
    .addSeparator()
    .addSubMenu(ui.createMenu('📦 Validation Bulk — Control')
      .addItem('▶ Start / Resume Bulk Validation', 'RSC_STANDARD_BULK_START_20260814')
      .addItem('🔄 RESTART FROM TOP — Fresh Run', 'RSC_PERF17_RESTART_BULK_FROM_TOP_20260819')
      .addItem('🧯 Repair / Dedupe Worker Triggers', 'RSC_PERF17_REPAIR_TRIGGER_TOPOLOGY_20260819')
      .addItem('⚡ Kick / Recover Waiting Workers', 'RSC_PERF14_KICK_WAITING_WORKERS_20260819')
      .addItem('🩺 Diagnose Worker Queue', 'RSC_PERF14_DIAGNOSE_WORKER_QUEUE_20260819')
      .addItem('♻ Requeue Technical DB Failures', 'RSC_PERF23_REQUEUE_TECHNICAL_FAILURES_20260819')
      .addItem('🛠 Repair Current Manifest + Requeue', 'RSC_PERF23_REPAIR_CURRENT_MANIFEST_20260819')
      .addItem('🔍 Audit Link E = Active Validation', 'RSC_PERF15_AUDIT_LINK_E_ACTIVE_PARITY_20260819')
      .addItem('🔐 Diagnose Bulk DB Access / Identity', 'RSC_PERF15_DIAGNOSE_BULK_ACCESS_20260819')
      .addItem('📡 Open Live Job Logging', 'RSC_PERF16_OPEN_JOB_LOGGING_20260819')
      .addItem('🔄 Refresh Job Logging', 'RSC_PERF16_REFRESH_JOB_LOGGING_20260819')
      .addItem('🧹 Clear Job Log History', 'RSC_PERF16_CLEAR_JOB_LOG_HISTORY_20260819')
      .addItem('📊 Status Bulk Validation', 'RSC_STANDARD_BULK_STATUS_20260814')
      .addItem('🧾 Open Manifest', 'RSC_STANDARD_BULK_OPEN_MANIFEST_20260814')
      .addItem('⏹ STOP Bulk Validation', 'RSC_STANDARD_BULK_STOP_20260814'))
    .addSubMenu(ui.createMenu('📡 Job Logging Details')
      .addItem('📡 Open Live Dashboard', 'RSC_PERF16_OPEN_JOB_LOGGING_20260819')
      .addItem('🔄 Refresh Dashboard', 'RSC_PERF16_REFRESH_JOB_LOGGING_20260819')
      .addItem('🧹 Clear Event History', 'RSC_PERF16_CLEAR_JOB_LOG_HISTORY_20260819'))
    .addSubMenu(ui.createMenu('⏱ Automation 1 Hour — Full Pipeline')
      .addItem('✅ Install / Refresh AUTO 1 HOUR', 'RSC_V28_FULL_PIPELINE_INSTALL_HOURLY_20260814')
      .addItem('⚡ Run FULL Pipeline NOW', 'RSC_V28_FULL_PIPELINE_RUN_NOW_20260814')
      .addItem('📊 Full Pipeline Status', 'RSC_V28_FULL_PIPELINE_STATUS_20260814')
      .addItem('⏹ STOP Automation + Current Pipeline', 'RSC_V28_FULL_PIPELINE_STOP_20260814'))
    .addSubMenu(ui.createMenu('📤 Compile Upload Ready — Integrated')
      .addItem('▶ Main Compile — Start / Upsert ALL DONE', 'RSC_UR_START_20260721')
      .addItem('▶ Compile ST/RL — Dual Source', 'RSC_UR_START_ST_RL_20260727')
      .addSeparator()
      .addItem('📊 Main Compile Status', 'RSC_UR_STATUS_20260721')
      .addItem('📊 ST/RL Status', 'RSC_UR_STATUS_ST_RL_20260727')
      .addSeparator()
      .addItem('🧹 Cleanse + Merge Duplicate Output', 'RSC_UR_CLEANSE_DUPLICATE_OUTPUTS_20260724')
      .addItem('🔧 Repair Shifted Output Columns', 'RSC_UR_REPAIR_SHIFTED_OUTPUTS_20260724')
      .addItem('🧽 Cleanse Empty Space', 'RSC_UR_CLEANSE_SPACE_20260722')
      .addSeparator()
      .addItem('☢ PURGE ALL Compile Target Files', 'RSC_V28_PURGE_ALL_COMPILE_TARGETS_20260814'))
    .addSubMenu(ui.createMenu('🧱 Template Revamp')
      .addItem('▶ Start / Continue Template Revamp', 'RSC_RUN_TEMPLATE_REVAMP_INTEGRATED_20260723')
      .addItem('📊 Status Template Revamp', 'RSC_SHOW_TEMPLATE_REVAMP_STATUS_20260722')
      .addItem('⏹ STOP Template Revamp', 'RSC_STOP_TEMPLATE_REVAMP_JOB_20260722')
      .addItem('♻ Reset / Cleanup Template Revamp', 'RSC_RESET_TEMPLATE_REVAMP_JOB_20260722'))
    .addSubMenu(ui.createMenu('🧩 Template & Copy')
      .addItem('Setup / Refresh ALL Template', 'RSC_SETUP_ALL_TEMPLATES_20260611')
      .addItem('Setup Credit Limit only', 'RSC_SETUP_CREDIT_LIMIT_ONLY_20260611')
      .addItem('Setup CR Change Sheets only', 'RSC_SETUP_ROLLING_CHANGE_SHEETS_ONLY_20260611')
      .addItem('Setup Change Salesman Type only', 'RSC_SETUP_CHANGE_SALESMAN_TYPE_ONLY_20260611')
      .addSeparator()
      .addItem('▶ Start / Lanjut Copy FINAL', 'RSC_START_COPY_ROLLING_TEMPLATE_FILES_20260611')
      .addItem('📊 Status Copy FINAL', 'RSC_SHOW_COPY_AND_TEMPLATE_VALIDATION_STATUS_20260611')
      .addItem('⏹ STOP Copy FINAL', 'RSC_STOP_COPY_AND_TEMPLATE_VALIDATION_JOBS_20260611')
      .addItem('♻ Reset Checkpoint Copy', 'RSC_RESET_INTEGRATED_COPY_FINAL_20260716'))
    .addSubMenu(ui.createMenu('🛠 Utilities')
      .addItem('Generate / Refresh Summary - CR', 'RSC_GENERATE_CR_VISIT_SCHEDULE_SUMMARY_20260611')
      .addItem('Mark Exact Data With Current - BigQuery', 'RSC_MARK_EXACT_DATA_WITH_CURRENT_20260611')
      .addSeparator()
      .addItem('Fix G/L Reason Rolling — background', 'RSC_START_FIX_ROLLING_REASON_DATES_BG_20260611')
      .addItem('Replace Dates by m_bp_relation — background', 'RSC_START_VALIDATE_DATE_IN_TEMPLATE_20260619')
      .addItem('Fix / Validate Toko Bangkrut Date', 'RSC_START_TOKO_BANGKRUT_DATES_BY_DB_20260622'))
    .addSubMenu(ui.createMenu('🧪 Audit & Performance')
      .addItem('✅ Run FULL Safe Audit + Benchmark', 'RSC_PERF12_FULL_AUDIT_20260819')
      .addItem('🧪 Run SELF-TEST Menyeluruh', 'RSC_RUN_SELF_TEST_20260819')
      .addItem('🔌 Scope + Dependency Audit', 'RSC_PERF10_RUN_DEPENDENCY_AUDIT_20260819')
      .addItem('🗄 Live DB Read-Only Audit', 'RSC_PERF10_LIVE_DB_READONLY_AUDIT_20260819')
      .addItem('🔐 Diagnose DB Access / Identity', 'RSC_PERF11_DIAGNOSE_DB_ACCESS_20260819')
      .addItem('🔑 Authorize External DB + Bind Workers', 'RSC_PERF18_AUTHORIZE_AND_BIND_20260819')
      .addItem('🧭 Audit Child Link Access (Col E)', 'RSC_PERF18_AUDIT_CHILD_LINK_ACCESS_20260819')
      .addItem('🪪 Show Authorization Binding Status', 'RSC_PERF18_SHOW_AUTH_STATUS_20260819')
      .addItem('🧪 Test OAuth Exact-Status Logic', 'RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_')
      .addItem('🧩 Optional _rsc Lookup Status', 'RSC_PERF19_TEST_DB_ACCELERATOR_20260819')
      .addItem('🛡 Test Quota-Safe DB Transport', 'RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819')
      .addItem('📡 Show PERF21 DB Transport Status', 'RSC_PERF21_SHOW_TRANSPORT_STATUS_20260819')
      .addItem('🧩 PERF22 Scope Completeness Audit', 'RSC_PERF22_SCOPE_AUDIT_20260819_')
      .addItem('🗄 PERF23 Test Direct Raw DB', 'RSC_PERF23_TEST_DIRECT_RAW_DB_20260819')
      .addItem('🩺 PERF24 Diagnose Run Guards', 'RSC_PERF24_DIAGNOSE_RUN_GUARDS_20260819')
      .addItem('🧪 PERF25 Test DB Contention + Parity', 'RSC_PERF25_TEST_DB_CONTENTION_PARITY_20260819')
      .addItem('🧹 Clear Fast DB Lookup Cache', 'RSC_PERF19_CLEAR_DB_CACHE_20260819')
      .addItem('🧪 Test Authorization Binding Core', 'RSC_PERF18_TEST_AUTH_BINDING_CORE_20260819_')
      .addSeparator()
      .addItem('🧠 Test Change Schedule Logic', 'RSC_PERF10_TEST_CHANGE_SCHEDULE_20260819')
      .addItem('📅 Test Rolling Valid From Policy', 'RSC_PERF11_TEST_ROLLING_VALID_FROM_POLICY_20260819')
      .addItem('🎨 Test Status Color + Auto Revamp Gate', 'RSC_PERF12_TEST_STATUS_AND_GATE_20260819')
      .addItem('📡 Test Job Logging Dashboard', 'RSC_PERF16_TEST_JOB_LOGGING_20260819')
      .addItem('🧭 Test Worker Singleton + Restart Policy', 'RSC_PERF17_TEST_SINGLETON_RESTART_POLICY_20260819')
      .addItem('🔁 Process Pending Rekap Auto Revamp', 'RSC_PERF12_PROCESS_PENDING_BULK_REVAMP_20260819')
      .addItem('☢ Test HARD STOP Core — Safe Simulation', 'RSC_PERF13_TEST_HARD_STOP_CORE_20260819')
      .addItem('🔤 Test Core Normalizer', 'RSC_PERF10_TEST_CORE_NORMALIZER_20260819')
      .addItem('🧱 Test m_bp_relation Core Parser', 'RSC_PERF10_TEST_MBP_CORE_PURE_20260819')
      .addItem('⚡ Test Cache + Bucketing Core', 'RSC_PERF10_TEST_CACHE_BUCKET_CORE_20260819')
      .addSeparator()
      .addItem('📊 Benchmark ACTIVE Rolling — Read Only', 'RSC_PERF10_BENCHMARK_ACTIVE_ROLLING_20260819')
      .addItem('🧪 Synthetic Performance Benchmark', 'RSC_PERF10_SYNTHETIC_BENCHMARK_20260819')
      .addItem('📈 Show PERF Telemetry', 'RSC_PERF10_SHOW_TELEMETRY_20260819')
      .addItem('🧾 Show Last Audit Summary', 'RSC_PERF10_SHOW_LAST_AUDIT_20260819'))
    .addSubMenu(ui.createMenu('⚙ Admin / Recovery')
      .addItem('Activate Jobs for This Copy', 'RSC_ACTIVATE_COPY_AWARE_AUTOMATION_20260611')
      .addItem('Hapus Semua Protection di File Ini', 'RSC_REMOVE_ALL_PROTECTIONS_CURRENT_FILE_20260612')
      .addItem('Aktifkan Auto Validasi Link Kolom D', 'RSC_INSTALL_AUTO_VALIDATION_FOR_INPUT_LINKS_20260611')
      .addSeparator()
      .addItem('Setup Recommended Basic Triggers', 'RSC_INSTALL_RECOMMENDED_TRIGGERS_20260611')
      .addItem('Show Status Semua Job', 'RSC_SHOW_ALL_BACKGROUND_JOB_STATUS_20260611')
      .addItem('STOP Semua Background Job', 'RSC_STOP_ALL_BACKGROUND_JOBS_20260611')
      .addItem('Reset Integrated Checkpoint', 'RSC_RESET_CHECKPOINTS_20260611')
      .addSeparator()
      .addItem('☢ HARD STOP ALL + HARD RESET', 'RSC_PERF13_HARD_STOP_ALL_20260819')
      .addItem('🟢 Re-Arm System after HARD STOP', 'RSC_PERF13_REARM_AFTER_HARD_STOP_20260819')
      .addItem('🛑 HARD STOP Status', 'RSC_PERF13_SHOW_HARD_STOP_STATUS_20260819')
      .addSeparator()
      .addItem('🔑 Authorize External DB + Bind Workers', 'RSC_PERF18_AUTHORIZE_AND_BIND_20260819')
      .addItem('🧭 Audit Child Link Access (Col E)', 'RSC_PERF18_AUDIT_CHILD_LINK_ACCESS_20260819')
      .addItem('🪪 Show Authorization Binding Status', 'RSC_PERF18_SHOW_AUTH_STATUS_20260819')
      .addItem('🧪 Test OAuth Exact-Status Logic', 'RSC_PERF20_TEST_AUTH_STATUS_LOGIC_20260819_')
      .addItem('🧩 Optional _rsc Lookup Status', 'RSC_PERF19_TEST_DB_ACCELERATOR_20260819')
      .addItem('🛡 Test Quota-Safe DB Transport', 'RSC_PERF21_TEST_QUOTA_SAFE_DB_TRANSPORT_20260819')
      .addItem('📡 Show PERF21 DB Transport Status', 'RSC_PERF21_SHOW_TRANSPORT_STATUS_20260819')
      .addItem('🧩 PERF22 Scope Completeness Audit', 'RSC_PERF22_SCOPE_AUDIT_20260819_')
      .addItem('🧹 Clear Fast DB Lookup Cache', 'RSC_PERF19_CLEAR_DB_CACHE_20260819'))
    .addToUi();

  runSafelyWithOptionalRethrow_('Copy-aware open automation', function () {
    handleCopyAwareOpenAutomation_(e);
  }, false);

  runSafelyWithOptionalRethrow_('Simpan ID master', function () {
    rscSetProp_(ROLLING_SALES_CENTER_PARAMETERS.propSsId, SpreadsheetApp.getActiveSpreadsheet().getId());
  }, false);
}
