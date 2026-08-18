/**
 * ウェルカムマッチ 応援アプリ - バックエンド（Google Apps Script）
 *
 * スプレッドシートに紐づけて「ウェブアプリ」としてデプロイすると、
 * アプリの入力がすべてこのシートに集約されます。
 *
 * 使い方は README.md を参照してください。
 * デプロイ設定は必ず「次のユーザーとして実行：自分」「アクセスできるユーザー：全員」にします。
 */

/**
 * 【設定の書き換えを守る合言葉】
 *
 * ウェブアプリの URL は来場者全員に配られるため、そのままだと
 * 「設定（試合情報・グッズ・価格など）」を誰でも書き換えられてしまいます。
 * 設定は全員の画面に反映されるので、ここだけは守っておくのが安全です。
 *
 * 下の '' の中に好きな言葉を入れてください（例: 'lax2026kyoritsu'）。
 * 入れたら、アプリのスタッフ → 設定 →「設定用の合言葉」に同じものを入力します。
 *
 * 空のままでも動きますが、その場合は誰でも設定を書き換えられる状態になります。
 * 集計やチェックインの記録には影響しません。
 */
var ADMIN_KEY = '';

var SHEET_ENTRIES = 'entries';
var SHEET_CHECKINS = 'checkins';
var SHEET_CONFIG = 'config';

var ENTRY_HEADER = [
  'id', 'ts', 'name', 'relation', 'kind', 'headcount',
  'goodsQty', 'goodsAmount', 'delivery', 'shipping', 'total',
  'message', 'device', 'goodsJson', 'email'
];

/**
 * メールアドレスは、このウェブアプリからは絶対に外に出しません。
 * ウェブアプリの URL は来場者全員に配られるため、URL を知った人なら誰でも
 * 読み取りを試せます。そのため email 列はシート上にのみ保存し、
 * doGet の応答からは必ず取り除いています（PRIVATE_FIELDS）。
 * 配送のご案内は、スプレッドシートの entries シートを直接開いて行ってください。
 */
var PRIVATE_FIELDS = ['email'];

/** 外部に返すオブジェクトから、非公開項目を必ず取り除く */
function stripPrivate_(obj) {
  for (var i = 0; i < PRIVATE_FIELDS.length; i++) delete obj[PRIVATE_FIELDS[i]];
  return obj;
}
var CHECKIN_HEADER = ['id', 'ts', 'count', 'source', 'device'];

/* ------------------------------------------------------------------ *
 * 初期セットアップ
 * ------------------------------------------------------------------ */

/** エディタから1回だけ実行して、必要なシートを作ります。 */
function setup() {
  ensureSheets_();
  SpreadsheetApp.getActiveSpreadsheet().toast('シートを準備しました', '応援アプリ', 5);
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_ENTRIES, ENTRY_HEADER);
  ensureSheet_(ss, SHEET_CHECKINS, CHECKIN_HEADER);
  var cfg = ss.getSheetByName(SHEET_CONFIG);
  if (!cfg) {
    cfg = ss.insertSheet(SHEET_CONFIG);
    cfg.getRange(1, 1).setValue('settings');
    cfg.getRange(1, 2).setValue('');
    cfg.setColumnWidth(2, 600);
  }
  return ss;
}

function ensureSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, header.length).setFontWeight('bold');
    return sh;
  }
  // 既にあるシートに、後から増えた列（email など）を足す
  var width = Math.max(sh.getLastColumn(), 1);
  var current = sh.getRange(1, 1, 1, width).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (current[i] !== header[i]) {
      sh.getRange(1, i + 1).setValue(header[i]).setFontWeight('bold');
    }
  }
  return sh;
}

/* ------------------------------------------------------------------ *
 * ルーティング
 * ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'all';
    if (action === 'ping') {
      var ss = ensureSheets_();
      return json_({
        ok: true,
        sheet: ss.getName(),
        entries: Math.max(0, ss.getSheetByName(SHEET_ENTRIES).getLastRow() - 1),
        adminKeySet: !!ADMIN_KEY
      });
    }
    if (action === 'all') return json_(readAll_());
    return json_({ ok: false, error: '不明な action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var record = body.record || {};

    if (action === 'entry') return json_(appendEntry_(record));
    if (action === 'checkin') return json_(appendCheckin_(record));
    if (action === 'settings') {
      if (ADMIN_KEY && body.key !== ADMIN_KEY) {
        return json_({ ok: false, error: '設定用の合言葉が違います。スタッフ→設定の「設定用の合言葉」を確認してください。' });
      }
      return json_(saveSettings_(record));
    }
    return json_({ ok: false, error: '不明な action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ *
 * 読み出し
 * ------------------------------------------------------------------ */

