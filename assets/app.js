/*!
 * app.js - ウェルカムマッチ 応援アプリ本体
 *
 * データの保存先は2通り:
 *   1) 設定に Google Apps Script の URL を入れる → 全端末で同じスプレッドシートに集約
 *   2) 空のまま                                   → この端末の localStorage だけに保存
 * 通信に失敗した入力は端末に退避され、電波が戻ったときに自動で再送されます。
 */
(function () {
  'use strict';

  /* ==================================================================== *
   * 1. 既定の設定
   * ==================================================================== */

  // 既定値はどのチームでも使えるようにしてある。
  // チーム名・試合情報・グッズ・紹介文などは、スタッフ画面の設定から入力すると
  // スプレッドシート側に保存され、全端末に反映される（このファイルは書き換えなくてよい）。
  var DEFAULT_SETTINGS = {
    teamName: 'ラクロス部',
    eventName: 'ウェルカムマッチ',
    opponent: '',
    eventDate: '',
    startTime: '',
    venue: '',
    venueUrl: '',
    goalOnsite: 100,
    goalGoods: 60,
    shipping: 500,
    // グッズの配送を受け付けるか。false のときは会場受取だけになり、
    // メールアドレスの入力欄も出ない（個人情報を扱わない運用にできる）
    allowShipping: false,
    goods: [
      { id: 'g1', name: '応援タオル', price: 1500 },
      { id: 'g2', name: 'ステッカー', price: 500 },
      { id: 'g3', name: 'チームTシャツ', price: 3000 }
    ],
    // 来場者に見える文言（設定画面から編集できる）
    copyMeterTitle: 'みなさんの応援、ぞくぞく集結中！',
    copyNameExample: '例：リロ',
    copyEntryLead: '当日の来場人数とグッズの購入見込みを事前に把握したいので、ぜひご協力ください！',
    copyCheckinLead: '会場に着いたらタップしてください。来場者数のカウントに使わせていただきます。',
    copyBeforeMsg: 'のぞいてくださってありがとうございます。当日、会場でお待ちしています🥍',

    introLead: 'はじめまして、ラクロス部です',
    introBody: '【ここは設定画面から自由に書き換えてください】\n\n部の雰囲気、今シーズンの目標、この試合にかける想いなどを書くと、はじめて来てくれる人にも伝わりやすくなります。',
    introFacts: '創部：（設定画面で編集）\n部員数：（設定画面で編集）\n活動場所：（設定画面で編集）\n活動日：（設定画面で編集）',
    quiz: [
      '女子ラクロスは、ゴーリーを含めて1チーム12人で戦う。|×|男女ともに10人でプレーをします。',
      'ラクロスで使うスティックは「クロス」と呼ばれる。|◯|先の網（ポケット）にボールを乗せて運び、パスやシュートをします。',
      '女子ラクロスでは、相手に体当たりしてボールを奪ってもよい。|×|女子は原則ボディコンタクト禁止。だからこそ繊細なスティックさばきが勝負どころです。',
      '大学に入ってから競技を始める選手が多い。|◯|ほとんどの選手が大学スタート。「大学から始めて日本一を目指せる」と言われる競技です。',
      'ラクロスは2028年ロサンゼルス五輪の実施競技になっている。|◯|6人制の「ラクロス・シックスズ」として実施されます。'
    ].join('\n'),
    staffPin: '2468',
    gasUrl: '',
    adminKey: ''
  };

  var LS = {
    settings: 'lwm.settings',
    entries: 'lwm.entries',
    checkins: 'lwm.checkins',
    pending: 'lwm.pending',
    device: 'lwm.device',
    checkedIn: 'lwm.checkedIn',
    best: 'lwm.gameBest',
    staff: 'lwm.staffOpen',
    myEntry: 'lwm.myEntry',
    celebrated: 'lwm.celebrated'
  };

  /* ==================================================================== *
   * 2. 小道具
   * ==================================================================== */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function readLS(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function writeLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても続行 */ }
  }

  function yen(n) { return '¥' + Math.round(n || 0).toLocaleString('ja-JP'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function deviceId() {
    var d = readLS(LS.device, null);
    if (!d) { d = uid(); writeLS(LS.device, d); }
    return d;
  }

  /** 1回の訪問を表す識別子。タブを閉じると消える。 */
  function sessionId() {
    try {
      var s = sessionStorage.getItem('lwm.session');
      if (!s) { s = uid(); sessionStorage.setItem('lwm.session', s); }
      return s;
    } catch (e) { return ''; }
  }
  function todayStr(d) {
    var t = d || new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ==================================================================== *
   * 3. 状態
   * ==================================================================== */

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS, readLS(LS.settings, {})),
    entries: [],
    checkins: [],
    pending: readLS(LS.pending, []),
    loaded: false,
    syncing: false,
    lastError: ''
  };

  // 公開ファイル（assets/config.js）に書かれた接続先。
  // 来場者の端末には設定画面がないため、共有するURLはここから配られる。
  var FILE_CONFIG = window.LWM_CONFIG || {};

  /** 実際に使う接続先。端末ごとの設定が優先、無ければ公開ファイルの値。 */
  function effectiveGasUrl() {
    return ((state.settings.gasUrl || '').trim() || (FILE_CONFIG.gasUrl || '').trim());
  }

  function isRemote() { return !!effectiveGasUrl(); }

  /* ==================================================================== *
   * 4. データ層
   * ==================================================================== */

  function setSync(stateName, label) {
    var dot = $('#syncDot');
    dot.dataset.state = stateName;
    dot.textContent = label;
  }

  function refreshSyncBadge() {
    var pend = state.pending.length;
    if (state.syncing) { setSync('busy', '同期中…'); return; }
    if (!isRemote()) { setSync('local', 'この端末のみ'); return; }
    if (state.lastError) { setSync('error', '接続エラー' + (pend ? '・未送信' + pend : '')); return; }
    if (pend) { setSync('error', '未送信 ' + pend + ' 件'); return; }
    setSync('ok', '共有中');
  }

  function gasGet(params) {
    var base = effectiveGasUrl();
    var url = base + (base.indexOf('?') >= 0 ? '&' : '?') +
      Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch(url, { method: 'GET', redirect: 'follow' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function gasPost(body) {
    // Content-Type を text/plain にしてプリフライト（CORS の事前確認）を回避する
    return fetch(effectiveGasUrl(), {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || j.ok !== true) throw new Error((j && j.error) || '保存に失敗しました');
      return j;
    });
  }

  var Data = {
    load: function () {
      if (!isRemote()) {
        state.entries = readLS(LS.entries, []);
        state.checkins = readLS(LS.checkins, []);
        state.loaded = true;
        state.lastError = '';
        refreshSyncBadge();
        return Promise.resolve();
      }
      state.syncing = true;
      refreshSyncBadge();
      return gasGet({ action: 'all' }).then(function (res) {
        if (!res || res.ok !== true) throw new Error((res && res.error) || '読み込みに失敗しました');
        state.entries = res.entries || [];
        state.checkins = res.checkins || [];
        state.views = res.views || null;
        if (res.settings && typeof res.settings === 'object') {
          // 共有設定を取り込む。ただし端末だけに置く項目は上書きしない。
          var keepLocal = {
            gasUrl: state.settings.gasUrl,
            adminKey: state.settings.adminKey,
            staffPin: state.settings.staffPin
          };
          state.settings = Object.assign({}, DEFAULT_SETTINGS, res.settings, keepLocal);
          writeLS(LS.settings, state.settings);
        }
        state.loaded = true;
        state.lastError = '';
      }).catch(function (e) {
        state.lastError = e.message || String(e);
        // 通信できないときは端末に残っている分で表示を続ける
        state.entries = readLS(LS.entries, []);
        state.checkins = readLS(LS.checkins, []);
      }).then(function () {
        state.syncing = false;
        refreshSyncBadge();
      });
    },

    addEntry: function (entry) {
      return Data._send('entry', entry, LS.entries, 'entries');
    },

    addCheckin: function (checkin) {
      return Data._send('checkin', checkin, LS.checkins, 'checkins');
    },

    _send: function (action, record, lsKey, listKey) {
      // まず端末側へ反映（オフラインでも画面が正しく進む）
      var local = readLS(lsKey, []);
      local.push(record);
      writeLS(lsKey, local);
      if (state[listKey].indexOf(record) < 0) state[listKey].push(record);

      if (!isRemote()) return Promise.resolve({ ok: true, offline: false });

      return gasPost({ action: action, record: record }).then(function (r) {
        return { ok: true, offline: false, result: r };
      }).catch(function (e) {
        // 送れなかった分は退避しておき、あとで再送する
        state.pending.push({ action: action, record: record });
        writeLS(LS.pending, state.pending);
        state.lastError = e.message || String(e);
        refreshSyncBadge();
        return { ok: true, offline: true };
      });
    },

    flushPending: function () {
      if (!isRemote() || !state.pending.length) return Promise.resolve();
      var queue = state.pending.slice();
      var remaining = [];
      var chain = Promise.resolve();
      queue.forEach(function (item) {
        chain = chain.then(function () {
          return gasPost({ action: item.action, record: item.record }).catch(function () {
            remaining.push(item);
          });
        });
      });
      return chain.then(function () {
        state.pending = remaining;
        writeLS(LS.pending, state.pending);
        if (!remaining.length) state.lastError = '';
        refreshSyncBadge();
      });
    },

    /**
     * 画面が開かれたことを記録する。
     * 集客の手ごたえ（届いたか／入力まで進んだか）を見るためのもの。
     * 失敗しても利用者には一切影響させない（投げっぱなしにする）。
     */
    logView: function (view) {
      if (!isRemote()) return;
      try {
        var key = 'lwm.viewed.' + view;
        if (sessionStorage.getItem(key)) return;   // 同じ訪問で二重に数えない
        sessionStorage.setItem(key, '1');
        gasPost({
          action: 'view',
          record: { ts: new Date().toISOString(), view: view, device: deviceId(), session: sessionId() }
        }).catch(function () { /* 記録できなくても何もしない */ });
      } catch (e) { /* sessionStorage が使えない環境でも動かす */ }
    },

    saveSettings: function (settings) {
      state.settings = settings;
      writeLS(LS.settings, settings);
      if (!isRemote()) return Promise.resolve({ ok: true });
      var share = Object.assign({}, settings);
      delete share.gasUrl;    // 接続先URLはシートに保存しない
      delete share.adminKey;  // 合言葉も共有しない（この端末だけに置く）
      delete share.staffPin;
      return gasPost({ action: 'settings', key: settings.adminKey || '', record: share }).then(function (r) {
        state.lastError = '';
        return r;
      }).catch(function (e) {
        state.lastError = e.message || String(e);
        throw e;
      });
    },

    /** 端末に残っているテスト用データを消す（共有シート側は消さない） */
    clearLocal: function () {
      [LS.entries, LS.checkins, LS.pending, LS.checkedIn, LS.best,
       LS.myEntry, LS.celebrated].forEach(function (k) {
        try { localStorage.removeItem(k); } catch (e) { /* 無視 */ }
      });
      state.pending = [];
      if (!isRemote()) { state.entries = []; state.checkins = []; }
    }
  };

  /* ==================================================================== *
   * 5. 集計
   * ==================================================================== */

  function allEntries() {
    if (!isRemote()) return state.entries;
    // 未送信ぶんは重複しないようIDで判定して足す
    var ids = {};
    state.entries.forEach(function (e) { ids[e.id] = true; });
    var extra = state.pending
      .filter(function (p) { return p.action === 'entry' && !ids[p.record.id]; })
      .map(function (p) { return p.record; });
    return state.entries.concat(extra);
  }

  function allCheckins() {
    if (!isRemote()) return state.checkins;
    var ids = {};
    state.checkins.forEach(function (c) { ids[c.id] = true; });
    var extra = state.pending
      .filter(function (p) { return p.action === 'checkin' && !ids[p.record.id]; })
      .map(function (p) { return p.record; });
    return state.checkins.concat(extra);
  }

  function summarize() {
    var entries = allEntries();
    var checkins = allCheckins();
    var s = {
      entryCount: entries.length,
      cheerOnly: 0,          // 当日は来られないが応援を届けてくれた人
      onsitePeople: 0,
      goodsEntries: 0,
      goodsQty: 0,
      goodsAmount: 0,
      shipCount: 0,
      ogCount: 0,
      byGoods: {},
      byRelation: {},
      messages: [],
      qrCount: 0,
      manualCount: 0
    };

    entries.forEach(function (e) {
      if (e.kind === 'cheer') s.cheerOnly++;
      if (e.kind === 'onsite' || e.kind === 'both') s.onsitePeople += Number(e.headcount) || 0;
      if (e.kind === 'goods' || e.kind === 'both') {
        s.goodsEntries++;
        s.goodsQty += Number(e.goodsQty) || 0;
        s.goodsAmount += Number(e.total) || 0;
        if (e.delivery === 'ship') s.shipCount++;
        (e.goods || []).forEach(function (g) {
          if (!g.qty) return;
          if (!s.byGoods[g.name]) s.byGoods[g.name] = { qty: 0, amount: 0 };
          s.byGoods[g.name].qty += Number(g.qty) || 0;
          s.byGoods[g.name].amount += (Number(g.qty) || 0) * (Number(g.price) || 0);
        });
      }
      var rel = e.relation || 'その他';
      s.byRelation[rel] = (s.byRelation[rel] || 0) + 1;
      if (rel === 'OG') s.ogCount++;
      if (e.message) s.messages.push({ name: e.name, message: e.message, ts: e.ts });
    });

    s.offDayCount = 0;
    s.offDayRecords = 0;
    s.byArrivalSelf = {};       // 受付した本人の「部とのつながり」
    s.byArrivalCompanion = {};  // 同伴者の「受付した人との関係」
    s.arrivalGoodsQty = 0;      // 当日その場でのグッズ購入希望
    s.arrivalGoodsAmount = 0;
    s.namedArrivals = 0;        // 名前まで分かっている受付の件数
    var attended = {};          // 来場が確認できた事前エントリーのID

    checkins.forEach(function (c) {
      var n = Number(c.count) || 0;
      if (!isCountableCheckin(c)) {
        // 当日以外の記録（誤タップ・テスト）は集計から外す
        s.offDayCount += n;
        s.offDayRecords++;
        return;
      }
      if (c.source === 'manual') { s.manualCount += n; return; }

      s.qrCount += n;
      if (c.name) s.namedArrivals++;
      if (c.entryId) attended[c.entryId] = true;

      // 受付した本人と同伴者は、たずねた質問がちがうので別々に集計する。
      // 本人 …「部とのつながり」／同伴者 …「受付した人との関係」
      var rel = c.relation || '不明';
      s.byArrivalSelf[rel] = (s.byArrivalSelf[rel] || 0) + 1;

      var comp = Array.isArray(c.companions) ? c.companions : [];
      comp.forEach(function (r) {
        var k = r || '不明';
        s.byArrivalCompanion[k] = (s.byArrivalCompanion[k] || 0) + 1;
      });
      // 同伴者の回答がない古い記録は「未回答」として残す（黙って本人に足さない）
      var missing = n - 1 - comp.length;
      if (missing > 0) s.byArrivalCompanion['未回答'] = (s.byArrivalCompanion['未回答'] || 0) + missing;
      s.arrivalGoodsQty += Number(c.goodsQty) || 0;
      s.arrivalGoodsAmount += Number(c.goodsAmount) || 0;
    });
    s.liveTotal = s.qrCount + s.manualCount;

    // 事前に「現地に行く」と答えた人のうち、実際に来場が確認できた割合
    var expected = entries.filter(function (e) { return e.kind === 'onsite' || e.kind === 'both'; });
    s.expectedEntries = expected.length;
    s.attendedEntries = expected.filter(function (e) { return attended[e.id]; }).length;
    s.turnout = expected.length ? Math.round(s.attendedEntries / expected.length * 100) : null;

    s.messages.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    return s;
  }

  /* ==================================================================== *
   * 6. 画面切り替え
   * ==================================================================== */

  var currentView = 'home';

  function go(view, opts) {
    if (!$('[data-view="' + view + '"]')) view = 'home';
    currentView = view;
    $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === view); });
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('is-active', b.dataset.go === view); });
    if (location.hash !== '#/' + view) {
      history.replaceState(null, '', '#/' + view);
    }
    if (!(opts && opts.keepScroll)) window.scrollTo(0, 0);

    // スタッフ自身の操作は集客の数字に混ぜない
    if (view !== 'staff') Data.logView(view);

    if (view === 'game') { Game.enter(); } else { Game.leave(); }
    if (view === 'home') renderHome();
    if (view === 'checkin') renderCheckin();
    if (view === 'staff') renderStaff();
    if (view === 'team') renderTeam();
    if (view === 'entry') renderGoodsPicker();
  }

  function bindMessages() {
    $('#msgMoreBtn').addEventListener('click', function () {
      showAllMessages = !showAllMessages;
      renderMessages(summarize().messages);
      if (!showAllMessages) $('#msgTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function bindNav() {
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-go]');
      if (!t) return;
      e.preventDefault();
      go(t.dataset.go);
    });
    window.addEventListener('hashchange', function () {
      var v = (location.hash || '').replace(/^#\/?/, '') || 'home';
      if (v !== currentView) go(v);
    });
  }

  /* ==================================================================== *
   * 7. ホーム
   * ==================================================================== */

  function renderHero() {
    var s = state.settings;
    $('#brandTeam').textContent = s.teamName || 'ラクロス部';
    $('#heroKicker').textContent = (s.teamName || '') + ' / WELCOME MATCH';
    $('#heroTitle').textContent = s.eventName || 'ウェルカムマッチ';

    var rows = [];
    if (s.opponent) rows.push(['対戦', s.opponent]);
    if (s.eventDate) {
      var d = new Date(s.eventDate + 'T00:00:00');
      var wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
      rows.push(['日時', (d.getMonth() + 1) + '月' + d.getDate() + '日(' + wd + ')' + (s.startTime ? ' ' + s.startTime + '〜' : '')]);
    }
    if (s.venue) {
      rows.push(['会場', s.venueUrl
        ? '<a href="' + esc(s.venueUrl) + '" target="_blank" rel="noopener" style="color:#c9f24d">' + esc(s.venue) + ' ↗</a>'
        : esc(s.venue)]);
    }
    if (!rows.length) rows.push(['ご案内', '試合情報はスタッフページの設定から入力できます']);

    $('#heroMeta').innerHTML = rows.map(function (r) {
      return '<div><span class="lbl">' + esc(r[0]) + '</span><span>' + (r[0] === '会場' ? r[1] : esc(r[1])) + '</span></div>';
    }).join('');

    var cd = $('#heroCountdown');
    if (!s.eventDate) { cd.style.display = 'none'; return; }
    cd.style.display = '';
    var today = new Date(todayStr() + 'T00:00:00');
    var ev = new Date(s.eventDate + 'T00:00:00');
    var diff = Math.round((ev - today) / 86400000);
    if (diff > 0) cd.innerHTML = 'あと <b>' + diff + '</b> 日';
    else if (diff === 0) cd.innerHTML = '🔥 <b>今日が試合当日！</b>';
    else cd.innerHTML = '応援ありがとうございました！';
  }

  /** 設定画面から編集できる文言を、画面に反映する */
  function applyCopy() {
    var s = state.settings;
    var set = function (sel, value, attr) {
      var el = $(sel);
      if (!el || !value) return;
      if (attr) el.setAttribute(attr, value); else el.textContent = value;
    };
    set('#meterTitle', s.copyMeterTitle);
    set('#fName', s.copyNameExample, 'placeholder');
    set('#entryLead', s.copyEntryLead);
    set('#checkinLead', s.copyCheckinLead);
  }

  function isEventDay() {
    return !!state.settings.eventDate && state.settings.eventDate === todayStr();
  }

  /** 試合日から見て今日がいつか。'before' | 'today' | 'after' | 'unknown'（日付未設定） */
  function eventDayState() {
    var d = state.settings.eventDate;
    if (!d) return 'unknown';
    var today = todayStr();
    if (today === d) return 'today';
    return today < d ? 'before' : 'after';
  }

  /** ISO文字列を、その端末のローカル日付（YYYY-MM-DD）に変換する */
  function localDateOf(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : todayStr(d);
  }

  /**
   * 来場者数に数えてよい記録かどうか。
   * 試合日を設定してあれば「当日に記録されたもの」だけを数える。
   * これにより、前日までの誤タップやスタッフのテストが本番の数字を汚さない。
   */
  function isCountableCheckin(c) {
    var d = state.settings.eventDate;
    if (!d) return true;              // 日付未設定なら判定できないので全部数える
    return localDateOf(c.ts) === d;
  }

  /**
   * 目標に対する進み具合を描く。
   * 未達なら「あと◯」で背中を押し、達成したらバーを金色にしてバッジを出す。
   */
  function renderGoal(key, barEl, noteEl, current, goal, unit, label) {
    goal = Math.max(1, Number(goal) || 1);
    var pct = current / goal * 100;
    var done = current >= goal;

    barEl.style.width = Math.min(100, pct) + '%';
    barEl.parentNode.classList.toggle('is-done', done);

    if (done) {
      noteEl.innerHTML = '<span class="badge gold">🎉 目標達成！</span>目標 ' +
        goal.toLocaleString('ja-JP') + unit + ' に対して ' + Math.round(pct) + '%';
      maybeCelebrate(key, label, goal, unit);
    } else {
      var left = goal - current;
      noteEl.textContent = '目標 ' + goal.toLocaleString('ja-JP') + unit +
        ' まで あと ' + left.toLocaleString('ja-JP') + unit;
    }
  }

  /** 達成のお祝いは、その端末で一度だけ出す（毎回出るとうるさいため） */
  function maybeCelebrate(key, label, goal, unit) {
    var seen = readLS(LS.celebrated, {});
    if (seen[key]) return;
    seen[key] = true;
    writeLS(LS.celebrated, seen);

    $('#celebrateText').innerHTML = esc(label) + 'が<br>目標の ' +
      goal.toLocaleString('ja-JP') + unit + ' に届きました！<br>応援ありがとうございます 🎉';
    var box = $('#celebrate');
    box.hidden = false;
    var close = function () { box.hidden = true; box.removeEventListener('click', close); };
    box.addEventListener('click', close);
    setTimeout(close, 5000);
  }

  function renderHome() {
    renderHero();
    applyCopy();
    var s = summarize();
    var set = state.settings;

    // 当日来場者数カード
    var liveCard = $('#liveCard');
    if (s.liveTotal > 0 || isEventDay()) {
      liveCard.classList.remove('hidden');
      $('#liveCount').textContent = s.liveTotal.toLocaleString('ja-JP');
    } else {
      liveCard.classList.add('hidden');
    }

    $('#mOnsite').textContent = s.onsitePeople.toLocaleString('ja-JP');
    $('#mGoodsQty').textContent = s.goodsQty.toLocaleString('ja-JP');
    renderGoal('onsite', $('#bOnsite'), $('#nOnsite'), s.onsitePeople, set.goalOnsite, '人', '現地応援');
    renderGoal('goods', $('#bGoods'), $('#nGoods'), s.goodsQty, set.goalGoods, '点', 'グッズ応援');

    // 金額は一般向けの画面には出さない（スタッフ画面にのみ表示）
    $('#sEntries').textContent = s.entryCount.toLocaleString('ja-JP');
    $('#sGoodsEntries').textContent = s.goodsEntries.toLocaleString('ja-JP');
    $('#sMessages').textContent = s.messages.length.toLocaleString('ja-JP');

    renderDonut($('#homeDonut'), $('#homeDonutLegend'), s.byRelation, '人がエントリー');

    renderMessages(s.messages);
  }

  // 応援メッセージを一度に出す件数。「もっと見る」で全部読める。
  var MSG_PREVIEW = 8;
  var showAllMessages = false;

  /**
   * 応援メッセージの一覧。
   * 届いたものは1件も捨てず、最初は新しい順に少しだけ出して、
   * 「もっと見る」で全件ひらけるようにする。
   */
  function renderMessages(all) {
    var msgs = showAllMessages ? all : all.slice(0, MSG_PREVIEW);
    $('#msgTitle').hidden = all.length === 0;
    $('#msgList').innerHTML = msgs.map(function (m) {
      return '<div class="msg"><div class="who">' + esc(m.name || 'ななし') + ' さん</div>' +
        '<div class="tx">' + esc(m.message) + '</div></div>';
    }).join('');

    var btn = $('#msgMoreBtn');
    var hidden = all.length - MSG_PREVIEW;
    if (hidden <= 0) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    btn.textContent = showAllMessages
      ? '応援メッセージをとじる'
      : '応援メッセージをすべて見る（あと ' + hidden + ' 件）';
  }

  /* ==================================================================== *
   * 8. エントリー
   * ==================================================================== */

  var entryForm = {
    kind: '',
    headcount: 1,
    delivery: 'onsite',
    qty: {}
  };

  function markChoice(container) {
    $$('.choice', container).forEach(function (c) {
      var input = $('input', c);
      c.classList.toggle('is-on', !!(input && input.checked));
    });
  }

  function activeGoods() {
    return (state.settings.goods || []).filter(function (g) { return g.name && Number(g.price) >= 0; });
  }

  /** グッズの選択欄を描く。エントリー画面と受付画面で共用する。 */
  function renderGoodsInto(listEl, qtyMap) {
    var goods = activeGoods();
    if (!goods.length) {
      listEl.innerHTML = '<p class="hint">グッズはまだ登録されていません。スタッフページの設定から追加できます。</p>';
      return;
    }
    listEl.innerHTML = goods.map(function (g) {
      var q = qtyMap[g.id] || 0;
      return '<div class="goods-item" data-goods="' + esc(g.id) + '">' +
        '<div class="info"><div class="nm">' + esc(g.name) + '</div>' +
        '<div class="pr">' + yen(g.price) + '</div></div>' +
        '<div class="stepper">' +
        '<button type="button" data-gstep="-1" aria-label="減らす">−</button>' +
        '<span class="num" data-gqty>' + q + '</span>' +
        '<button type="button" data-gstep="1" aria-label="増やす">＋</button>' +
        '</div></div>';
    }).join('');
  }

  /**
   * グッズ欄の＋−を有効にする。押されたら onChange を呼ぶ。
   *
   * 数量の入れ物は getMap() で毎回取り直す。
   * フォームをリセットすると入れ物ごと作り直されるため、
   * ここで受け取った時点の参照を持ち続けると、古い入れ物を更新してしまう。
   */
  function bindGoodsStepper(listEl, getMap, onChange) {
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('[data-gstep]');
      if (!b) return;
      var row = b.closest('[data-goods]');
      var id = row.dataset.goods;
      var qtyMap = getMap();
      var next = Math.max(0, Math.min(20, (qtyMap[id] || 0) + Number(b.dataset.gstep)));
      qtyMap[id] = next;
      $('[data-gqty]', row).textContent = next;
      onChange();
    });
  }

  function selectionFrom(qtyMap) {
    var out = [];
    activeGoods().forEach(function (g) {
      var q = qtyMap[g.id] || 0;
      if (q > 0) out.push({ id: g.id, name: g.name, price: Number(g.price) || 0, qty: q });
    });
    return out;
  }

  function renderGoodsPicker() {
    renderGoodsInto($('#goodsList'), entryForm.qty);
    $('#shipNote').textContent = '＋' + yen(state.settings.shipping);
    applyShippingVisibility();
    updateTotals();
  }

  function goodsSelection() { return selectionFrom(entryForm.qty); }

  /** 配送を受け付ける設定になっているか */
  function shippingEnabled() { return state.settings.allowShipping === true; }

  /** 配送になる組み合わせかどうか（＝メールアドレスが必要かどうか） */
  function needsDelivery() {
    if (!shippingEnabled()) return false;                              // 配送を受け付けない運用
    if (entryForm.kind === 'goods') return true;                       // グッズのみは必ず配送
    if (entryForm.kind === 'both') return entryForm.delivery === 'ship'; // 会場受取なら不要
    return false;
  }

  /**
   * 配送のオン/オフに応じて、エントリー画面の選択肢を出し分ける。
   * オフのときは「グッズ購入で応援（配送）」と受取方法の選択そのものを隠す。
   */
  function applyShippingVisibility() {
    var on = shippingEnabled();
    var goodsOnly = $('#supportChoices .choice[data-kind="goods"]');
    if (goodsOnly) goodsOnly.classList.toggle('hidden', !on);
    $('#deliveryField').classList.toggle('hidden', !on);

    // 会場受取だけの運用では、案内文も実態に合わせる
    var bothDesc = $('#supportChoices .choice[data-kind="both"] .d');
    if (bothDesc) {
      bothDesc.textContent = on
        ? '当日会場で部員から直接お渡しします（送料なし）'
        : '当日会場で部員から直接お渡しします';
    }

    // 配送をやめた直後に「グッズのみ」が選ばれたままにならないようにする
    if (!on && entryForm.kind === 'goods') {
      entryForm.kind = '';
      $$('#supportChoices input').forEach(function (i) { i.checked = false; });
      markChoice($('#supportChoices'));
      applyKindVisibility();
    }
  }

  function updateTotals() {
    var sel = goodsSelection();
    var sub = sel.reduce(function (a, g) { return a + g.price * g.qty; }, 0);
    var ship = (needsDelivery() && sub > 0) ? (Number(state.settings.shipping) || 0) : 0;
    $('#tSub').textContent = yen(sub);
    $('#tShip').textContent = yen(ship);
    $('#tGrand').textContent = yen(sub + ship);
    // 配送のときだけメールアドレスを聞く
    $('#emailField').classList.toggle('hidden', !needsDelivery());
    return { sel: sel, sub: sub, ship: ship, total: sub + ship };
  }

  function applyKindVisibility() {
    var k = entryForm.kind;
    $('#onsiteBlock').classList.toggle('hidden', !(k === 'onsite' || k === 'both'));
    $('#goodsBlock').classList.toggle('hidden', !(k === 'goods' || k === 'both'));

    // 「行けないけれど応援」を選んだ人は、メッセージが唯一の届けものなので必須にする
    $('#msgLabel').textContent = (k === 'cheer')
      ? '応援メッセージ（必須・選手に届きます）'
      : '応援メッセージ（任意・アプリに掲示されます）';

    // 「両方」のときは会場受取が既定、グッズだけなら配送が既定
    var wanted = (k === 'both') ? 'onsite' : 'ship';
    if (k === 'goods' || k === 'both') {
      var input = $('input[name="delivery"][value="' + wanted + '"]');
      if (input && !$('input[name="delivery"]:checked')) {
        input.checked = true;
        entryForm.delivery = wanted;
      }
      // 「両方」で配送を選んでいた場合も、会場受取に寄せる
      if (k === 'both' && entryForm.delivery !== 'onsite' && !entryForm.deliveryTouched) {
        $('input[name="delivery"][value="onsite"]').checked = true;
        entryForm.delivery = 'onsite';
      }
      markChoice($('#deliveryField'));
    }
    updateTotals();
  }

  function bindEntry() {
    $$('#supportChoices input').forEach(function (input) {
      input.addEventListener('change', function () {
        entryForm.kind = input.value;
        markChoice($('#supportChoices'));
        applyKindVisibility();
      });
    });

    $$('input[name="delivery"]').forEach(function (input) {
      input.addEventListener('change', function () {
        entryForm.delivery = input.value;
        entryForm.deliveryTouched = true;
        markChoice($('#deliveryField'));
        updateTotals();
      });
    });

    // 人数ステッパー（エントリー・チェックイン共通）
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-step]');
      if (!b) return;
      var target = b.dataset.target;
      var delta = Number(b.dataset.step);
      if (target === 'headcount') {
        entryForm.headcount = Math.max(1, Math.min(30, entryForm.headcount + delta));
        $('#headcountNum').textContent = entryForm.headcount;
      } else if (target === 'checkinNum') {
        checkinCount = Math.max(1, Math.min(30, checkinCount + delta));
        $('#checkinNumNum').textContent = checkinCount;
        resetCompanions();       // 人数が変わったら同伴者は選び直し
        renderCompanions();
      }
    });

    bindGoodsStepper($('#goodsList'), function () { return entryForm.qty; }, updateTotals);

    $('#entryForm').addEventListener('submit', onEntrySubmit);
    $('#entryAgain').addEventListener('click', resetEntryForm);
  }

  function resetEntryForm() {
    entryForm = { kind: '', headcount: 1, delivery: 'onsite', qty: {} };
    $('#entryForm').reset();
    $('#entryForm').classList.remove('hidden');
    $('#entryDone').classList.add('hidden');
    $('#headcountNum').textContent = '1';
    $('#entryError').innerHTML = '';
    markChoice($('#supportChoices'));
    markChoice($('#deliveryField'));
    applyKindVisibility();
    renderGoodsPicker();
  }

  function onEntrySubmit(e) {
    e.preventDefault();
    var errBox = $('#entryError');
    errBox.innerHTML = '';

    var name = $('#fName').value.trim();
    if (!name) return showErr(errBox, 'お名前を入れてください。');
    if (!entryForm.kind) return showErr(errBox, '応援の仕方を選んでください。');

    var t = updateTotals();
    if ((entryForm.kind === 'goods' || entryForm.kind === 'both') && t.sel.length === 0) {
      return showErr(errBox, 'グッズを1点以上えらんでください。（現地応援だけの場合は「当日 現地で応援する」を選んでね）');
    }
    if (entryForm.kind === 'cheer' && !$('#fMessage').value.trim()) {
      return showErr(errBox, '応援メッセージを入れてください。ひとことでも、そのまま選手に届きます。');
    }

    var wantsOnsite = entryForm.kind === 'onsite' || entryForm.kind === 'both';
    var wantsGoods = entryForm.kind === 'goods' || entryForm.kind === 'both';

    var email = $('#fEmail').value.trim();
    if (needsDelivery()) {
      if (!email) return showErr(errBox, 'お届け先のご案内をお送りするため、メールアドレスを入れてください。');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr(errBox, 'メールアドレスの形式をご確認ください。');
    } else {
      email = '';
    }

    var record = {
      id: uid(),
      ts: new Date().toISOString(),
      name: name,
      relation: $('#fRelation').value,
      kind: entryForm.kind,
      headcount: wantsOnsite ? entryForm.headcount : 0,
      goods: wantsGoods ? t.sel : [],
      goodsQty: wantsGoods ? t.sel.reduce(function (a, g) { return a + g.qty; }, 0) : 0,
      goodsAmount: wantsGoods ? t.sub : 0,
      delivery: wantsGoods ? (entryForm.kind === 'both' ? entryForm.delivery : 'ship') : '',
      shipping: wantsGoods ? t.ship : 0,
      total: wantsGoods ? t.total : 0,
      email: email,
      message: $('#fMessage').value.trim(),
      device: deviceId()
    };
    if (entryForm.kind === 'goods') {
      // グッズのみの場合は必ず配送
      record.delivery = 'ship';
      record.shipping = Number(state.settings.shipping) || 0;
      record.total = t.sub + record.shipping;
    }
    if (wantsGoods && !shippingEnabled()) {
      // 配送を受け付けない運用では、必ず会場受取として記録する
      record.delivery = 'onsite';
      record.shipping = 0;
      record.total = t.sub;
    }

    var btn = $('#entrySubmit');
    btn.disabled = true;
    btn.textContent = '送信中…';

    // 当日の受付でこの端末を自動判別できるよう、エントリー内容を覚えておく
    writeLS(LS.myEntry, {
      id: record.id, name: record.name, relation: record.relation,
      kind: record.kind, headcount: record.headcount
    });

    Data.addEntry(record).then(function (res) {
      var parts = [];
      if (record.kind === 'cheer') {
        parts.push('応援メッセージ、たしかに受け取りました。選手みんなに届けます！');
      }
      if (wantsOnsite) parts.push('当日は ' + record.headcount + ' 名でのご来場、お待ちしてます！');
      if (wantsGoods) {
        parts.push('グッズ ' + record.goodsQty + ' 点（' + yen(record.total) + '）で応援ありがとうございます。');
        parts.push(record.delivery === 'onsite'
          ? '当日、会場で部員からお渡しします。'
          : '後日、ラクロス部より詳細のご案内を ' + record.email + ' 宛にお送りします。');
      }
      if (res.offline) parts.push('※電波が弱いため端末に保存しました。つながり次第、自動で送信されます。');
      $('#entryDoneMsg').textContent = parts.join(' ');
      $('#entryForm').classList.add('hidden');
      $('#entryDone').classList.remove('hidden');
      window.scrollTo(0, 0);
      renderHome();
    }).catch(function (err) {
      showErr(errBox, '送信できませんでした：' + (err.message || err));
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'この内容でエントリーする';
    });
  }

  function showErr(box, msg) {
    box.innerHTML = '<div class="notice err">' + esc(msg) + '</div>';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }

  /* ==================================================================== *
   * 9. チェックイン
   * ==================================================================== */

  var checkinCount = 1;
  var checkinTestMode = false;

  /** この端末が今日すでに受け付け済みか（誤って二重に数えないため） */
  function checkedInToday() {
    var rec = readLS(LS.checkedIn, null);
    if (!rec) return 0;
    if (typeof rec === 'number') return 0;         // 旧バージョンの記録は無視する
    return rec.date === todayStr() ? (rec.count || 0) : 0;
  }

  function rememberCheckin(n) {
    var today = todayStr();
    var rec = readLS(LS.checkedIn, null);
    var base = (rec && typeof rec === 'object' && rec.date === today) ? (rec.count || 0) : 0;
    writeLS(LS.checkedIn, { date: today, count: base + n });
  }

  // 受付する本人にたずねる「部とのつながり」
  var RELATIONS = ['OG', '現役家族', '友人', '大学関係', '他大学', 'その他'];

  // 同伴者にたずねる選択肢。
  // 本人と同じ質問をしても答えにくいので、「連れてきた人から見た関係」で聞く。
  var COMPANION_RELATIONS = ['子ども', '家族・パートナー', '友人', 'OG', '大学関係', '他大学', 'その他'];

  // 受付フォームの入力内容
  // companionMode: '' 未回答 / 'same' 全員同じ / 'mixed' 個別に指定
  var checkinForm = { relation: '', kind: '', qty: {}, useMyEntry: true, companionMode: '', companions: [] };

  /** 受付する代表者の「つながり」。事前エントリー済みならその値を使う。 */
  function repRelation() {
    var me = myEntry();
    return (me && checkinForm.useMyEntry) ? me.relation : checkinForm.relation;
  }

  function resetCompanions() {
    checkinForm.companionMode = '';
    checkinForm.companions = [];
  }

  /**
   * 受付フォームを初期状態に戻す。
   * 1台の端末で次々に受付することがあるため、前の人の入力が残らないようにする。
   */
  function resetCheckinForm() {
    checkinCount = 1;
    $('#checkinNumNum').textContent = '1';
    checkinForm.relation = '';
    checkinForm.kind = '';
    checkinForm.qty = {};
    resetCompanions();
    $('#checkinName').value = '';
    $$('input[name="ckind"]').forEach(function (i) { i.checked = false; });
    markChoice($('#guestCard'));
    $('#checkinError').innerHTML = '';
    renderRelationChips();
    renderCheckinGoods();
    renderCompanions();
  }

  /** 同伴者の入力欄。2名以上のときだけ出す。 */
  function renderCompanions() {
    var need = checkinCount - 1;
    var card = $('#companionCard');
    if (need < 1) {
      card.classList.add('hidden');
      return;
    }
    card.classList.add('hidden');
    var rep = repRelation();
    if (!rep) return;              // 先に代表者のつながりを選んでもらう
    card.classList.remove('hidden');

    var mode = checkinForm.companionMode;
    $('#companionQ').textContent = 'ご一緒の ' + need + ' 名は、あなたとどんな関係ですか？' +
      '（' + need + ' 名とも「' + rep + '」の場合は「はい、同じ」）';
    $('#companionAsk').classList.toggle('hidden', mode !== '');
    $('#companionPicker').classList.toggle('hidden', mode !== 'mixed');
    $('#companionSummary').classList.toggle('hidden', mode !== 'same' && !(mode === 'mixed' && checkinForm.companions.length >= need));
    $('#companionReset').classList.toggle('hidden', mode === '');

    if (mode === 'same') {
      $('#companionSummary').textContent = 'ご一緒の ' + need + ' 名も「' + rep + '」として受け付けます。';
      return;
    }

    if (mode === 'mixed') {
      var remain = need - checkinForm.companions.length;
      $('#companionRemain').textContent = remain > 0
        ? 'あと ' + remain + ' 名ぶん、つながりを選んでください。'
        : 'すべて選べました。';
      $('#companionChips').innerHTML = COMPANION_RELATIONS.map(function (r) {
        return '<button type="button" data-crel="' + esc(r) + '"' +
          (remain <= 0 ? ' disabled style="opacity:.4"' : '') + '>' + esc(r) + '</button>';
      }).join('');
      $('#companionChosen').innerHTML = checkinForm.companions.length
        ? checkinForm.companions.map(function (r) { return '<span class="badge lime" style="margin:0 6px 6px 0">' + esc(r) + '</span>'; }).join('')
        : '';
      if (remain <= 0) {
        $('#companionSummary').textContent = 'ご一緒の ' + need + ' 名：' + checkinForm.companions.join('、') + ' として受け付けます。';
      }
    }
  }

  /** この端末で事前エントリーした人の情報（あれば） */
  function myEntry() {
    var m = readLS(LS.myEntry, null);
    return (m && m.id) ? m : null;
  }

  function renderCheckinGoods() {
    renderGoodsInto($('#checkinGoodsList'), checkinForm.qty);
    updateCheckinTotal();
  }

  function updateCheckinTotal() {
    var sel = selectionFrom(checkinForm.qty);
    $('#cTotal').textContent = yen(sel.reduce(function (a, g) { return a + g.price * g.qty; }, 0));
    $('#checkinGoodsCard').classList.toggle('hidden', checkinForm.kind !== 'both');
  }

  function renderRelationChips() {
    $('#checkinRelation').innerHTML = RELATIONS.map(function (r) {
      return '<button type="button" data-rel="' + esc(r) + '"' +
        (checkinForm.relation === r ? ' class="is-on"' : '') + '>' + esc(r) + '</button>';
    }).join('');
  }

  /** 事前エントリー済みの端末か、飛び入りかで入力欄を切り替える */
  function renderCheckinIdentity() {
    var me = myEntry();
    var known = !!me && checkinForm.useMyEntry;
    $('#knownCard').classList.toggle('hidden', !known);
    $('#guestCard').classList.toggle('hidden', known);

    if (known) {
      $('#knownName').textContent = me.name + ' さん';
      $('#knownRel').textContent = me.relation + '／' + (KIND_LABEL[me.kind] || me.kind);
    } else {
      renderRelationChips();
      updateCheckinTotal();
    }
  }

  /** 受付画面の表示を、試合日との関係で切り替える */
  function renderCheckin() {
    var phase = eventDayState();
    var locked = (phase === 'before' || phase === 'after') && !checkinTestMode;

    $('#checkinLocked').classList.toggle('hidden', !locked);
    $('#checkinTestBanner').classList.toggle('hidden', !checkinTestMode);

    if (locked) {
      $('#checkinBefore').classList.add('hidden');
      $('#checkinAfter').classList.add('hidden');

      var d = state.settings.eventDate;
      if (phase === 'before') {
        var days = Math.round((new Date(d + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000);
        $('#lockEmoji').textContent = '🗓';
        $('#lockTitle').textContent = '受付は試合当日にオープンします';
        // 日数だけ自動で出し、あとの文章は設定から自由に変えられるようにする
        $('#lockMsg').textContent = '試合まであと ' + days + ' 日。' +
          (state.settings.copyBeforeMsg || DEFAULT_SETTINGS.copyBeforeMsg);
      } else {
        $('#lockEmoji').textContent = '🙌';
        $('#lockTitle').textContent = '受付は終了しました';
        $('#lockMsg').textContent = 'たくさんの応援をありがとうございました！';
      }
      // スタッフだけが見えるテスト用の入り口
      $('#staffTestCheckin').classList.toggle('hidden', !readLS(LS.staff, false));
      return;
    }

    // 当日（または日付未設定）の通常表示
    var already = checkedInToday();
    if (already > 0) {
      $('#checkinBefore').classList.add('hidden');
      $('#checkinAfter').classList.remove('hidden');
      $('#checkinDoneMsg').textContent = 'この端末では、すでに ' + already + ' 名ぶんの受付が完了しています。' +
        'あとから合流した方がいる場合は、下のボタンから追加してください。';
      $('#checkinLive').textContent = summarize().liveTotal.toLocaleString('ja-JP');
    } else {
      $('#checkinBefore').classList.remove('hidden');
      $('#checkinAfter').classList.add('hidden');
      renderCheckinIdentity();
    }
  }

  function bindCheckin() {
    $('#staffTestCheckin').addEventListener('click', function () {
      checkinTestMode = true;
      renderCheckin();
    });

    $('#notMeBtn').addEventListener('click', function () {
      checkinForm.useMyEntry = false;
      resetCheckinForm();
      renderCheckinIdentity();
    });

    $('#checkinRelation').addEventListener('click', function (e) {
      var b = e.target.closest('[data-rel]');
      if (!b) return;
      checkinForm.relation = b.dataset.rel;
      resetCompanions();          // 本人のつながりが変わったら同伴者も選び直し
      renderRelationChips();
      renderCompanions();
    });

    $('#allSameBtn').addEventListener('click', function () {
      checkinForm.companionMode = 'same';
      checkinForm.companions = [];
      renderCompanions();
    });

    $('#mixedBtn').addEventListener('click', function () {
      checkinForm.companionMode = 'mixed';
      checkinForm.companions = [];
      renderCompanions();
    });

    $('#companionReset').addEventListener('click', function () {
      resetCompanions();
      renderCompanions();
    });

    $('#companionChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-crel]');
      if (!b || b.disabled) return;
      if (checkinForm.companions.length >= checkinCount - 1) return;
      checkinForm.companions.push(b.dataset.crel);
      renderCompanions();
    });

    $$('input[name="ckind"]').forEach(function (input) {
      input.addEventListener('change', function () {
        checkinForm.kind = input.value;
        markChoice($('#guestCard'));
        if (input.value === 'both') renderCheckinGoods();
        updateCheckinTotal();
      });
    });

    bindGoodsStepper($('#checkinGoodsList'), function () { return checkinForm.qty; }, updateCheckinTotal);

    $('#checkinBtn').addEventListener('click', function () {
      var btn = this;
      var errBox = $('#checkinError');
      errBox.innerHTML = '';

      var me = myEntry();
      var known = !!me && checkinForm.useMyEntry;
      var record = {
        id: uid(),
        ts: new Date().toISOString(),
        count: checkinCount,
        source: 'qr',
        device: deviceId()
      };

      // 同伴者の内訳（2名以上のときだけ）
      var need = checkinCount - 1;
      var companions = [];
      if (need > 0) {
        var rep = repRelation();
        if (!rep) return showErr(errBox, '先に、あなたと部のつながりを選んでください。');
        if (!checkinForm.companionMode) {
          return showErr(errBox, 'ご一緒の方について答えてください。全員あなたと同じなら「はい、同じ」を押してください。');
        }
        if (checkinForm.companionMode === 'same') {
          for (var i = 0; i < need; i++) companions.push(rep);
        } else {
          if (checkinForm.companions.length < need) {
            return showErr(errBox, 'ご一緒の方があと ' +
              (need - checkinForm.companions.length) + ' 名ぶん選ばれていません。');
          }
          companions = checkinForm.companions.slice(0, need);
        }
      }
      record.companions = companions;

      if (known) {
        record.entryId = me.id;
        record.name = me.name;
        record.relation = me.relation;
        record.kind = me.kind;
        record.goods = [];
        record.goodsQty = 0;
        record.goodsAmount = 0;
      } else {
        var nm = $('#checkinName').value.trim();
        if (!nm) return showErr(errBox, 'お名前を入れてください。ニックネームでもかまいません。');
        if (!checkinForm.relation) return showErr(errBox, '部とのつながりを選んでください。');
        if (!checkinForm.kind) return showErr(errBox, '今日の応援スタイルを選んでください。');
        var sel = checkinForm.kind === 'both' ? selectionFrom(checkinForm.qty) : [];
        if (checkinForm.kind === 'both' && !sel.length) {
          return showErr(errBox, 'グッズを1点以上えらんでください。（買わない場合は「現地で応援」を選んでね）');
        }
        record.entryId = '';
        record.name = nm;
        record.relation = checkinForm.relation;
        record.kind = checkinForm.kind;
        record.goods = sel;
        record.goodsQty = sel.reduce(function (a, g) { return a + g.qty; }, 0);
        record.goodsAmount = sel.reduce(function (a, g) { return a + g.price * g.qty; }, 0);
      }

      btn.disabled = true;

      Data.addCheckin(record).then(function (res) {
        rememberCheckin(checkinCount);
        var s = summarize();
        var extra = record.goodsQty
          ? 'グッズ ' + record.goodsQty + ' 点は会場で部員からお渡しします。' : '';
        $('#checkinDoneMsg').textContent = record.name + ' さん、' + checkinCount + ' 名で受付しました。' + extra +
          (checkinTestMode ? '（テストモードのため、当日の集計には含まれません）'
            : res.offline ? '（電波が弱いため端末に保存。つながり次第、自動送信されます）'
            : 'たくさんの応援ありがとうございます！');
        $('#checkinLive').textContent = s.liveTotal.toLocaleString('ja-JP');
        $('#checkinBefore').classList.add('hidden');
        $('#checkinAfter').classList.remove('hidden');
        resetCheckinForm();     // 次の人のために入力を空にしておく
        window.scrollTo(0, 0);
      }).catch(function (e) {
        showErr(errBox, '受付できませんでした：' + (e.message || e));
      }).then(function () { btn.disabled = false; });
    });

    $('#checkinMore').addEventListener('click', function () {
      resetCheckinForm();
      $('#checkinBefore').classList.remove('hidden');
      $('#checkinAfter').classList.add('hidden');
      renderCheckinIdentity();
    });
  }

  /* ==================================================================== *
   * 10. ミニゲーム
   * ==================================================================== */

  var Game = {
    instance: null,
    enter: function () {
      var canvas = $('#gameCanvas');
      if (!canvas || !window.LacrosseGame) return;
      if (!this.instance) {
        this.instance = new window.LacrosseGame(canvas, {
          onUpdate: function (st) {
            $('#gShots').textContent = st.shots;
            $('#gGoals').textContent = st.goals;
          },
          onEnd: function (st) {
            var best = readLS(LS.best, 0);
            if (st.goals > best) { writeLS(LS.best, st.goals); best = st.goals; }
            $('#gBest').textContent = best;
            $('#gameBtn').textContent = 'もう一度あそぶ';
          }
        });
      }
      $('#gBest').textContent = readLS(LS.best, 0);
      this.instance.attach();
    },
    leave: function () { if (this.instance) this.instance.stop(); }
  };

  function bindGame() {
    $('#gameBtn').addEventListener('click', function () {
      Game.enter();
      Game.instance.start();
      this.textContent = 'リセット';
    });
  }

  /* ==================================================================== *
   * 11. 部を知る／クイズ
   * ==================================================================== */

  function parseQuiz(text) {
    return String(text || '').split('\n').map(function (line) {
      var p = line.split('|');
      if (p.length < 2 || !p[0].trim()) return null;
      return {
        q: p[0].trim(),
        a: /^(◯|○|o|O|maru|true|正)/.test(p[1].trim()),
        expl: (p[2] || '').trim()
      };
    }).filter(Boolean);
  }

  function parseFacts(text) {
    return String(text || '').split('\n').map(function (line) {
      var m = line.split(/[:：]/);
      if (!line.trim()) return null;
      if (m.length < 2) return { k: '', v: line.trim() };
      return { k: m[0].trim(), v: m.slice(1).join('：').trim() };
    }).filter(Boolean);
  }

  var quizAnswered = {};

  function renderTeam() {
    var s = state.settings;
    $('#teamHeading').textContent = (s.teamName || 'ラクロス部') + ' のこと';
    $('#introLead').textContent = s.introLead || '';
    $('#introBody').textContent = s.introBody || '';
    $('#introFacts').innerHTML = parseFacts(s.introFacts).map(function (f) {
      return '<div class="fact"><span class="k">' + esc(f.k) + '</span><span>' + esc(f.v) + '</span></div>';
    }).join('');

    var quiz = parseQuiz(s.quiz);
    $('#quizList').innerHTML = quiz.map(function (q, i) {
      return '<div class="quiz-q" data-qi="' + i + '">' +
        '<div class="q">Q' + (i + 1) + '. ' + esc(q.q) + '</div>' +
        '<div class="ans"><button type="button" data-a="1">◯</button><button type="button" data-a="0">×</button></div>' +
        '<div class="expl">' + esc(q.expl) + '</div></div>';
    }).join('');

    $('#quizResult').classList.add('hidden');
    quizAnswered = {};

    $('#quizList').onclick = function (e) {
      var btn = e.target.closest('button[data-a]');
      if (!btn) return;
      var card = btn.closest('.quiz-q');
      if (card.classList.contains('answered')) return;
      var idx = Number(card.dataset.qi);
      var picked = btn.dataset.a === '1';
      var correct = picked === quiz[idx].a;
      card.classList.add('answered');
      btn.classList.add(correct ? 'correct' : 'wrong');
      if (!correct) {
        $$('button[data-a]', card).forEach(function (b) {
          if ((b.dataset.a === '1') === quiz[idx].a) b.classList.add('correct');
        });
      }
      quizAnswered[idx] = correct;
      if (Object.keys(quizAnswered).length === quiz.length) showQuizResult(quiz.length);
    };
  }

  function showQuizResult(total) {
    var right = Object.keys(quizAnswered).filter(function (k) { return quizAnswered[k]; }).length;
    var box = $('#quizResult');
    box.classList.remove('hidden');
    $('#quizScore').textContent = total + '問中 ' + right + '問 正解！';
    $('#quizEmoji').textContent = right === total ? '🏆' : right >= total / 2 ? '🎉' : '🥍';
    $('#quizComment').textContent = right === total
      ? 'ラクロス通！ぜひ当日、周りの人にも解説してあげてください。'
      : '知ってから見ると、試合が何倍も面白くなります。当日ぜひ現地で！';
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ==================================================================== *
   * 12. スタッフページ
   * ==================================================================== */

  function bindStaff() {
    // スタッフページはタブバーに出していない。
    // 入り口は「URL に #/staff を付ける」か「右上のバッジを5回続けてタップ」の2通り。
    var taps = 0, tapTimer = null;
    $('#syncDot').addEventListener('click', function () {
      taps++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () { taps = 0; }, 1200);
      if (taps >= 5) { taps = 0; go('staff'); }
    });

    $('#pinBtn').addEventListener('click', function () {
      var v = $('#pinInput').value.trim();
      if (v && v === String(state.settings.staffPin)) {
        writeLS(LS.staff, true);
        openStaff();
      } else {
        $('#pinError').innerHTML = '<div class="notice err">PINが違うようです。</div>';
      }
    });
    $('#pinInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('#pinBtn').click();
    });
    $('#staffLockBtn').addEventListener('click', function () {
      writeLS(LS.staff, false);
      $('#staffMain').classList.add('hidden');
      $('#staffLock').classList.remove('hidden');
      $('#pinInput').value = '';
    });

    $$('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.tabs button').forEach(function (x) { x.classList.toggle('is-active', x === b); });
        $$('.panel').forEach(function (p) { p.classList.toggle('is-active', p.dataset.panel === b.dataset.panel); });
        if (b.dataset.panel === 'qr') renderQrPreview();
        if (b.dataset.panel === 'config') fillConfigForm();
        if (b.dataset.panel === 'list') renderEntryTable();
        if (b.dataset.panel === 'dash') renderDashboard();
        if (b.dataset.panel === 'count') renderCounter();
        window.scrollTo(0, 0);
      });
    });

    $('#refreshBtn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = '更新中…';
      Data.flushPending()
        .then(function () { return Data.load(); })
        .then(function () { renderDashboard(); renderHome(); })
        .then(function () { btn.disabled = false; btn.textContent = '🔄 最新に更新'; });
    });

    // 手動カウント
    $$('.counter-pad button').forEach(function (b) {
      b.addEventListener('click', function () {
        var delta = Number(b.dataset.delta);
        var s = summarize();
        if (delta < 0 && s.manualCount + delta < 0) delta = -s.manualCount;
        if (delta === 0) return;
        var record = { id: uid(), ts: new Date().toISOString(), count: delta, source: 'manual', device: deviceId() };
        Data.addCheckin(record).then(function () { renderCounter(); renderDashboard(); });
      });
    });

    $('#csvEntries').addEventListener('click', exportEntriesCsv);
    $('#csvCheckins').addEventListener('click', exportCheckinsCsv);

    $('#qrUrl').addEventListener('input', renderQrPreview);
    $('#qrTwoPages').addEventListener('change', function () {
      this.closest('.choice').classList.toggle('is-on', this.checked);
    });

    $('#cAllowShipping').addEventListener('change', function () {
      $('#shipToggleLabel').classList.toggle('is-on', this.checked);
      $('#shippingFeeField').classList.toggle('hidden', !this.checked);
    });
    $('#printBtn').addEventListener('click', printPosters);
    $('#downloadQr').addEventListener('click', downloadQrSvg);

    $('#addGoods').addEventListener('click', function () { addGoodsRow({ id: 'g' + uid(), name: '', price: 0 }); });
    $('#saveConfig').addEventListener('click', saveConfigForm);
    $('#testGas').addEventListener('click', testConnection);
    $('#exportConfig').addEventListener('click', exportConfigJson);

    $('#clearLocal').addEventListener('click', function () {
      var msg = isRemote()
        ? 'この端末に残っている下書き・未送信データを消します。スプレッドシート側のデータは消えません。よろしいですか？'
        : 'この端末に保存されているエントリーとチェックインをすべて消します。元に戻せません。よろしいですか？';
      if (!confirm(msg)) return;
      Data.clearLocal();
      $('#configMsg').innerHTML = '<div class="notice ok">端末内のデータを消しました。</div>';
      renderDashboard();
      renderCounter();
      renderEntryTable();
      renderHome();
      refreshSyncBadge();
    });
  }

  function openStaff() {
    $('#staffLock').classList.add('hidden');
    $('#staffMain').classList.remove('hidden');
    renderDashboard();
    renderCounter();
  }

  function renderStaff() {
    if (readLS(LS.staff, false)) openStaff();
    var active = $('.tabs button.is-active');
    var panel = active ? active.dataset.panel : 'dash';
    if (panel === 'dash') renderDashboard();
    if (panel === 'count') renderCounter();
    if (panel === 'list') renderEntryTable();
    if (panel === 'qr') renderQrPreview();
    if (panel === 'config') fillConfigForm();
  }

  /* ---------------------------- 円グラフ ---------------------------- */

  var DONUT_COLORS = ['#9ec91f', '#37b7ec', '#ff6b5e', '#ffc94d', '#9b7fe8', '#1b3163', '#3fbf8f', '#e0699f'];

  /**
   * ドーナツ型の円グラフを描く。
   * 色だけに頼らないよう、凡例に人数と割合も並べて出す。
   */
  function renderDonut(chartEl, legendEl, counts, centerLabel) {
    var keys = Object.keys(counts).filter(function (k) { return counts[k] > 0; });
    var total = keys.reduce(function (a, k) { return a + counts[k]; }, 0);

    if (!total) {
      chartEl.innerHTML = '';
      legendEl.innerHTML = '<p class="hint mb0">まだエントリーがありません。最初のひとりを待っています。</p>';
      return;
    }
    // 多い順に並べる
    keys.sort(function (a, b) { return counts[b] - counts[a]; });

    var cx = 66, cy = 66, R = 60, r = 38;
    var pos = function (radius, ang) {
      return [(cx + radius * Math.cos(ang)).toFixed(2), (cy + radius * Math.sin(ang)).toFixed(2)];
    };

    var paths = [];
    var angle = -Math.PI / 2;
    keys.forEach(function (k, i) {
      var frac = counts[k] / total;
      var color = DONUT_COLORS[i % DONUT_COLORS.length];

      if (frac > 0.9999) {
        // 1種類だけのときは円弧が閉じないので、リングを2つの半円で描く
        paths.push('<path d="M' + pos(R, 0).join(' ') + 'A' + R + ' ' + R + ' 0 1 1 ' + pos(R, Math.PI).join(' ') +
          'A' + R + ' ' + R + ' 0 1 1 ' + pos(R, 0).join(' ') + 'Z' +
          'M' + pos(r, 0).join(' ') + 'A' + r + ' ' + r + ' 0 1 0 ' + pos(r, Math.PI).join(' ') +
          'A' + r + ' ' + r + ' 0 1 0 ' + pos(r, 0).join(' ') + 'Z" fill="' + color + '" fill-rule="evenodd"/>');
        return;
      }

      var end = angle + frac * Math.PI * 2;
      var large = frac > 0.5 ? 1 : 0;
      paths.push('<path d="M' + pos(R, angle).join(' ') +
        'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + pos(R, end).join(' ') +
        'L' + pos(r, end).join(' ') +
        'A' + r + ' ' + r + ' 0 ' + large + ' 0 ' + pos(r, angle).join(' ') +
        'Z" fill="' + color + '"/>');
      angle = end;
    });

    chartEl.innerHTML = '<svg viewBox="0 0 132 132" role="img" aria-label="内訳の円グラフ">' +
      paths.join('') + '</svg>' +
      '<div class="mid"><b>' + total + '</b><small>' + esc(centerLabel || '件') + '</small></div>';

    legendEl.innerHTML = keys.map(function (k, i) {
      var v = counts[k];
      return '<div class="li">' +
        '<span class="sw" style="background:' + DONUT_COLORS[i % DONUT_COLORS.length] + '"></span>' +
        '<span class="nm">' + esc(k) + '</span>' +
        '<span class="vl">' + v + '</span>' +
        '<span class="pc">' + Math.round(v / total * 100) + '%</span>' +
        '</div>';
    }).join('');
  }

  function bars(obj, colorClass) {
    var keys = Object.keys(obj);
    if (!keys.length) return '<p class="hint">まだデータがありません。</p>';
    var max = Math.max.apply(null, keys.map(function (k) {
      return typeof obj[k] === 'object' ? obj[k].qty : obj[k];
    }));
    return keys.map(function (k) {
      var v = typeof obj[k] === 'object' ? obj[k].qty : obj[k];
      var extra = typeof obj[k] === 'object' ? '（' + yen(obj[k].amount) + '）' : '';
      return '<div class="meter"><div class="row"><span class="name">' + esc(k) + '</span>' +
        '<span class="val">' + v + extra + '</span></div>' +
        '<div class="bar ' + (colorClass || '') + '"><span style="width:' + (v / max * 100) + '%"></span></div></div>';
    }).join('');
  }

  /**
   * 「開いた → エントリー画面まで来た → 送信した」の流れを表示する。
   * どこで止まっているかが分かれば、打ち手が変わる。
   */
  function renderFunnel(s) {
    var v = state.views;
    var box = $('#funnel');
    var note = $('#funnelNote');

    if (!v) {
      box.innerHTML = '<p class="hint mb0">まだ記録がありません。' +
        '（この機能を入れる前のアクセスは数えられていません）</p>';
      note.innerHTML = '';
      return;
    }

    var opened = v.devices || 0;                                   // アプリを開いた端末数
    var reached = (v.deviceByView && v.deviceByView.entry) || 0;   // エントリー画面まで来た端末数
    var sent = s.entryCount;                                       // 実際に送信された件数

    var steps = [
      { label: 'アプリを開いた', n: opened, unit: '人' },
      { label: 'エントリー画面を見た', n: reached, unit: '人' },
      { label: 'エントリーを送信した', n: sent, unit: '件' }
    ];
    var max = Math.max(1, opened);

    box.innerHTML = steps.map(function (st, i) {
      var pct = Math.round(st.n / max * 100);
      var rate = (i > 0 && steps[i - 1].n > 0)
        ? '<span class="pc">前の段階の ' + Math.round(st.n / steps[i - 1].n * 100) + '%</span>' : '';
      return '<div class="meter"><div class="row">' +
        '<span class="name">' + esc(st.label) + '</span>' +
        '<span class="val"><b>' + st.n + '</b> ' + st.unit + '</span></div>' +
        '<div class="bar sky"><span style="width:' + Math.min(100, pct) + '%"></span></div>' +
        (rate ? '<div class="goal-note">' + rate + '</div>' : '') +
        '</div>';
    }).join('');

    // 数字の読み方を、そのまま打ち手に変換して伝える
    var msg;
    if (opened === 0) {
      msg = '<div class="notice">まだ誰もアプリを開いていません。<strong>告知が届いていない可能性</strong>が高いです。' +
        '送り先や送る時間帯を変えてみてください。</div>';
    } else if (opened < 5) {
      msg = '<div class="notice">開いた人がまだ少ないです。<strong>告知の量を増やす段階</strong>です。' +
        'SNSや別のグループにも広げてみてください。</div>';
    } else if (reached === 0) {
      msg = '<div class="notice">アプリは見られていますが、<strong>エントリー画面まで進んでいません</strong>。' +
        '告知文に、エントリーのリンクを直接（末尾が <code>#/entry</code> のもの）貼ってみてください。</div>';
    } else if (sent === 0) {
      msg = '<div class="notice err">エントリー画面までは来ているのに、<strong>送信されていません</strong>。' +
        '入力項目が多い、または途中でつまずいている可能性があります。実際に自分で入力して確かめてください。</div>';
    } else if (reached > 0 && sent / reached < 0.3) {
      msg = '<div class="notice">見た人のうち、送信まで進んだのは ' + Math.round(sent / reached * 100) + '% です。' +
        '見に来てはいるので、<strong>あと一押しの文言</strong>が効くかもしれません。</div>';
    } else {
      msg = '<div class="notice ok">見た人がしっかりエントリーまで進んでいます。' +
        '<strong>あとは見てくれる人を増やすほど伸びます。</strong></div>';
    }
    note.innerHTML = msg;
  }

  function renderDashboard() {
    var s = summarize();
    $('#dashLive').textContent = s.liveTotal.toLocaleString('ja-JP');
    $('#dashQr').textContent = s.qrCount.toLocaleString('ja-JP');
    $('#dashManual').textContent = s.manualCount.toLocaleString('ja-JP');
    $('#dashRate').textContent = s.onsitePeople > 0
      ? Math.round(s.liveTotal / s.onsitePeople * 100) + '%'
      : '-';

    // 集計から外した記録があれば必ず知らせる（黙って除外しない）
    var off = $('#dashOffDay');
    if (s.offDayRecords > 0) {
      off.innerHTML = '<div class="notice mt">試合当日（' + esc(state.settings.eventDate) + '）以外に記録された受付が ' +
        s.offDayRecords + ' 件（' + s.offDayCount + ' 名ぶん）あります。<br>' +
        '誤タップやテストとみなして<strong>上の合計には含めていません</strong>。' +
        'これも数えたい場合は、設定の「日付」を確認するか、手動カウントで足してください。</div>';
    } else if (!state.settings.eventDate) {
      off.innerHTML = '<div class="notice mt">設定に試合の<strong>日付が入っていません</strong>。' +
        'いま記録された受付は、日付にかかわらずすべて合計に入ります。' +
        '当日前の誤タップを防ぐため、日付を設定しておくことをおすすめします。</div>';
    } else {
      off.innerHTML = '';
    }

    $('#dashEntries').textContent = s.entryCount.toLocaleString('ja-JP');
    $('#dashOnsite').textContent = s.onsitePeople.toLocaleString('ja-JP');
    $('#dashGoodsCnt').textContent = s.goodsEntries.toLocaleString('ja-JP');
    $('#dashCheer').textContent = s.cheerOnly.toLocaleString('ja-JP');
    $('#dashGoodsQty').textContent = s.goodsQty.toLocaleString('ja-JP');
    $('#dashGoodsAmt').textContent = yen(s.goodsAmount);
    // 配送を受け付けていない運用では、配送希望の欄は意味がないので出さない
    $('#dashShipCnt').textContent = s.shipCount.toLocaleString('ja-JP');
    $('#dashShipCnt').closest('.stat').classList.toggle('hidden', !shippingEnabled() && s.shipCount === 0);

    renderFunnel(s);
    renderDonut($('#arrivalSelfDonut'), $('#arrivalSelfLegend'), s.byArrivalSelf, '人が受付');
    renderDonut($('#arrivalCompDonut'), $('#arrivalCompLegend'), s.byArrivalCompanion, '名が同伴');
    $('#dashTurnout').textContent = s.turnout === null ? '-' : s.turnout + '%';
    $('#dashAttended').textContent = s.attendedEntries + '/' + s.expectedEntries;
    $('#dashArrivalGoods').textContent = s.arrivalGoodsQty + '点';

    $('#dashGoodsBreak').innerHTML = bars(s.byGoods, 'coral');
    renderDonut($('#dashDonut'), $('#dashDonutLegend'), s.byRelation, '人がエントリー');
  }

  function renderCounter() {
    var s = summarize();
    $('#manualCount').textContent = s.manualCount.toLocaleString('ja-JP');
    $('#countTotal').textContent = s.liveTotal.toLocaleString('ja-JP');
  }

  var KIND_LABEL = { onsite: '現地', goods: 'グッズ', both: '現地＋グッズ', cheer: 'メッセージ' };
  var DELIV_LABEL = { onsite: '会場受取', ship: '配送', '': '-' };

  function renderEntryTable() {
    var entries = allEntries().slice().sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });
    var tbody = $('#entryTable tbody');
    tbody.innerHTML = entries.map(function (e) {
      return '<tr>' +
        '<td>' + esc(fmtTime(e.ts)) + '</td>' +
        '<td>' + esc(e.name) + '</td>' +
        '<td>' + esc(KIND_LABEL[e.kind] || e.kind) + '</td>' +
        '<td class="num">' + (e.headcount || 0) + '</td>' +
        '<td class="num">' + (e.goodsQty || 0) + '</td>' +
        '<td class="num">' + yen(e.total || 0) + '</td>' +
        '<td>' + esc(DELIV_LABEL[e.delivery] || '-') + '</td>' +
        '<td>' + esc(e.relation || '') + '</td>' +
        '</tr>';
    }).join('');
    $('#listEmptyNote').textContent = entries.length ? '合計 ' + entries.length + ' 件' : 'まだエントリーがありません。';
    renderCheckinTable();
  }

  function renderCheckinTable() {
    var rows = allCheckins()
      .filter(function (c) { return c.source !== 'manual' && isCountableCheckin(c); })
      .sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });

    $('#checkinTable tbody').innerHTML = rows.map(function (c) {
      return '<tr>' +
        '<td>' + esc(fmtTime(c.ts)) + '</td>' +
        '<td>' + esc(c.name || '（不明）') + '</td>' +
        '<td>' + esc(c.relation || '-') + '</td>' +
        '<td>' + esc((c.companions || []).join('、') || '-') + '</td>' +
        '<td>' + esc(KIND_LABEL[c.kind] || '-') + '</td>' +
        '<td class="num">' + (c.count || 0) + '</td>' +
        '<td class="num">' + (c.goodsQty || 0) + '</td>' +
        '<td>' + (c.entryId ? '<span class="badge lime">あり</span>' : '<span class="badge">当日</span>') + '</td>' +
        '</tr>';
    }).join('');

    var total = rows.reduce(function (a, c) { return a + (Number(c.count) || 0); }, 0);
    $('#checkinListNote').textContent = rows.length
      ? rows.length + ' 件 / ' + total + ' 名（手動カウント分は含みません）'
      : 'まだ受付がありません。';
  }

  function downloadFile(filename, text, mime) {
    var blob = new Blob(['﻿' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportEntriesCsv() {
    var goods = state.settings.goods || [];
    var head = ['受付日時', 'お名前', 'つながり', '応援種別', '来場人数', 'グッズ点数', 'グッズ小計', '送料', '合計', '受取方法', 'メッセージ']
      .concat(goods.map(function (g) { return g.name; }));
    var rows = allEntries().map(function (e) {
      var map = {};
      (e.goods || []).forEach(function (g) { map[g.id] = g.qty; });
      return [e.ts, e.name, e.relation, KIND_LABEL[e.kind] || e.kind, e.headcount || 0,
        e.goodsQty || 0, e.goodsAmount || 0, e.shipping || 0, e.total || 0,
        DELIV_LABEL[e.delivery] || '', e.message || '']
        .concat(goods.map(function (g) { return map[g.id] || 0; }));
    });
    var csv = [head].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    downloadFile('エントリー一覧_' + todayStr() + '.csv', csv);
  }

  function exportCheckinsCsv() {
    var goods = state.settings.goods || [];
    var head = ['日時', 'お名前', 'つながり', '同伴者の内訳', '応援スタイル', '人数', 'グッズ点数', 'グッズ金額',
      '事前エントリー', '記録方法', '集計対象', '端末']
      .concat(goods.map(function (g) { return g.name; }));
    var rows = allCheckins().map(function (c) {
      var map = {};
      (c.goods || []).forEach(function (g) { map[g.id] = g.qty; });
      return [c.ts, c.name || '', c.relation || '', (c.companions || []).join('、'), KIND_LABEL[c.kind] || '',
        c.count, c.goodsQty || 0, c.goodsAmount || 0,
        c.entryId ? 'あり' : '', c.source === 'manual' ? '手動' : 'QR',
        isCountableCheckin(c) ? '対象' : '対象外', c.device || '']
        .concat(goods.map(function (g) { return map[g.id] || 0; }));
    });
    var csv = [head].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    downloadFile('チェックイン記録_' + todayStr() + '.csv', csv);
  }

  /* ---------------------------- QRポスター ---------------------------- */

  function baseUrl() {
    var v = ($('#qrUrl') && $('#qrUrl').value.trim()) || '';
    if (!v) v = location.href.split('#')[0];
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
    return v.replace(/#.*$/, '');
  }

  function renderQrPreview() {
    var url = baseUrl() + '#/checkin';
    var box = $('#qrPreview');
    try {
      box.innerHTML = QRCode.toSvg(url, { quiet: 3 });
      $('#qrUrlEcho').textContent = url;
    } catch (e) {
      box.innerHTML = '<div class="notice err">' + esc(e.message) + '</div>';
      $('#qrUrlEcho').textContent = '';
    }
  }

  function posterPage(opts) {
    var s = state.settings;
    var svg;
    try { svg = QRCode.toSvg(opts.url, { quiet: 2 }); }
    catch (e) { svg = '<p>' + esc(e.message) + '</p>'; }
    var when = '';
    if (s.eventDate) {
      var d = new Date(s.eventDate + 'T00:00:00');
      when = (d.getMonth() + 1) + '/' + d.getDate() + (s.startTime ? ' ' + s.startTime + '〜' : '');
    }
    return '<div class="poster-page">' +
      '<div class="p-kicker">' + esc(opts.kicker) + '</div>' +
      '<div class="p-title">' + esc(opts.title) + '</div>' +
      '<div class="p-sub">' + esc(opts.sub) + '</div>' +
      '<div class="p-qr">' + svg + '</div>' +
      '<div class="p-steps">' + opts.steps.map(function (t, i) { return (i + 1) + '. ' + esc(t); }).join('<br>') + '</div>' +
      '<div class="p-url">' + esc(opts.url) + '</div>' +
      '<div class="p-foot">' + esc([s.teamName, s.eventName, when, s.venue].filter(Boolean).join('　/　')) + '</div>' +
      '</div>';
  }

  function printPosters() {
    var url = baseUrl();
    var pages = [posterPage({
      kicker: 'WELCOME MATCH',
      title: 'ここでチェックイン',
      sub: 'スマホのカメラでQRを読み取ってください',
      url: url + '#/checkin',
      steps: ['カメラアプリでこのQRを写す', '「来場しました！」をタップ', '受付完了です。ありがとうございます！']
    })];

    if ($('#qrTwoPages').checked) {
      pages.push(posterPage({
        kicker: '事前エントリー受付中',
        title: '応援、きかせて。',
        sub: '現地応援 or グッズ購入応援を選ぶだけ',
        url: url + '#/entry',
        steps: ['カメラアプリでこのQRを写す', '応援の仕方をえらぶ', '当日の楽しみ方もチェック！']
      }));
    }

    $('#poster').innerHTML = pages.join('');
    window.print();
  }

  function downloadQrSvg() {
    try {
      var url = baseUrl() + '#/checkin';
      downloadFile('checkin-qr.svg', QRCode.toSvg(url, { quiet: 4 }), 'image/svg+xml');
    } catch (e) {
      alert(e.message);
    }
  }

  /* ------------------------------ 設定 ------------------------------ */

  function addGoodsRow(g) {
    var row = document.createElement('div');
    row.className = 'grow';
    row.innerHTML = '<input type="text" placeholder="商品名" value="' + esc(g.name) + '">' +
      '<input type="number" placeholder="価格" min="0" step="10" value="' + (Number(g.price) || 0) + '">' +
      '<button type="button" class="del" aria-label="削除">✕</button>';
    row.dataset.id = g.id;
    row.querySelector('.del').addEventListener('click', function () { row.remove(); });
    $('#goodsEditor').appendChild(row);
  }

  function fillConfigForm() {
    var s = state.settings;
    $('#cTeam').value = s.teamName || '';
    $('#cEvent').value = s.eventName || '';
    $('#cOpponent').value = s.opponent || '';
    $('#cDate').value = s.eventDate || '';
    $('#cTime').value = s.startTime || '';
    $('#cVenue').value = s.venue || '';
    $('#cVenueUrl').value = s.venueUrl || '';
    $('#cGoalOnsite').value = s.goalOnsite || 100;
    $('#cGoalGoods').value = s.goalGoods || 60;
    $('#cAllowShipping').checked = s.allowShipping === true;
    $('#shipToggleLabel').classList.toggle('is-on', s.allowShipping === true);
    $('#shippingFeeField').classList.toggle('hidden', s.allowShipping !== true);
    $('#cShipping').value = s.shipping || 0;
    $('#cCopyMeter').value = s.copyMeterTitle || '';
    $('#cCopyNameEx').value = s.copyNameExample || '';
    $('#cCopyEntry').value = s.copyEntryLead || '';
    $('#cCopyCheckin').value = s.copyCheckinLead || '';
    $('#cCopyBefore').value = s.copyBeforeMsg || '';
    $('#cIntroLead').value = s.introLead || '';
    $('#cIntroBody').value = s.introBody || '';
    $('#cIntroFacts').value = s.introFacts || '';
    $('#cQuiz').value = s.quiz || '';
    $('#cGasUrl').value = s.gasUrl || '';
    $('#cAdminKey').value = s.adminKey || '';
    $('#cPin').value = s.staffPin || '';

    // 初期のままのPINは公開コードから分かってしまうため、変更をうながす
    $('#pinWarn').innerHTML = (s.staffPin === DEFAULT_SETTINGS.staffPin)
      ? '<div class="notice">⚠ PINが初期値のままです。アプリのコードは公開されているため、' +
        '初期値は誰でも調べられます。<strong>別の数字に変更してください。</strong></div>'
      : '';

    // 接続先がどこから来ているのかを明示する
    var fileUrl = (FILE_CONFIG.gasUrl || '').trim();
    var src = $('#gasSource');
    if (s.gasUrl && s.gasUrl.trim()) {
      src.innerHTML = '<div class="notice">この端末の設定を使用中です。' +
        (fileUrl ? '公開ファイルの設定より優先されています。' : '') + '</div>';
    } else if (fileUrl) {
      src.innerHTML = '<div class="notice ok">公開ファイル（assets/config.js）の設定を使用中です。<br>' +
        esc(fileUrl) + '</div>';
    } else {
      src.innerHTML = '<div class="notice">まだどこにも接続先が設定されていません。データはこの端末の中だけに保存されます。</div>';
    }
    $('#goodsEditor').innerHTML = '';
    (s.goods || []).forEach(addGoodsRow);
    if (!(s.goods || []).length) addGoodsRow({ id: 'g' + uid(), name: '', price: 0 });
  }

  function collectConfig() {
    var goods = $$('#goodsEditor .grow').map(function (row) {
      var inputs = row.querySelectorAll('input');
      return { id: row.dataset.id, name: inputs[0].value.trim(), price: Number(inputs[1].value) || 0 };
    }).filter(function (g) { return g.name; });

    return Object.assign({}, state.settings, {
      teamName: $('#cTeam').value.trim(),
      eventName: $('#cEvent').value.trim(),
      opponent: $('#cOpponent').value.trim(),
      eventDate: $('#cDate').value,
      startTime: $('#cTime').value,
      venue: $('#cVenue').value.trim(),
      venueUrl: $('#cVenueUrl').value.trim(),
      goalOnsite: Math.max(1, Number($('#cGoalOnsite').value) || 100),
      goalGoods: Math.max(1, Number($('#cGoalGoods').value) || 60),
      allowShipping: $('#cAllowShipping').checked,
      shipping: Math.max(0, Number($('#cShipping').value) || 0),
      goods: goods,
      copyMeterTitle: $('#cCopyMeter').value.trim(),
      copyNameExample: $('#cCopyNameEx').value.trim(),
      copyEntryLead: $('#cCopyEntry').value.trim(),
      copyCheckinLead: $('#cCopyCheckin').value.trim(),
      copyBeforeMsg: $('#cCopyBefore').value.trim(),
      introLead: $('#cIntroLead').value,
      introBody: $('#cIntroBody').value,
      introFacts: $('#cIntroFacts').value,
      quiz: $('#cQuiz').value,
      gasUrl: $('#cGasUrl').value.trim(),
      adminKey: $('#cAdminKey').value.trim(),
      staffPin: $('#cPin').value.trim() || '2468'
    });
  }

  function saveConfigForm() {
    var box = $('#configMsg');
    var btn = $('#saveConfig');
    btn.disabled = true;
    btn.textContent = '保存中…';
    var next = collectConfig();
    var urlChanged = next.gasUrl !== state.settings.gasUrl;
    Data.saveSettings(next).then(function () {
      box.innerHTML = '<div class="notice ok">保存しました。' +
        (isRemote() ? '他の端末にも反映されます。' : 'この端末に保存しました。') + '</div>';
      // 保存先を切り替えたときは、その場で最新データを読み直す
      if (urlChanged) return Data.load().then(renderDashboard);
    }).catch(function (e) {
      box.innerHTML = '<div class="notice err">スプレッドシートへの保存に失敗しました（' +
        esc(e.message || e) + '）。この端末には保存されています。</div>';
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '設定を保存';
      renderHero();
      applyCopy();
      renderGoodsPicker();
      renderTeam();
      renderQrPreview();
      refreshSyncBadge();
    });
  }

  function testConnection() {
    var box = $('#configMsg');
    var url = $('#cGasUrl').value.trim() || (FILE_CONFIG.gasUrl || '').trim();
    if (!url) {
      box.innerHTML = '<div class="notice">接続先が設定されていないので、この端末だけに保存するモードです。' +
        'assets/config.js か上の欄にURLを入れてください。</div>';
      return;
    }
    box.innerHTML = '<div class="notice">接続を確認しています…</div>';
    var saved = state.settings.gasUrl;
    state.settings.gasUrl = url;
    gasGet({ action: 'ping' }).then(function (r) {
      if (r && r.ok) {
        var warn = r.adminKeySet
          ? ''
          : '<div class="notice">⚠ <strong>設定用の合言葉がまだ未設定です。</strong>今は誰でも設定を書き換えられる状態です。' +
            '<code>gas/Code.gs</code> の <code>ADMIN_KEY</code> に言葉を入れて、デプロイし直してください。</div>';
        box.innerHTML = '<div class="notice ok">つながりました！（シート：' + esc(r.sheet || '-') +
          ' / エントリー ' + (r.entries || 0) + '件）「設定を保存」を押してください。</div>' + warn;
      } else {
        throw new Error((r && r.error) || '想定外の応答です');
      }
    }).catch(function (e) {
      box.innerHTML = '<div class="notice err">つながりませんでした：' + esc(e.message || e) +
        '<br>URLの末尾が <code>/exec</code> か、アクセス権が「全員」になっているか確認してください。</div>';
    }).then(function () {
      state.settings.gasUrl = saved;
    });
  }

  function exportConfigJson() {
    downloadFile('設定_' + todayStr() + '.json', JSON.stringify(collectConfig(), null, 2), 'application/json');
  }

  /* ==================================================================== *
   * 13. 起動
   * ==================================================================== */

  function autoRefresh() {
    setInterval(function () {
      if (document.hidden || !isRemote()) return;
      if (currentView !== 'home' && currentView !== 'staff') return;
      Data.flushPending().then(function () { return Data.load(); }).then(function () {
        if (currentView === 'home') renderHome();
        if (currentView === 'staff') { renderDashboard(); renderCounter(); }
      });
    }, 20000);

    window.addEventListener('online', function () {
      Data.flushPending().then(function () { return Data.load(); }).then(renderHome);
    });
  }

  function init() {
    bindNav();
    bindMessages();
    bindEntry();
    bindCheckin();
    bindGame();
    bindStaff();

    renderHero();
    applyCopy();
    renderGoodsPicker();
    renderTeam();
    refreshSyncBadge();

    var start = (location.hash || '').replace(/^#\/?/, '') || 'home';
    go(start);

    Data.load().then(function () {
      return Data.flushPending();
    }).then(function () {
      renderHero();
      applyCopy();
      renderGoodsPicker();
      renderTeam();
      renderHome();
      // データを読み終えてから描き直す（読み込み前の 0 が残らないように）
      if (currentView === 'checkin') renderCheckin();
      if (currentView === 'staff') renderStaff();
    });

    autoRefresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
