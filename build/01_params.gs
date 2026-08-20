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
    VISIT:     ['m_visit_schedule'],
    RELTYPE:   ['m_rel_salesman_type_rlt']
  },

  // Master Relationship (opsional). Bila tabel tidak ada, daftar canonical
  // ZWS001..ZWS022 + BUR001 di RELATIONSHIP_OPTIONS yang dipakai.
  relTypeHeaders: {
    id: ['rlt_id', 'relationship_cat_id', 'rel_id'],
    desc: ['rlt_desc', 'description', 'desc']
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
  // CATATAN: filter ini TIDAK berlaku untuk deteksi pasangan Customer+Salesman
  // (Change Schedule Only CASE 2) — pasangan tetap dianggap ada walau relasinya
  // sudah lama ditutup, persis seperti versi lama yang membaca tabel mentah.
  activeGraceDays: 60,

  // Batas record m_bp_relation yang disimpan per Customer. Versi lama membaca
  // tabel mentah tanpa batas; 24 terlalu kecil untuk customer dengan banyak
  // relationship + histori, dan menyebabkan CASE 1 / CASE 2 tidak terdeteksi.
  relationMaxPerCustomer: 200,

  // Batas pasangan Customer+Salesman tambahan (dari baris yang tidak masuk map
  // karena kedaluwarsa atau melewati cap). Bila terlampaui, ditandai agar
  // dilaporkan, bukan didiamkan.
  relationPairExtraMax: 300000,

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

/* -------------------------------------------------------------
 * KODE WARNA STATUS (dipakai O:P, manifest, dashboard, rekap)
 * -------------------------------------------------------------
 *   OK / ALL OK / COMPLETE OK / DONE   -> HIJAU
 *   ERROR / HARD ERROR / GAGAL         -> MERAH
 *   IN PROGRESS / WORKER / ACTIVE      -> KUNING
 *   QUEUE / QUEUED / ANTREAN           -> ORANGE
 *   RETRY / DEFERRED / TERTUNDA        -> KUNING TUA
 *   BLOCKED / INFRA                    -> BIRU
 *   SKIPPED / STOPPED / DILEWATI       -> ABU
 * ----------------------------------------------------------- */
var RSC_UI_STATUS_COLORS_20260820 = {
  GREEN:  { bg: '#B7E1CD', font: '#0B5D2E', bold: true },
  RED:    { bg: '#F4C7C3', font: '#8B1A10', bold: true },
  YELLOW: { bg: '#FFF2A8', font: '#7A5B00', bold: true },
  ORANGE: { bg: '#FCD9A6', font: '#8A4B08', bold: true },
  AMBER:  { bg: '#FFE0B2', font: '#8A4B08', bold: false },
  BLUE:   { bg: '#D6E4F7', font: '#1E3A8A', bold: false },
  GREY:   { bg: '#E5E7EB', font: '#4B5563', bold: false },
  NONE:   { bg: null, font: null, bold: false }
};

/**
 * Peta status -> warna. Kunci dicocokkan setelah rscKey_() sehingga
 * "COMPLETE OK", "COMPLETE_OK", dan "complete-ok" bernilai sama.
 */
var RSC_UI_STATUS_MAP_20260820 = {
  OK: 'GREEN', ALLOK: 'GREEN', COMPLETEOK: 'GREEN', DONE: 'GREEN', SELESAI: 'GREEN',
  VALIDASIOK: 'GREEN', SUKSES: 'GREEN', PASS: 'GREEN', LULUS: 'GREEN', GREEN: 'GREEN',

  ERROR: 'RED', HARDERROR: 'RED', COMPLETEWITHERRORS: 'RED', GAGAL: 'RED', FAILED: 'RED',
  PERLUREVISI: 'RED', FATAL: 'RED', RED: 'RED',

  ACTIVE: 'YELLOW', RUNNING: 'YELLOW', INPROGRESS: 'YELLOW', WORKER: 'YELLOW',
  WORKING: 'YELLOW', VALIDATING: 'YELLOW', PROSES: 'YELLOW', BERJALAN: 'YELLOW',
  CLAIMED: 'YELLOW', PREWARM: 'YELLOW', YELLOW: 'YELLOW',

  QUEUED: 'ORANGE', QUEUE: 'ORANGE', ANTREAN: 'ORANGE', PENDING: 'ORANGE',
  WAITING: 'ORANGE', MENUNGGU: 'ORANGE', ORANGE: 'ORANGE',

  RETRY: 'AMBER', DEFERRED: 'AMBER', TERTUNDA: 'AMBER', DEFER: 'AMBER',

  BLOCKEDINFRA: 'BLUE', BLOCKED: 'BLUE', INFRA: 'BLUE', PAUSED: 'BLUE',

  SKIPPED: 'GREY', SKIPPEDINVALID: 'GREY', DILEWATI: 'GREY', STOPPED: 'GREY',
  STOP: 'GREY', IDLE: 'GREY', HARDSTOP: 'GREY', CANCELLED: 'GREY'
};

/** Kata kunci yang dicari bila status berupa kalimat panjang (kolom Feedback). */
var RSC_UI_STATUS_KEYWORDS_20260820 = [
  ['VALIDASIOK', 'GREEN'], ['ALLOK', 'GREEN'], ['COMPLETEOK', 'GREEN'],
  ['PERLUREVISI', 'RED'], ['HARDERROR', 'RED'], ['GAGAL', 'RED'], ['ERROR', 'RED'],
  ['TERTUNDA', 'AMBER'], ['DEFER', 'AMBER'], ['RETRY', 'AMBER'],
  ['DILEWATI', 'GREY'], ['SKIPPED', 'GREY'], ['STOPPED', 'GREY'],
  ['BLOCKED', 'BLUE'],
  ['INPROGRESS', 'YELLOW'], ['ACTIVE', 'YELLOW'], ['RUNNING', 'YELLOW'], ['VALIDATING', 'YELLOW'],
  ['QUEUED', 'ORANGE'], ['ANTREAN', 'ORANGE'],
  ['OK', 'GREEN']
];

var VISIT_CATEGORY_OPTIONS = ['F1', 'F2', 'F4', 'F8'];
var VISIT_CATEGORY_FREQUENCY = { F1: 1, F2: 2, F4: 4, F8: 8 };
var VISIT_TYPE_OPTIONS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
var VISIT_DAYS = ['M', 'T', 'W', 'TH', 'F', 'S', 'SU'];
var REASON_OPTIONS = ['Rolling', 'Toko Bangkrut'];
var OPEN_ENDED_DATE_TEXT = '9999-12-31';

/* LOV Sales Type (New code S4) — dipakai sheet Change Salesman Type. */
var SALES_TYPE_OPTIONS = [
  '11 - CORPORATE FOOD',
  '12 - CORPORATE NON FOOD',
  '13 - CORPORATE ALL',
  '14 - CORPORATE RETAIL',
  '15 - CORPORATE RUMAH MAKAN',
  '16 - RETAIL S',
  '17 - KEY ACCOUNT FOOD',
  '18 - KEY ACCOUNT NON FOOD',
  '19 - KEY ACCOUNT',
  '20 - KEY ACCOUNT FOOD TOP',
  '21 - KEY ACCOUNT NON FOOD TOP',
  '22 - KEY ACCOUNT TOP',
  '23 - SALESMAN KOSMETIK',
  '24 - HOREKA BR',
  '25 - HOREKA NON BR',
  '26 - HOREKA MIX',
  '27 - SALESMAN HOREKA',
  '28 - MOTORIS FOOD',
  '29 - MOTORIS NON FOOD',
  '30 - MOTORIS MIX',
  '31 - MOTORIS GROSIR',
  '32 - MOTORIS GROSIR WARUNG SEDUH MIE',
  '33 - MOTORIS GROSIR WARUNG SEDUH KOPI',
  '34 - MOTORIS WARUNG SEDUH KOPI',
  '35 - MOTORIS WARUNG SEDUH MIE',
  '36 - CANVAS MOBIL GROSIR',
  '37 - CANVAS MOBIL FOOD',
  '38 - CANVAS MOBIL NON FOOD',
  '39 - CANVAS MOBIL MIX',
  '40 - SALESMAN FROZEN F2',
  '41 - SALESMAN FROZEN F4',
  '42 - SALESMAN FROZEN F4 HYPER / SUPER',
  '43 - SALESMAN FROZEN F4 SHARING SHOWCASE',
  '44 - SALESMAN MTI',
  '45 - SALESMAN MTKA (AO)',
  '46 - SALESMAN MT MIX',
  '47 - INSTITUSI SALESMAN',
  '48 - SALESMAN EXPORT',
  '49 - SALESMAN RETAIL ONLINE',
  '50 - SALESMAN CERAMIC ROOF',
  '51 - SALESMAN GYPSUM',
  '52 - SALESMAN FIBER CEMENT',
  '53 - SALESMAN MIX BUILDING MATERIAL',
  '54 - MD DISPLAY',
  '55 - MD FROZEN',
  '56 - MD BRANDING',
  '57 - MDMM',
  '58 - TEAM SAMPLING',
  '59 - COMBER',
  '60 - ACCOUNT DEVELOPMENT OFFICER',
  '61 - RO',
  '62 - SPG (WS)',
  '63 - COLLECTOR IRE',
  '64 - COLLECTOR',
  '65 - MNI MARKET TOP',
  '66 - MOTORIST R3',
  '67 - CORPORATE RETAIL EXPAND',
  'A1 - KAE MTKA',
  'A2 - KAE E-COMM',
  'A3 - KAO MTKA',
  'A4 - RAS MTI',
  'A5 - RAS MIX',
  'A6 - RAS MTKA',
  'A7 - KAM MTKA',
  'A8 - KAM FROZEN',
  'A9 - KAM ECOMM',
  'B1 - SPV MIX',
  'B2 - SPV RETAIL',
  'B3 - SPV NON FOOD',
  'B4 - SPV FOOD',
  'B5 - SPV RETAIL SMALL',
  'B6 - SPV MOTORIS',
  'B7 - SPV KOSMETIK',
  'B8 - AS HOREKA',
  'B9 - AE HOREKA',
  'C1 - SPV HOREKA ALL',
  'C2 - SPV FROZEN',
  'C3 - SPV CERAMIC ROOF',
  'C4 - SPV GYPSUM',
  'C5 - SPV FIBER CEMENT',
  'C6 - SPV MIX BUILDING MATERIAL',
  'C7 - INSTITUSI AS',
  'C8 - INSTITUSI AE',
  'C9 - KSR/TL',
  'D1 - KOORDINATOR COMBER',
  'D2 - KPL',
  'D3 - KMD',
  'D4 - SPV RO',
  'N1 - ASM FOOD',
  'N2 - ASM NON FOOD',
  'N3 - ASM MIX',
  'N4 - ASM RETAIL SMALL',
  'N5 - ASM MOTORIS',
  'N6 - ASM KOSMETIK',
  'N7 - AM HOREKA',
  'N8 - ASM FROZEN',
  'N9 - RKAM MTI',
  'O1 - SENIOR KAM',
  'O2 - RSM',
  'O3 - ARSM',
  'O4 - RSM FROZEN',
  'O5 - GKAM',
  'O6 - SM FOOD',
  'O7 - SM NON FOOD',
  'O8 - SM MIX',
  'O9 - ASM (WS)',
  'P1 - SM KOSMETIK',
  'P2 - ASM KOSMETIK (WS)',
  'P3 - SM FROZEN',
  'P4 - ASM FROZEN (WS)',
  'P5 - RKAM MTKA',
  'P6 - GKAM MTKA'
];

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