function readAll_() {
  var ss = ensureSheets_();

  var entries = rows_(ss.getSheetByName(SHEET_ENTRIES), ENTRY_HEADER).map(function (r) {
    var goods = [];
    if (r.goodsJson) {
      try { goods = JSON.parse(r.goodsJson); } catch (ignore) {}
    }
    return stripPrivate_({
      id: r.id,
      ts: toIso_(r.ts),
      name: r.name,
      relation: r.relation,
      kind: r.kind,
      headcount: Number(r.headcount) || 0,
      goods: goods,
      goodsQty: Number(r.goodsQty) || 0,
      goodsAmount: Number(r.goodsAmount) || 0,
      delivery: r.delivery,
      shipping: Number(r.shipping) || 0,
      total: Number(r.total) || 0,
      message: r.message,
      device: r.device
      // email はここに含めません（さらに stripPrivate_ でも取り除かれます）
    });
  });

  var checkins = rows_(ss.getSheetByName(SHEET_CHECKINS), CHECKIN_HEADER).map(function (r) {
    return {
      id: r.id,
      ts: toIso_(r.ts),
      count: Number(r.count) || 0,
      source: r.source,
      device: r.device
    };
  });

  var settings = null;
  var raw = ss.getSheetByName(SHEET_CONFIG).getRange(1, 2).getValue();
  if (raw) {
    try { settings = JSON.parse(raw); } catch (ignore) {}
  }

  return { ok: true, entries: entries, checkins: checkins, settings: settings };
}

function rows_(sheet, header) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, header.length).getValues();
  return values.filter(function (row) { return row[0] !== '' && row[0] !== null; })
    .map(function (row) {
      var obj = {};
      for (var i = 0; i < header.length; i++) obj[header[i]] = row[i];
      return obj;
    });
}

function toIso_(v) {
  if (v instanceof Date) return v.toISOString();
  return String(v || '');
}

/* ------------------------------------------------------------------ *
 * 書き込み
 * ------------------------------------------------------------------ */

function existingIds_(sheet) {
  var last = sheet.getLastRow();
  var set = {};
  if (last < 2) return set;
  sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
    if (r[0]) set[String(r[0])] = true;
  });
  return set;
}

function appendEntry_(r) {
  var ss = ensureSheets_();
  var sh = ss.getSheetByName(SHEET_ENTRIES);
  if (!r.id) return { ok: false, error: 'id がありません' };
  // 再送で二重登録にならないようにする
  if (existingIds_(sh)[String(r.id)]) return { ok: true, duplicated: true };

  sh.appendRow([
    r.id,
    r.ts || new Date().toISOString(),
    r.name || '',
    r.relation || '',
    r.kind || '',
    Number(r.headcount) || 0,
    Number(r.goodsQty) || 0,
    Number(r.goodsAmount) || 0,
    r.delivery || '',
    Number(r.shipping) || 0,
    Number(r.total) || 0,
    r.message || '',
    r.device || '',
    JSON.stringify(r.goods || []),
    r.email || ''
  ]);
  return { ok: true };
}

function appendCheckin_(r) {
  var ss = ensureSheets_();
  var sh = ss.getSheetByName(SHEET_CHECKINS);
  if (!r.id) return { ok: false, error: 'id がありません' };
  if (existingIds_(sh)[String(r.id)]) return { ok: true, duplicated: true };

  sh.appendRow([
    r.id,
    r.ts || new Date().toISOString(),
    Number(r.count) || 0,
    r.source || 'qr',
    r.device || ''
  ]);
  return { ok: true };
}

function saveSettings_(settings) {
  var ss = ensureSheets_();
  ss.getSheetByName(SHEET_CONFIG).getRange(1, 2).setValue(JSON.stringify(settings));
  return { ok: true };
}
