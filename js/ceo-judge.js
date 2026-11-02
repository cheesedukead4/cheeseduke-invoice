/* 執行長發票判斷（依「起士公爵發票判斷標準」）
 * 判斷標準的規則（商家／關鍵字 → 請款 Y／N、卡別、附註「Y 或 N－部門費用類別」、不處理、待確認）找到第一條命中的，轉成系統單據要存的資料：
 *   請款別 Y／N、卡別、費用類別（對照部門與會計科目名稱）、附註、判斷狀態。純函式，Node 也能測（開發工具/test-ceo-judge.cjs）。
 * 費用類別對照（管理部雜支→管理部＋什項購置…）有一份內建草稿；管理員在「資料庫 → 費用類別對照」改過之後存在雲端（組織資料的 expensetypes 紀錄）。 */
(function (root) {
  'use strict';

  var PAID_BY_CARD = '公司卡（已付）'; // N（公司卡已付、不請款）的付款方式

  // 費用類別 → 部門、會計科目名稱（草稿，部門名稱要和組織裡的部門一樣才會套用；科目名稱要和會計科目表一樣才找得到代號）
  var DEFAULT_TYPES = [
    { name: '管理部雜支', dept: '管理部', acct: '什項購置' },
    { name: '管理部交際費', dept: '管理部', acct: '交際費' },
    { name: '管理部AI軟體使用費', dept: '管理部', acct: '什項購置' },
    { name: '管理部AI工具', dept: '管理部', acct: '什項購置' },
    { name: '行銷後勤軟體費', dept: '行銷部(新)', acct: '什項購置' },
    { name: '行銷後勤', dept: '行銷部(新)', acct: '什項購置' },
    { name: '行銷通路差旅費', dept: '行銷部(新)', acct: '差旅費' },
    { name: '行銷通路年費', dept: '行銷部(新)', acct: '什項購置' },
    { name: '行銷部軟體使用費', dept: '行銷部(新)', acct: '什項購置' },
    { name: '研發費用', dept: '生產組', acct: '研發費' },
    { name: '生產部職工', dept: '生產組', acct: '職工福利' },
    { name: '生產部工具', dept: '生產組', acct: '什項購置' },
    { name: '京站職工', dept: '京站百貨', acct: '職工福利' },
    { name: '通路部職工', dept: '通路', acct: '職工福利' },
    { name: '東橋職工', dept: '永康東橋', acct: '職工福利' },
    { name: '物管職工', dept: '物管組', acct: '職工福利' },
    { name: '行銷職工', dept: '行銷部(新)', acct: '職工福利' },
    { name: '不請款', dept: '', acct: '' }
  ];

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function norm(s) { return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''); }

  // 檢查費用類別對照（管理員在畫面上改的、雲端讀回來的）：名稱不能空白或重複，最多 80 個
  function sanitizeTypes(list) {
    if (!Array.isArray(list)) return { ok: false, error: '費用類別對照的內容不對' };
    var seen = {}, out = [], warnings = [];
    list.slice(0, 80).forEach(function (t) {
      var name = String((t && t.name) == null ? '' : t.name).normalize('NFKC').trim();
      if (!name || name.length > 30) { if (name) warnings.push('類別「' + name.slice(0, 12) + '…」名稱太長，已略過'); return; }
      if (seen[name]) { warnings.push('類別「' + name + '」重複，已略過'); return; }
      seen[name] = 1;
      out.push({ name: name, dept: String(t.dept == null ? '' : t.dept).trim().slice(0, 60), acct: String(t.acct == null ? '' : t.acct).trim().slice(0, 40) });
    });
    if (!out.length) return { ok: false, error: '至少要有一個費用類別' };
    return { ok: true, types: out, warnings: warnings };
  }

  // 附註「Y-管理部雜支（衛生紙）」「N-不請款」→ {yn, text}；格式不對回傳 null
  function parseNote(note) {
    var m = /^\s*([YyNn])\s*(?:[-－]\s*(.*))?$/.exec(String(note == null ? '' : note));
    return m ? { yn: m[1].toUpperCase(), text: String(m[2] || '').trim() } : null;
  }
  // 類別文字（管理部雜支（計程車費））→ 對照到的費用類別（名稱最長的、開頭相符的）
  function typeFor(types, text) {
    var t = String(text == null ? '' : text).trim(), best = null;
    (types || []).forEach(function (x) { if (x.name && t.indexOf(x.name) === 0 && (!best || x.name.length > best.name.length)) best = x; });
    return best;
  }
  // 卡別 → Y／N（文件步驟 D）：玉山是公司卡、公司已付＝N；中信、富邦、現金代墊是 James 代墊＝Y；看不出來回傳空字串
  function ynFromCard(card) {
    var c = String(card == null ? '' : card);
    if (/玉山|公司卡|7170/.test(c)) return 'N';
    if (/中國信託|中信|富邦|momo|現金|代墊|lalamove|小蜂鳥|9827/i.test(c)) return 'Y';
    return '';
  }
  // 費用類別文字 → 部門＋會計科目（對不到回傳空）
  function resolveCategory(types, text) {
    var t = typeFor(types, text);
    return t ? { name: t.name, dept: t.dept || '', acct: t.acct || '' } : { name: '', dept: '', acct: '' };
  }

  // 判斷標準的一條規則 → 系統單據要用的資料。rule＝null 代表沒有任何規則命中（新商家）
  //   status：process（依標準處理）／skip（不處理）／confirm（待確認）／none（沒有規則）
  //   options：附註可選的類別（多於一個時要請人選）；picked＝規則只有一個附註時自動選好的
  function judgeRule(rule, types) {
    if (!rule) return { status: 'none', ruleId: '', ruleName: '', yn: '', card: '', options: [], picked: -1, remark: '', need: ['請款別', '卡別'] };
    var status = rule.action === 'skip' ? 'skip' : rule.action === 'confirm' ? 'confirm' : 'process';
    var options = (Array.isArray(rule.notes) ? rule.notes : []).map(function (n) {
      var p = parseNote(n); if (!p) return null;
      var info = resolveCategory(types, p.text);
      return { note: String(n).trim(), yn: p.yn, text: p.text, category: p.text, type: info.name, dept: info.dept, acct: info.acct };
    }).filter(Boolean);
    var yn = rule.yn === 'Y' || rule.yn === 'N' ? rule.yn : '';
    if (!yn && options.length && options.every(function (o) { return o.yn === options[0].yn; })) yn = options[0].yn;
    if (!yn) yn = ynFromCard(rule.card);
    return { status: status, ruleId: String(rule.id || ''), ruleName: String(rule.name || ''), yn: yn, card: String(rule.card || ''), options: options, picked: options.length === 1 ? 0 : -1, remark: String(rule.remark || ''), need: [] };
  }

  // 附註字串：Y-管理部雜支、N-不請款、Y（沒有類別）
  function buildNote(yn, category) {
    if (yn !== 'Y' && yn !== 'N') return '';
    var c = String(category || '').trim();
    if (!c) return yn === 'N' ? 'N-不請款' : 'Y';
    return yn + '-' + c;
  }
  // 要存進單據的 claim.ceo；paymentMethod 要怎麼設（N＝公司卡已付）也一併回傳
  function toClaim(sel) {
    var yn = sel && (sel.yn === 'Y' || sel.yn === 'N') ? sel.yn : '';
    var category = String((sel && sel.category) || '').trim(), card = String((sel && sel.card) || '').trim();
    return { yn: yn, card: card.slice(0, 60), category: category.slice(0, 80), note: buildNote(yn, category), status: String((sel && sel.status) || ''), ruleId: String((sel && sel.ruleId) || '').slice(0, 60), ruleName: String((sel && sel.ruleName) || '').slice(0, 80) };
  }
  // 送出前還缺什麼：請款別一定要有；N（公司卡已付）要有卡別與費用類別；Y 若規則有多個類別，要選一個；不處理的要特別確認
  function missing(ceo, opt) {
    opt = opt || {};
    var out = [];
    if (!ceo || (ceo.yn !== 'Y' && ceo.yn !== 'N')) out.push('請款別（要請款 Y／不請款 N）');
    else {
      if (!String(ceo.card || '').trim()) out.push('卡別');
      if (ceo.yn === 'N' && !String(ceo.category || '').trim()) out.push('費用類別（N 要註明部門歸帳）');
    }
    if (opt.needCategoryPick) out.push('費用類別（規則有多個附註，請選一個）');
    // 付款方式要和請款別一致：N＝公司卡已付，Y＝要付款給 James（匯款／現金）
    if (opt.payment !== undefined && ceo && (ceo.yn === 'Y' || ceo.yn === 'N')) {
      if (ceo.yn === 'N' && opt.payment !== PAID_BY_CARD) out.push('付款方式要選「' + PAID_BY_CARD + '」（請款別 N）');
      if (ceo.yn === 'Y' && opt.payment === PAID_BY_CARD) out.push('付款方式「' + PAID_BY_CARD + '」只能搭配請款別 N');
    }
    if (ceo && ceo.status === 'skip' && !opt.overrideSkip) out.push('這筆在判斷標準裡是「不處理」，確定要處理請勾選「仍要處理這筆」');
    if (ceo && ceo.status === 'confirm' && !opt.confirmed) out.push('判斷標準標了「待確認」，請確認請款別、卡別與費用類別後再送出');
    return out;
  }

  // 疑似重複（文件步驟 F）：同商家（統編相同，或廠商名稱相同）、同金額、日期相差在 days 天內，已送出的（不含草稿與被退回的）
  function duplicates(invoices, cand, days) {
    days = days == null ? 10 : days;
    var tax = String(cand.taxId || '').trim(), vendor = norm(cand.vendor), amount = Number(cand.amount) || 0, d0 = Date.parse(String(cand.invoiceDate || '').slice(0, 10));
    if (!amount || (!tax && !vendor)) return [];
    return (invoices || []).filter(function (i) {
      if (!i || i.id === cand.id || i.status === 'draft' || i.status === 'rejected') return false;
      if (Math.abs((Number(i.amount) || 0) - amount) > 0.01) return false;
      var same = (tax && String(i.taxId || '').trim() === tax) || (vendor && norm(i.vendor) === vendor);
      if (!same) return false;
      var d1 = Date.parse(String(i.invoiceDate || '').slice(0, 10));
      return isNaN(d0) || isNaN(d1) ? true : Math.abs(d0 - d1) <= days * 86400000;
    });
  }

  var api = { PAID_BY_CARD: PAID_BY_CARD, DEFAULT_TYPES: DEFAULT_TYPES, defaultTypes: function () { return clone(DEFAULT_TYPES); }, sanitizeTypes: sanitizeTypes, parseNote: parseNote, typeFor: typeFor, ynFromCard: ynFromCard, resolveCategory: resolveCategory, judgeRule: judgeRule, buildNote: buildNote, toClaim: toClaim, missing: missing, duplicates: duplicates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CeoJudge = api;
})(typeof window !== 'undefined' ? window : this);
