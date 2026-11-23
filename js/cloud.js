/*
 * 雲端連線與 Google 登入（InvCloud）
 * ---------------------------------------------------------------
 * 流程：開啟網頁 → 沒有有效登入就只顯示登入畫面 → 「使用 Google 登入」→ 把 Google 的身分憑證交給雲端後端驗證
 *   → 後端確認這個 Gmail 在管理員設定的名單內，發一組工作階段（30 天，使用中自動延長）→ 之後每次讀寫雲端都帶這組工作階段。
 * 角色、部門、可用頁面由管理員在「帳號／權限管理」設定，存在雲端後端；後端會依登入者過濾發票、檢查簽核順序，
 * 不在名單的人拿不到任何資料。
 *
 * config.js 設定：
 *   window.INV_AUTH  = { clientId: 'Google OAuth 用戶端 ID' }   （本機測試時另有 mock: true）
 *   window.INV_CLOUD = { url: 'Apps Script 網頁應用程式網址（結尾 /exec）' }
 *
 * 這裡存的登入狀態（localStorage 'inv_auth'）：{ s: 工作階段, exp, email, name, role, dept, pages, positions }
 */
(function (root) {
  'use strict';

  var KEY = 'inv_auth';
  var cfg = root.INV_AUTH || {};
  var enabled = !!cfg.clientId;
  var cloudUrl = function () { return ((root.INV_CLOUD || {}).url || '').trim(); };
  var state = null, busy = false, gsiPromise = null, wasReady = false, resolveReady;
  var meListeners = [], deniedListeners = [];
  var ready = new Promise(function (r) { resolveReady = r; });

  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function $(id) { return document.getElementById(id); }
  function emit(list, arg) { list.forEach(function (fn) { try { fn(arg); } catch (e) { console.error(e); } }); }

  // ---------- 儲存 ----------
  // 公務機模式（使用者 2026-11-23：生產組用公務機，「選姓名再填 PIN 碼」；公務機先用一個公司 Gmail 登入一次；用公務機登入的人只能提出申請和看自己的單）：
  // 公務機帳號登入後不進系統，只顯示「選姓名」畫面；選好姓名、輸入 PIN，後端發一組短效的個人工作階段，存在這個分頁的 sessionStorage（關掉分頁就沒了），頁面重新載入後就是那位同事的畫面。
  // 閒置 5 分鐘、送出申請後、按「換人」都會自動回到選姓名畫面（並清掉這台裝置上的資料快取）。
  var ACT_KEY = 'inv_dev_act', IDLE_MS = 300000, idleTimer = null, warnTimer = null, subTimer = null;
  function loadAct() {
    try { var d = JSON.parse(sessionStorage.getItem(ACT_KEY) || 'null'); if (isObj(d) && d.s && d.email) { if (d.exp > Date.now() + 30000) return d; sessionStorage.removeItem(ACT_KEY); } } catch (e) {}
    return null;
  }
  function load() {
    var act = loadAct(); if (act) return act;
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (isObj(s) && s.s && s.exp > Date.now() + 60000 && s.email) return s;
    } catch (e) {}
    return null;
  }
  function persist() { try { if (state && state.act) sessionStorage.setItem(ACT_KEY, JSON.stringify(state)); else localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function clearStored() { var wasAct = !!(state && state.act); state = null; try { if (wasAct) sessionStorage.removeItem(ACT_KEY); else localStorage.removeItem(KEY); } catch (e) {} }

  function user() { return state ? { viaDevice: !!state.act, email: state.email, name: state.name, role: state.role, dept: state.dept || '', pages: Array.isArray(state.pages) ? state.pages : null, positions: Array.isArray(state.positions) ? state.positions : [] } : null; }

  // 雲端回應帶來最新的人員資料（名字、角色、部門、頁面）與延長後的工作階段
  function applyMe(j) {
    if (!state || !isObj(j)) return;
    var changed = false, perm = false;
    if (isObj(j.me)) {
      ['name', 'role', 'dept'].forEach(function (k) {
        var v = j.me[k] == null ? '' : j.me[k];
        if (v !== (state[k] == null ? '' : state[k])) { state[k] = v; changed = perm = true; }
      });
      var np = Array.isArray(j.me.pages) ? j.me.pages : null;
      if (JSON.stringify(np) !== JSON.stringify(state.pages)) { state.pages = np; changed = perm = true; }
      var nps = Array.isArray(j.me.positions) ? j.me.positions : []; // 職位（表單簽核關卡用）：後端改了就跟著更新
      if (JSON.stringify(nps) !== JSON.stringify(state.positions || [])) { state.positions = nps; changed = perm = true; }
    }
    if (j.session && j.session !== state.s) { state.s = j.session; state.exp = j.exp; changed = true; }
    if (changed) { persist(); if (perm) emit(meListeners, user()); }
  }

  // ---------- 登入畫面（使用 index.html 裡的 #authGate）----------
  function lock(on) {
    document.body.classList.toggle('auth-locked', on);
    var g = $('authGate'); if (g) g.classList.toggle('hide', !on);
  }
  function setMsg(t, bad) {
    var m = $('authError');
    if (m) { m.textContent = t || ''; m.style.color = bad ? '' : '#475569'; }
  }
  function loadGsi() {
    if (gsiPromise) return gsiPromise;
    gsiPromise = new Promise(function (resolve, reject) {
      if (root.google && google.accounts && google.accounts.id) return resolve();
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true; s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { s.remove(); reject(new Error('load')); };
      document.head.appendChild(s);
    });
    gsiPromise.catch(function () { gsiPromise = null; });
    return gsiPromise;
  }
  function renderGoogleButton() {
    var retry = $('lgRetry'), box = $('lgBtn'), mock = $('lgMock');
    if (!box) return;
    if (retry) retry.style.display = 'none';
    if (cfg.mock && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      if (mock) mock.classList.remove('hide');
      box.innerHTML = '';
      return;
    }
    if (mock) mock.classList.add('hide');
    loadGsi().then(function () {
      google.accounts.id.initialize({ client_id: cfg.clientId, callback: onCredential, auto_select: false, cancel_on_tap_outside: true });
      box.innerHTML = '';
      google.accounts.id.renderButton(box, { type: 'standard', theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left', width: 280, locale: 'zh_TW' });
    }).catch(function () {
      setMsg(navigator.onLine === false ? '目前沒有網路，連上網路後才能登入。' : '無法載入 Google 登入，請確認網路後再試。', true);
      if (retry) retry.style.display = 'inline-block';
    });
  }
  function showGate(msg, bad, opts) {
    opts = opts || {};
    var show = function () {
      lock(true);
      setMsg(msg, bad);
      var box = $('lgBtn'); if (box) box.style.display = opts.hideLogin ? 'none' : 'flex';
      var mock = $('lgMock'); if (mock && opts.hideLogin) mock.classList.add('hide');
      if (!opts.hideLogin) renderGoogleButton();
      var retry = $('lgRetry'); if (retry) { retry.style.display = opts.reload ? 'inline-block' : 'none'; retry.textContent = opts.reload ? '重新載入' : '重新載入登入按鈕'; retry.onclick = opts.reload ? function () { location.reload(); } : function () { gsiPromise = null; renderGoogleButton(); }; }
    };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }

  // ---------- 與雲端後端通訊 ----------
  function request(method, params, body) {
    var u = cloudUrl();
    if (!u) return Promise.reject(Object.assign(new Error('尚未設定雲端網址（config.js 的 INV_CLOUD.url）'), { code: 'config' }));
    var init = { redirect: 'follow', cache: 'no-store' }, url = u;
    if (method === 'GET') {
      var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
      url = u + (u.indexOf('?') < 0 ? '?' : '&') + q + '&_=' + Date.now();
      init.method = 'GET';
    } else {
      init.method = 'POST';
      init.headers = { 'Content-Type': 'text/plain;charset=utf-8' }; // 不用 application/json，避免瀏覽器先送 CORS 預檢（Apps Script 不接受）
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).catch(function (e) {
      if (e && e.code) throw e;
      var err = new Error(navigator.onLine === false ? '目前沒有網路，連上網路後再試。' : '無法連線到雲端：' + (e && e.message));
      err.code = 'network';
      throw err;
    });
  }
  function finish(j) {
    if (j && j.ok) { applyMe(j); return j; }
    var code = j && j.error, msg = j && j.message;
    // 「登入過期」或「帳號已停用／移出名單」：回到登入畫面。其他錯誤（沒有權限、資料衝突…）只顯示訊息
    if (code === 'unauthorized' || (code === 'forbidden' && !msg)) denied(code);
    var err = new Error(msg || (code === 'busy' ? '雲端忙碌中，請稍後再試' : code === 'unauthorized' || code === 'forbidden' ? '登入已失效，請重新登入' : '雲端回應錯誤（' + code + '）'));
    err.code = code;
    throw err;
  }
  function withRetry(fn, tries) {
    return fn().catch(function (e) {
      if (e && e.code === 'busy' && tries > 0) return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return withRetry(fn, tries - 1); });
      throw e;
    });
  }
  function need() { if (!enabled || !state) return Promise.reject(Object.assign(new Error('尚未登入'), { code: 'unauthorized' })); return null; }
  function get(params) {
    var n = need(); if (n) return n;
    return withRetry(function () { return request('GET', Object.assign({ token: state && state.s }, params)).then(finish); }, 2);
  }
  function call(action, payload) {
    var n = need(); if (n) return n;
    return withRetry(function () { return request('POST', null, Object.assign({ action: action, token: state && state.s }, payload || {})).then(finish); }, 2).then(function (j) {
      // 公務機上送出申請（不是草稿）之後，幾秒後自動登出，換下一位同事
      if (state && state.act && action === 'put' && payload && payload.item && payload.item.status && payload.item.status !== 'draft' && (payload.store === 'invoices' || payload.store === 'memos')) submitBack();
      return j;
    });
  }

  // ---------- 公務機模式 ----------
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function injectStyle() {
    if ($('devStyle')) return;
    var st = document.createElement('style'); st.id = 'devStyle';
    st.textContent = '.dev-picker{position:fixed;inset:0;z-index:10000;display:none;align-items:flex-start;justify-content:center;background:#F6EFDB;overflow:auto;padding:18px 12px}.dev-card{width:100%;max-width:560px;background:#fff;border:1px solid #E6D9B4;border-radius:14px;padding:18px 16px;box-shadow:0 4px 18px rgba(15,63,37,.12)}.dev-card h2{margin:0 0 4px;font-size:21px;color:#0F3F25}.dev-sub{color:#5B4B38;font-size:13px;margin:0 0 12px}.dev-names{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}.dev-names button,.dev-pad button{min-height:58px;font-size:19px;border-radius:12px;border:1px solid #C9A050;background:#FBF8EE;color:#0F3F25;cursor:pointer}.dev-names button:active,.dev-pad button:active{background:#F0E3BD}.dev-dots{font-size:34px;letter-spacing:10px;text-align:center;min-height:48px;color:#0F3F25}.dev-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:330px;margin:6px auto}.dev-pad .ok{background:#0F3F25;color:#fff;border-color:#0F3F25}.dev-pad .ok:disabled{opacity:.4}.dev-msg{min-height:22px;text-align:center;font-size:14px;margin:6px 0;color:#475569}.dev-msg.bad{color:#b42318;font-weight:600}.dev-foot{margin-top:14px;font-size:12px;color:#7a6a52;text-align:center}.dev-foot button{border:0;background:none;color:#7a6a52;text-decoration:underline;cursor:pointer;font-size:12px}.dev-back{border:0;background:none;color:#0F3F25;font-size:15px;cursor:pointer;margin-bottom:6px}.dev-actbar{position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:9000;background:#0F3F25;color:#fff;border-radius:999px;padding:6px 8px 6px 14px;font-size:13px;display:flex;gap:10px;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:94vw}.dev-actbar button{border:0;border-radius:999px;background:#C9A050;color:#0F3F25;font-weight:700;padding:6px 12px;cursor:pointer;white-space:nowrap}.dev-actbar.warn{background:#b42318}.dev-subbar{position:fixed;left:50%;top:10px;transform:translateX(-50%);z-index:9500;background:#0F3F25;color:#fff;border-radius:12px;padding:10px 14px;font-size:15px;display:flex;gap:12px;align-items:center;box-shadow:0 2px 12px rgba(0,0,0,.3);max-width:94vw}.dev-subbar button{border:0;border-radius:8px;background:#fff;color:#0F3F25;padding:6px 10px;cursor:pointer}';
    document.head.appendChild(st);
  }
  function deviceBack() {   // 回到選姓名畫面：先清掉這台裝置上的資料快取（共用手機不能留前一個人的發票），再重新載入
    var go = function () { try { sessionStorage.removeItem(ACT_KEY); } catch (e) {} location.reload(); };
    try { var p = root.invDeviceWipe && root.invDeviceWipe(); if (p && p.then) p.then(go, go); else go(); } catch (e) { go(); }
  }
  // 個人畫面：底下一條提醒列（誰、閒置幾分鐘自動登出、換人）；閒置計時
  function setActMsg(m, warn) {
    var bar = $('devActBar'); if (!bar) return;
    var t = bar.querySelector('span'); if (t) t.innerHTML = m || ('🏭 公務機｜<b>' + esc(state && state.name) + '</b>｜閒置 ' + Math.round(IDLE_MS / 60000) + ' 分鐘會自動登出');
    bar.classList.toggle('warn', !!warn);
  }
  function resetIdle() {
    clearTimeout(idleTimer); clearTimeout(warnTimer);
    setActMsg();
    warnTimer = setTimeout(function () { setActMsg('⚠ 30 秒後自動登出（點一下畫面可以繼續使用）', true); }, Math.max(IDLE_MS - 30000, 500));
    idleTimer = setTimeout(deviceBack, IDLE_MS);
  }
  // 自己改 PIN 碼（要輸入舊的）：後端 devicePinChange；錯太多次一樣會鎖
  function changePin() {
    var oldPin = root.prompt('請輸入「目前的」PIN 碼'); if (oldPin == null) return;
    var newPin = root.prompt('請輸入「新的」PIN 碼（4～6 位數字）'); if (newPin == null) return;
    if (!/^\d{4,6}$/.test(newPin)) { root.alert('新的 PIN 碼要是 4～6 位數字'); return; }
    call('devicePinChange', { oldPin: String(oldPin).trim(), newPin: newPin.trim() }).then(function () { root.alert('PIN 碼已更新，下次請用新的。'); }, function (e) { root.alert('沒有更新：' + e.message); });
  }
  function startActMode() {
    var go = function () {
      injectStyle();
      var bar = document.createElement('div'); bar.id = 'devActBar'; bar.className = 'dev-actbar';
      bar.innerHTML = '<span></span><button type="button" id="devActPin" title="改自己的 PIN 碼">🔑 改 PIN</button><button type="button" id="devActBack">👥 換人／登出</button>';
      document.body.appendChild(bar);
      bar.querySelector('#devActBack').onclick = function () { deviceBack(); };
      bar.querySelector('#devActPin').onclick = changePin;
      ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) { document.addEventListener(ev, resetIdle, { passive: true, capture: true }); });
      resetIdle();
    };
    if (document.body) go(); else document.addEventListener('DOMContentLoaded', go, { once: true });
  }
  // 送出申請（發票、簽呈）之後：提示幾秒後自動登出，換下一位同事（可以按「先不要」）
  function submitBack() {
    clearTimeout(subTimer); var old = $('devSubBar'); if (old) old.remove();
    injectStyle();
    var bar = document.createElement('div'); bar.id = 'devSubBar'; bar.className = 'dev-subbar';
    bar.innerHTML = '<span>✅ 已送出。<b>4 秒後</b>自動登出，換下一位同事…</span><button type="button">先不要登出</button>';
    document.body.appendChild(bar);
    bar.querySelector('button').onclick = function () { clearTimeout(subTimer); bar.remove(); };
    subTimer = setTimeout(deviceBack, 4000);
  }
  // 公務機帳號：選姓名＋PIN 畫面
  var pick = { people: [], dept: '', sel: null, pin: '', busy: false };
  function pickerEl() { var el = $('devPicker'); if (el) return el; injectStyle(); el = document.createElement('div'); el.id = 'devPicker'; el.className = 'dev-picker'; document.body.appendChild(el); bindPicker(el); return el; }
  function paintPicker(msg, bad) {
    var el = $('devPicker'); if (!el) return;
    var foot = '<div class="dev-foot">這是公務機帳號（' + esc(state && state.email) + '）。<button type="button" data-dev="signout">管理員：登出這台公務機</button></div>', h;
    if (!pick.sel) {
      h = '<div class="dev-card"><h2>🏭 ' + esc(pick.dept) + '　請選擇你的名字</h2><p class="dev-sub">點自己的名字，再輸入 PIN 碼。用完請按「換人／登出」，或送出申請後會自動登出。</p>' +
        (pick.people.length ? '<div class="dev-names">' + pick.people.map(function (p) { return '<button type="button" data-dev="pick" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button>'; }).join('') + '</div>'
          : '<p class="dev-msg">目前沒有可以選的同事。請管理員到「系統設定 → 帳號」的「公務機」區塊，把這個部門的同仁加進來並設定 PIN 碼。</p>') +
        '<div class="dev-msg' + (bad ? ' bad' : '') + '">' + esc(msg || '') + '</div>' + foot + '</div>';
    } else {
      var dots = ''; for (var i = 0; i < 6; i++) dots += i < pick.pin.length ? '●' : '○';
      h = '<div class="dev-card"><button type="button" class="dev-back" data-dev="back">← 重新選名字</button><h2>' + esc(pick.sel.name) + '</h2><p class="dev-sub">請輸入你的 PIN 碼（4～6 位數字）</p><div class="dev-dots" aria-live="polite">' + dots + '</div>' +
        '<div class="dev-msg' + (bad ? ' bad' : '') + '">' + esc(msg || '') + '</div><div class="dev-pad">' +
        [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) { return '<button type="button" data-dev="d" data-n="' + n + '"' + (pick.busy ? ' disabled' : '') + '>' + n + '</button>'; }).join('') +
        '<button type="button" data-dev="del"' + (pick.busy ? ' disabled' : '') + '>⌫</button><button type="button" data-dev="d" data-n="0"' + (pick.busy ? ' disabled' : '') + '>0</button><button type="button" class="ok" data-dev="go"' + (pick.pin.length < 4 || pick.busy ? ' disabled' : '') + '>確定</button></div>' + foot + '</div>';
    }
    el.innerHTML = h;
  }
  function loadRoster() {
    var el = pickerEl(); el.innerHTML = '<div class="dev-card"><h2>載入名單中…</h2></div>';
    call('deviceRoster').then(function (j) { pick.people = j.people || []; pick.dept = j.dept || ''; pick.sel = null; pick.pin = ''; paintPicker(''); })
      .catch(function (e) { el.innerHTML = '<div class="dev-card"><h2>無法載入名單</h2><p class="dev-msg bad">' + esc(e.message) + '</p><div class="dev-names"><button type="button" data-dev="retry">重新載入</button></div></div>'; });
  }
  function submitPin() {
    if (pick.busy || !pick.sel || pick.pin.length < 4) return;
    pick.busy = true; paintPicker('確認中…');
    request('POST', null, { action: 'deviceLogin', token: state && state.s, id: pick.sel.id, pin: pick.pin }).then(function (j) {
      pick.busy = false;
      if (j && j.ok && j.session && j.me) {
        state = { s: j.session, exp: j.exp, email: j.me.email, name: j.me.name, role: j.me.role, dept: j.me.dept || '', pages: Array.isArray(j.me.pages) ? j.me.pages : null, positions: [], act: true };
        persist(); location.reload(); return;
      }
      var code = j && j.error;
      if (code === 'unauthorized' || (code === 'forbidden' && !(j && j.message))) { denied(code); return; }
      pick.pin = ''; paintPicker((j && j.message) || '登入失敗，請再試一次', true);
    }).catch(function (e) { pick.busy = false; pick.pin = ''; paintPicker(e.message, true); });
  }
  function bindPicker(el) {
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button[data-dev]'); if (!b || b.disabled) return;
      var k = b.dataset.dev;
      if (k === 'pick') { pick.sel = pick.people.filter(function (p) { return p.id === b.dataset.id; })[0] || null; pick.pin = ''; paintPicker(''); }
      else if (k === 'back') { pick.sel = null; pick.pin = ''; paintPicker(''); }
      else if (k === 'd') { if (pick.pin.length < 6 && !pick.busy) { pick.pin += b.dataset.n; paintPicker(''); } }
      else if (k === 'del') { pick.pin = pick.pin.slice(0, -1); paintPicker(''); }
      else if (k === 'go') submitPin();
      else if (k === 'retry') loadRoster();
      else if (k === 'signout') { if (confirm('確定要登出這台公務機嗎？\n之後要再用公司 Gmail 登入一次，同事才能選名字使用。')) { clearStored(); try { localStorage.removeItem(KEY); } catch (x) {} location.reload(); } }
    });
    document.addEventListener('keydown', function (e) {
      var el2 = $('devPicker'); if (!el2 || el2.style.display === 'none' || !pick.sel) return;
      if (/^\d$/.test(e.key)) { if (pick.pin.length < 6 && !pick.busy) { pick.pin += e.key; paintPicker(''); } }
      else if (e.key === 'Backspace') { pick.pin = pick.pin.slice(0, -1); paintPicker(''); }
      else if (e.key === 'Enter') submitPin();
    });
  }
  function showPicker() {
    var show = function () { lock(true); var g = $('authGate'); if (g) g.classList.add('hide'); var el = pickerEl(); el.style.display = 'flex'; loadRoster(); };
    if (document.body) show(); else document.addEventListener('DOMContentLoaded', show, { once: true });
  }


  // 登入時順便要全部資料（boot）：後端在同一次請求裡一起回傳，登入後不用再等第二趟
  var bootPayload = null;
  // stores：登入時只要這三類資料（歷史科目約 3 萬筆不在登入時下載，只有財務與管理員之後在背景載入）；舊版後端不認得 stores，會照舊回全部，網頁自己忽略多的
  var CORE_STORES = ['invoices', 'organization', 'accounts'];
  function postLogin(idToken) { return request('POST', null, { action: 'login', idToken: idToken, boot: true, stores: CORE_STORES }); }
  function takeBoot() { var b = bootPayload; bootPayload = null; return b; }
  function onCredential(resp) {
    if (busy || !resp || !resp.credential) return;
    busy = true;
    setMsg('登入中…');
    postLogin(resp.credential).then(function (j) {
      busy = false;
      if (j && j.ok && j.session && j.me) {
        state = { s: j.session, exp: j.exp, email: j.me.email, name: j.me.name, role: j.me.role, dept: j.me.dept || '', pages: Array.isArray(j.me.pages) ? j.me.pages : null, positions: Array.isArray(j.me.positions) ? j.me.positions : [], deviceDept: j.me.deviceDept || '' };
        persist();
        if (state.deviceDept) { bootPayload = null; showPicker(); return; }   // 公務機帳號：不進系統，只顯示「選姓名」畫面
        bootPayload = j.boot && j.boot.stores ? j.boot : null;
        if (wasReady) { location.reload(); return; } // App 已經在跑（登入過期後重新登入）：整個重新載入最單純
        wasReady = true; resolveReady();
        return;
      }
      if (j && j.error === 'forbidden') setMsg('「' + (j.email || '這個帳號') + '」不在人員名單內。請把這個 Gmail 地址告訴管理員，請他加進「帳號／權限管理」；如果你有其他 Gmail，也可以換一個登入。', true);
      else setMsg((j && j.message) || '登入失敗，請再試一次。', true);
    }).catch(function (e) {
      busy = false;
      setMsg(e.message, true);
    });
  }

  // 雲端說「登入過期」或「帳號已停用／移出名單」
  function denied(code) {
    if (!enabled || !state) return;
    if (state.act) { deviceBack(); return; }   // 公務機上的個人工作階段過期或被重設 PIN：回到選姓名畫面
    var removed = code === 'forbidden';
    clearStored();
    emit(deniedListeners, { removed: removed });
    showGate(removed ? '你的帳號已被停用或移出名單，請聯絡管理員。' : '登入已過期，請重新登入。', removed);
  }
  function signOut() {
    clearStored();
    try { if (root.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
  }

  // ---------- 啟動 ----------
  function init() {
    if (!enabled) {
      showGate('這個網站還沒設定 Google 登入（config.js 的 INV_AUTH.clientId），請聯絡管理員。', true, { hideLogin: true });
      return;
    }
    state = load();
    if (state && state.deviceDept && !state.act) { showPicker(); return; }   // 公務機帳號：只顯示選姓名畫面
    if (state) { wasReady = true; resolveReady(); if (state.act) startActMode(); return; }
    clearStored();
    showGate('');
    var bind = function () { // 本機測試登入按鈕
      var b = $('lgMockBtn');
      if (b) b.onclick = function () { var v = ($('lgMockEmail').value || '').trim(); if (v) onCredential({ credential: 'mock:' + v }); };
    };
    if (document.body) bind(); else document.addEventListener('DOMContentLoaded', bind, { once: true });
  }
  init();

  root.InvCloud = {
    enabled: enabled, ready: ready,
    user: user, get: get, call: call, signOut: signOut, showGate: showGate, lock: lock, takeBoot: takeBoot, deviceBack: deviceBack,
    deviceIdleMs: function (ms) { IDLE_MS = ms; if (state && state.act) resetIdle(); },   // 測試用：改閒置多久自動登出
    onMe: function (fn) { meListeners.push(fn); },
    onDenied: function (fn) { deniedListeners.push(fn); }
  };
})(window);
