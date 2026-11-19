/* 憑證類型（使用者 2026-11-18：「發票號碼正常可以用偵測 QR Code 匯入，那有些是收據或者是證明而已，所以你要幫我做成可以下拉式選單選收據」）
 * 統一發票（預設）：有發票號碼（QR code／文字辨識讀得到），發票號碼是必填。
 * 收據、證明：沒有發票號碼（手寫的免用統一發票收據、支出證明…），號碼可以留空——存檔時系統自動編一個（例如「收據-20261115-K7QZ」），這樣清單、重複檢查才都照常運作。
 * 存在發票紀錄的 docType 欄位（invoice／receipt／proof；舊資料沒有這個欄位＝統一發票）。純函式，Node 也能測（開發工具/test-doc-type.cjs）。 */
(function (root) {
  'use strict';
  var TYPES = [{ id: 'invoice', label: '統一發票' }, { id: 'receipt', label: '收據' }, { id: 'proof', label: '證明' }];
  function norm(t) { return t === 'receipt' || t === 'proof' ? t : 'invoice'; }
  function label(t) { t = norm(t); for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === t) return TYPES[i].label; return '統一發票'; }
  // 號碼欄位的標題：統一發票必填；收據、證明可以留空
  function noLabel(t) { t = norm(t); return t === 'invoice' ? '發票號碼 *' : label(t) + '號碼（沒有可留空）'; }
  // 沒有號碼時自動編號：收據-20261115-K7QZ（日期用發票日期；沒有日期用今天）
  function genNo(t, date) {
    var d = String(date || '').replace(/[^0-9]/g, '').slice(0, 8);
    if (d.length < 8) { var n = new Date(); d = '' + n.getFullYear() + ('0' + (n.getMonth() + 1)).slice(-2) + ('0' + n.getDate()).slice(-2); }
    var r = '', abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; for (var i = 0; i < 4; i++) r += abc.charAt(Math.floor(Math.random() * abc.length));
    return label(t) + '-' + d + '-' + r;
  }
  // 從辨識出來的文字猜是不是收據／證明（只在沒有發票號碼、沒有 QR code 的時候用）。回傳 'receipt'、'proof' 或 ''（沒把握就不猜）
  function guess(text) {
    var s = String(text == null ? '' : text).normalize('NFKC').replace(/\s+/g, '');
    if (!s) return '';
    var einv = /電子發票|發票號碼|證明聯|隨機碼|發票金額/.test(s);
    if (/免用統一發票|免用發票|統一發票收據|收據專用章/.test(s)) return 'receipt';
    if (!einv && /收據/.test(s)) return 'receipt';
    if (!einv && /支出證明|證明單|證明書/.test(s)) return 'proof';
    return '';
  }
  var api = { TYPES: TYPES, norm: norm, label: label, noLabel: noLabel, genNo: genNo, guess: guess };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DocType = api;
})(typeof window !== 'undefined' ? window : this);
