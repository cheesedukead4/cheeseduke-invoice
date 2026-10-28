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
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (isObj(s) && s.s && s.exp > Date.now() + 60000 && s.email) return s;
    } catch (e) {}
    return null;
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function clearStored() { state = null; try { localStorage.removeItem(KEY); } catch (e) {} }

  function user() { return state ? { email: state.email, name: state.name, role: state.role, dept: state.dept || '', pages: Array.isArray(state.pages) ? state.pages : null, positions: Array.isArray(state.positions) ? state.positions : [] } : null; }

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
    return withRetry(function () { return request('POST', null, Object.assign({ action: action, token: state && state.s }, payload || {})).then(finish); }, 2);
  }

  // 登入時順便要全部資料（boot）：後端在同一次請求裡一起回傳，登入後不用再等第二趟
  var bootPayload = null;
  function postLogin(idToken) { return request('POST', null, { action: 'login', idToken: idToken, boot: true }); }
  function takeBoot() { var b = bootPayload; bootPayload = null; return b; }
  function onCredential(resp) {
    if (busy || !resp || !resp.credential) return;
    busy = true;
    setMsg('登入中…');
    postLogin(resp.credential).then(function (j) {
      busy = false;
      if (j && j.ok && j.session && j.me) {
        state = { s: j.session, exp: j.exp, email: j.me.email, name: j.me.name, role: j.me.role, dept: j.me.dept || '', pages: Array.isArray(j.me.pages) ? j.me.pages : null, positions: Array.isArray(j.me.positions) ? j.me.positions : [] };
        persist();
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
    if (state) { wasReady = true; resolveReady(); return; }
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
    user: user, get: get, call: call, signOut: signOut, showGate: showGate, lock: lock, takeBoot: takeBoot,
    onMe: function (fn) { meListeners.push(fn); },
    onDenied: function (fn) { deniedListeners.push(fn); }
  };
})(window);
