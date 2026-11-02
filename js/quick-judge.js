/* 發票項目快速判讀
 * 品名（咖啡、雞腿飯…）→ 品類（食品…）→ 用途（研發／職工福利／交際費）→ 會計科目名稱，並建議分攤部門。
 * 只產生「建議」：不改單據；發票登錄頁與財務覆核都用同一組規則。純函式，Node 也能直接測（開發工具/test-quick-judge.cjs）。
 * 規則（品類關鍵字、用途關鍵字）有一份內建預設（DEFAULT_CATS／DEFAULT_PURPOSES）；管理員在「資料庫 → 快速判讀規則」改過之後存在雲端
 * （組織資料的 qjrules 紀錄），網頁載入後呼叫 setRules() 換成雲端的版本；沒有雲端規則就用預設。 */
(function (root) {
  'use strict';

  // 品類。kw：品名含任一個關鍵字就算（多個品類都符合時取「最長的關鍵字」，同長取排前面的）；
  //   acct：會計科目名稱（科目表的同名科目，陣列＝依序找第一個有的）；purposes：用途要再判斷（例如食品）；fixed：這個品類本身就決定了用途
  var DEFAULT_CATS = [
    { label: '食品', purposes: true, acct: [], kw: ['食品', '飲品', '飲料', '咖啡', '拿鐵', '美式', '茶', '奶茶', '手搖', '果汁', '牛奶', '豆漿', '可樂', '汽水', '氣泡水', '礦泉水', '便當', '雞腿飯', '排骨飯', '燉飯', '炒飯', '丼', '飯', '麵', '餃', '餐', '早餐', '午餐', '晚餐', '宵夜', '下午茶', '點心', '蛋糕', '麵包', '吐司', '甜點', '餅乾', '零食', '糖果', '巧克力', '堅果', '水果', '沙拉', '三明治', '漢堡', '披薩', '壽司', '火鍋', '燒烤', '滷味', '雞排', '食材', '原料', '蛋白粉', '麵粉', '奶油', '起士', '乳酪', '起司', '優格', 'ubereats', 'foodpanda', '附餐', '套餐'] },
    { label: '交際費', fixed: '交際費', acct: ['交際費'], kw: ['交際費', '交際', '禮盒', '禮品', '禮券', '伴手禮', '花籃', '花束', '賀禮', '奠儀', '紅包', '招待', '宴請', '餐敘', '應酬'] },
    { label: '職工福利', fixed: '職工福利', acct: ['職工福利'], kw: ['職工福利', '職工', '福利', '員工旅遊', '旅遊補助', '尾牙', '春酒', '慶生', '生日禮', '團康', '健康檢查', '健檢', '員工餐'] },
    { label: '研發', fixed: '研發', acct: ['研發費'], kw: ['研發費', '研發', '試作', '打樣', '試產', '實驗', '樣品', '配方'] },
    { label: '差旅交通', acct: ['差旅費'], kw: ['差旅', '交通', '計程車', '小黃', 'taxi', 'uber', '大車隊', '高鐵', '台鐵', '火車', '捷運', '公車', '客運', '機票', '航空', '停車', '過路費', 'etag', '加油', '油資', '住宿', '旅館', '飯店', '民宿', '訂房', 'agoda', 'booking', '出差'] },
    { label: '運費', acct: ['運費'], kw: ['運費', '物流', '宅配', '貨運', '快遞', '配送', '託運', '黑貓', '順豐', '集運'] },
    { label: '郵電', acct: ['郵電費'], kw: ['郵電', '郵資', '郵寄', '掛號', '電話費', '網路費', '門號', '簡訊', '電信', '手機費', '寬頻'] },
    { label: '水電瓦斯', acct: ['水電瓦斯費'], kw: ['水電瓦斯', '電費', '水費', '瓦斯', '天然氣'] },
    { label: '租金', acct: ['租金費用', '租金支出'], kw: ['租金', '房租', '租賃', '場租', '倉租'] },
    { label: '廣告', acct: ['廣告費'], kw: ['廣告', '投放', 'facebook', 'googleads', 'instagram', '網紅', '業配', '贊助'] },
    { label: '印刷', acct: ['印刷費'], kw: ['印刷', '海報', '名片', '貼紙', '型錄', '傳單', '輸出', '標籤', '菜單'] },
    { label: '包裝', acct: ['包裝費'], kw: ['包裝', '包材', '紙箱', '瓦楞', '氣泡', '餐盒', '紙袋', '塑膠袋', '封口', '提袋'] },
    { label: '辦公雜支', acct: ['什項購置'], kw: ['辦公雜支', '文具', '原子筆', '簽字筆', '筆記', '影印', '墨水', '碳粉', '膠帶', '資料夾', '便利貼', '衛生紙', '清潔', '掃具', '垃圾袋', '電池', '延長線', '器具', '工具', '雜支', '耗材', '消耗品', '餐具', '茶具', '冰箱', '微波爐', '水壺', '杯子', '抹布'] },
    { label: '修繕', acct: ['修繕費'], kw: ['修繕', '維修', '修理', '保養', '裝修', '水電工程'] },
    { label: '教育訓練', acct: ['教育訓練費', '教育訓練'], kw: ['教育訓練', '課程', '訓練', '研習', '講座', '學費', '證照', '報名費'] },
    { label: '勞務', acct: ['勞務費'], kw: ['勞務', '外包', '設計費', '顧問', '翻譯', '攝影', '剪輯', '稿費', '代操', '諮詢', '仲介'] },
    { label: '手續費', acct: ['手續費'], kw: ['手續費', '匯費', '刷卡費', '金流', '跨行'] },
    { label: '檢驗', acct: ['檢驗費'], kw: ['檢驗', '檢測', '化驗', '送驗', '驗證'] }
  ];
  // 用途（品類標成 purposes 的才用）：品名、請款用途、廠商名稱裡出現哪一類的字就判斷成哪個用途；只有一類出現才判斷，同時出現多類就不判斷（交給人選）。acct＝該用途對應的會計科目名稱
  var DEFAULT_PURPOSES = [
    { name: '研發', acct: '研發費', cues: ['研發', '研究', '試作', '試做', '試吃', '試產', '打樣', '配方', '原料', '蛋白粉', '樣品', '測試', '實驗', '船井生醫', '鴻鼎菓子', '鴻鼎果子'] },
    { name: '職工福利', acct: '職工福利', cues: ['職工', '福利', '員工', '同仁', '下午茶', '加班', '聚餐', '尾牙', '春酒', '慶生', '生日', '團購'] },
    { name: '交際費', acct: '交際費', cues: ['交際', '客戶', '招待', '拜訪', '洽談', '餐敘', '宴請', '宴客', '送禮', '廠商', '業務', '應酬'] }
  ];
  // 這些是 QR code 對帳補的行（稅額、尾差…），不是品項，不分類，整併到金額最大的那一組
  var ADJUST_RE = /^(營業稅|尾差|差額|其他品項)/;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function norm(s) { return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }

  var CATS = [], PURPOSES = [], LABELS = [], LABEL_RE = null;

  // 規則換新之後重算：項目說明開頭的標籤清單與辨識用的正規表示式。標籤格式：「食品-研發：咖啡、雞腿飯」「交際費：禮盒」
  function rebuild() {
    LABELS = [];
    CATS.forEach(function (c) {
      if (c.purposes) { PURPOSES.forEach(function (p) { LABELS.push(c.label + '-' + p.name); }); }
      LABELS.push(c.label);
    });
    var alts = LABELS.slice().sort(function (a, b) { return b.length - a.length; }).map(function (l) { return l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
    LABEL_RE = new RegExp('^\\s*(' + alts.join('|') + ')\\s*[：:｜|]\\s*');
  }

  // ---------- 規則的檢查與整理（管理員在畫面上改的內容、雲端讀回來的內容，都先過這一關）----------
  function strList(v, max, len, lower) {
    var seen = {}, out = [];
    (Array.isArray(v) ? v : []).forEach(function (x) {
      x = String(x == null ? '' : x).normalize('NFKC').trim();
      if (lower) x = x.toLowerCase().replace(/\s+/g, '');
      if (!x || x.length > len || seen[x] || out.length >= max) return;
      seen[x] = 1; out.push(x);
    });
    return out;
  }
  // 回傳 {ok, cats, purposes, warnings[]} 或 {ok:false, error}
  function sanitize(cfg) {
    if (!cfg || typeof cfg !== 'object') return { ok: false, error: '規則內容不對' };
    var warnings = [], pSeen = {}, purposes = [], cSeen = {}, cats = [];
    (Array.isArray(cfg.purposes) ? cfg.purposes : []).slice(0, 8).forEach(function (p) {
      var name = String((p && p.name) == null ? '' : p.name).normalize('NFKC').trim();
      if (!name || name.length > 8 || /[-－：:｜|]/.test(name) || pSeen[name]) { if (name) warnings.push('用途「' + name + '」名稱不能重複，也不能有 - ： | 符號，已略過'); return; }
      pSeen[name] = 1;
      purposes.push({ name: name, acct: String(p.acct == null ? '' : p.acct).trim().slice(0, 20), cues: strList(p.cues, 100, 20, true) });
    });
    if (!purposes.length) return { ok: false, error: '至少要有一個用途' };
    (Array.isArray(cfg.cats) ? cfg.cats : []).slice(0, 60).forEach(function (c) {
      var label = String((c && c.label) == null ? '' : c.label).normalize('NFKC').trim();
      if (!label || label.length > 12 || /[-－：:｜|]/.test(label)) { if (label) warnings.push('品類「' + label + '」名稱太長或含 - ： | 符號，已略過'); return; }
      if (cSeen[label.toLowerCase()]) { warnings.push('品類「' + label + '」重複，已略過'); return; }
      cSeen[label.toLowerCase()] = 1;
      var kw = strList(c.kw, 300, 20, true), nl = norm(label);
      if (nl && kw.indexOf(nl) < 0) kw.unshift(nl); // 標籤自己一定要認得出來（寫進項目說明之後，財務覆核才讀得回來）
      if (kw.length > 300) kw.length = 300;
      var cat = { label: label, acct: strList(c.acct, 6, 20, false), kw: kw };
      if (c.purposes) cat.purposes = true;
      else if (c.fixed && String(c.fixed).trim()) cat.fixed = String(c.fixed).normalize('NFKC').trim().slice(0, 8);
      cats.push(cat);
    });
    if (!cats.length) return { ok: false, error: '至少要有一個品類' };
    return { ok: true, cats: cats, purposes: purposes, warnings: warnings };
  }
  function setRules(cfg) {
    var r = sanitize(cfg);
    if (!r.ok) return r;
    CATS = r.cats; PURPOSES = r.purposes; rebuild();
    return r;
  }
  function resetRules() { return setRules({ cats: DEFAULT_CATS, purposes: DEFAULT_PURPOSES }); }
  function getRules() { return clone({ cats: CATS, purposes: PURPOSES }); }
  function defaultRules() { return clone({ cats: DEFAULT_CATS, purposes: DEFAULT_PURPOSES }); }
  var DEFAULT_JSON = '';
  function isDefault() { return JSON.stringify(getRules()) === DEFAULT_JSON; } // 目前用的規則是不是內建預設

  function catByLabel(label) { for (var i = 0; i < CATS.length; i++) if (CATS[i].label === label) return CATS[i]; return null; }
  function purposeByName(name) { for (var i = 0; i < PURPOSES.length; i++) if (PURPOSES[i].name === name) return PURPOSES[i]; return null; }

  // 項目說明開頭的標籤 → {cat, purpose, rest}；沒有標籤回傳 null
  function parseLabel(desc) {
    var m = LABEL_RE.exec(String(desc == null ? '' : desc));
    if (!m) return null;
    var lab = m[1], rest = String(desc).slice(m[0].length).trim(), c = catByLabel(lab);
    if (c) return { cat: c, purpose: '', rest: rest };
    for (var i = 0; i < CATS.length; i++) {
      if (!CATS[i].purposes) continue;
      var pre = CATS[i].label + '-';
      if (lab.indexOf(pre) === 0 && purposeByName(lab.slice(pre.length))) return { cat: CATS[i], purpose: lab.slice(pre.length), rest: rest };
    }
    return null;
  }

  // 品名 → 品類：關鍵字最長者勝
  function classify(text) {
    var t = norm(text), best = null, len = 0;
    if (!t) return null;
    CATS.forEach(function (c) { c.kw.forEach(function (k) { if (k.length > len && t.indexOf(k) >= 0) { best = c; len = k.length; } }); });
    return best;
  }

  function foodPurpose(text) {
    var t = norm(text), found = [];
    if (!t) return '';
    PURPOSES.forEach(function (p) { if (p.cues.some(function (k) { return t.indexOf(k) >= 0; })) found.push(p.name); });
    return found.length === 1 ? found[0] : '';
  }

  // ctx：{purposeText（請款用途）, vendor}。回傳 null＝認不出品類
  function judgeLine(desc, ctx) {
    ctx = ctx || {};
    var pl = parseLabel(desc), body = pl ? pl.rest : String(desc == null ? '' : desc), cat = pl ? pl.cat : classify(body);
    if (!cat) return null;
    var purpose = '', basis = '', explicit = !!pl && (!cat.purposes || !!pl.purpose);
    if (cat.fixed) { purpose = cat.fixed; basis = 'item'; }
    else if (cat.purposes) {
      if (pl && pl.purpose) { purpose = pl.purpose; basis = 'label'; }
      else if ((purpose = foodPurpose(body))) basis = 'item';
      else if ((purpose = foodPurpose((ctx.purposeText || '') + ' ' + (ctx.vendor || '')))) basis = 'context';
    }
    var acct = cat.acct.slice();
    if (cat.purposes) { var pp = purpose && purposeByName(purpose); acct = pp && pp.acct ? [pp.acct] : []; }
    return {
      cat: cat.label, purpose: cat.purposes ? purpose : '', label: cat.purposes ? (purpose ? cat.label + '-' + purpose : cat.label) : cat.label,
      acct: acct, explicit: explicit, basis: basis, needsPurpose: !!cat.purposes && !purpose,
      options: cat.purposes ? PURPOSES.map(function (p) { return cat.label + '-' + p.name; }) : []
    };
  }

  // 把標籤寫到項目說明開頭（原本有標籤就換掉）
  function applyLabel(desc, label) {
    var pl = parseLabel(desc), rest = pl ? pl.rest : String(desc == null ? '' : desc).trim();
    if (rest === '發票費用') rest = '';
    return rest ? label + '：' + rest : label;
  }
  function stripLabel(desc) { var pl = parseLabel(desc); return pl ? pl.rest : String(desc == null ? '' : desc).trim(); }

  // 依品類整理：同一標籤的合併成一項（金額加總、品名用「、」串起來）；認不出的維持原樣；補差額的行併進金額最大的那組
  // lines：[{description, amount}]；回傳 [{label, cat, purpose, acct, description, amount, names, idx}]
  function groupLines(lines, ctx) {
    var groups = [], byLabel = {}, adjust = 0, adjIdx = [];
    (lines || []).forEach(function (l, i) {
      var d = String(l.description == null ? '' : l.description).trim(), amt = Number(l.amount) || 0;
      if (ADJUST_RE.test(d) && !parseLabel(d)) { adjust += amt; adjIdx.push(i); return; }
      var j = judgeLine(d, ctx);
      if (!j) { groups.push({ label: '', cat: '', purpose: '', acct: [], description: d, amount: amt, names: [d], idx: [i] }); return; }
      var name = stripLabel(d) || d;
      if (byLabel[j.label]) { var g = byLabel[j.label]; g.amount += amt; g.names.push(name); g.idx.push(i); return; }
      var ng = { label: j.label, cat: j.cat, purpose: j.purpose, acct: j.acct, description: '', amount: amt, names: [name], idx: [i] };
      byLabel[j.label] = ng; groups.push(ng);
    });
    if (adjIdx.length) {
      if (!groups.length) groups.push({ label: '', cat: '', purpose: '', acct: [], description: '', amount: 0, names: [], idx: [] });
      var big = groups.reduce(function (b, g) { return g.amount > b.amount ? g : b; }, groups[0]);
      big.amount += adjust; big.idx = big.idx.concat(adjIdx);
    }
    groups.forEach(function (g) {
      g.amount = Math.round(g.amount * 100) / 100;
      if (g.label) g.description = applyLabel(uniq(g.names).join('、'), g.label);
    });
    return groups;
  }
  function uniq(a) { var seen = {}, out = []; a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } }); return out; }

  // 建議分攤部門。depts：[{name, prefix}]（部門名稱與科目代號編碼）。
  // ①文字裡提到某個部門（京站、永康…）就是那個部門；②研發費只有生產類（編碼 51）的科目 → 編碼 51 的部門；其他回傳 null（沿用申請部門）
  function suggestDepts(text, purpose, depts) {
    var t = norm(text), list = depts || [], hit = [];
    list.forEach(function (d) {
      var name = String(d.name || ''), aliases = [norm(name)], short = name.replace(/(百貨公司|百貨|門市|分店|店|部|組|處|室|中心)$/, '');
      if (short.length >= 2 && short !== name) aliases.push(norm(short));
      if (aliases.some(function (a) { return a && t.indexOf(a) >= 0; })) hit.push(name);
    });
    if (hit.length) return { names: hit, reason: '文字裡提到「' + hit.join('、') + '」' };
    if (purpose === '研發') {
      var prod = list.filter(function (d) { return String(d.prefix || '') === '51'; }).map(function (d) { return d.name; });
      if (prod.length) return { names: prod, reason: '研發費只有生產類（科目代號編碼 51）的科目' };
    }
    return null;
  }

  resetRules(); DEFAULT_JSON = JSON.stringify(getRules());
  var api = {
    isDefault: isDefault,
    get CATS() { return CATS; }, get PURPOSES() { return PURPOSES.map(function (p) { return p.name; }); }, get LABELS() { return LABELS; },
    setRules: setRules, resetRules: resetRules, getRules: getRules, defaultRules: defaultRules, sanitize: sanitize,
    classify: classify, foodPurpose: foodPurpose, parseLabel: parseLabel, judgeLine: judgeLine, applyLabel: applyLabel, stripLabel: stripLabel, groupLines: groupLines, suggestDepts: suggestDepts
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.QuickJudge = api;
})(typeof window !== 'undefined' ? window : this);
