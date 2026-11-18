/* 發票照片放大鏡（電腦用）：滑鼠游標移到發票照片的縮圖上，旁邊會浮出一個放大的視窗；游標在縮圖上移動，放大的位置跟著移動（像放大鏡），可以看清楚小字。
 * 只在有滑鼠的裝置啟用（手機沒有「游標移上去」）；套用在「發票登錄」的預覽縮圖（.ocr-preview）與批次登錄每張發票的縮圖（.batch-preview）。
 * 這個檔案不依賴主程式：用事件代理，縮圖重新產生（批次清單重畫）也照常運作。 */
(function (root) {
  if (!root.matchMedia || !root.matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  var SEL = 'img.ocr-preview,img.batch-preview';
  var ZOOM = 2.2;       // 放大視窗裡的照片寬度＝視窗寬度的幾倍（約等於原圖大小，小字才看得清楚）
  var pop = null, cur = null;

  function ensure() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'imgZoom';
    pop.setAttribute('aria-hidden', 'true');
    pop.style.cssText = 'position:fixed;z-index:3000;display:none;pointer-events:none;border:2px solid #315c9c;border-radius:8px;background:#fff no-repeat;box-shadow:0 10px 34px rgba(0,0,0,.38)';
    document.body.appendChild(pop);
    return pop;
  }
  function hide() { if (pop) pop.style.display = 'none'; cur = null; }

  function show(img) {
    var p = ensure(), vw = root.innerWidth, vh = root.innerHeight, r = img.getBoundingClientRect();
    if (!img.currentSrc && !img.src) return;
    var w = Math.min(Math.round(vw * 0.46), 640);
    var aspect = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 0.75;
    aspect = Math.max(0.7, Math.min(1.5, aspect));
    var h = Math.min(Math.round(w * aspect), Math.round(vh * 0.85));
    var left = r.right + 14;
    if (left + w > vw - 8) left = r.left - w - 14;   // 右邊放不下就放左邊
    if (left < 8) left = 8;
    var top = Math.max(8, Math.min(r.top, vh - h - 8));
    p.style.width = w + 'px'; p.style.height = h + 'px'; p.style.left = left + 'px'; p.style.top = top + 'px';
    p.style.backgroundImage = 'url("' + (img.currentSrc || img.src) + '")';
    p.style.backgroundSize = Math.round(w * ZOOM) + 'px auto';
    p.style.display = 'block';
  }
  function move(e) {
    if (!cur || !pop) return;
    if (!document.contains(cur)) { hide(); return; }   // 縮圖被重畫掉了
    var r = cur.getBoundingClientRect();
    var x = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
    var y = Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1)));
    pop.style.backgroundPosition = (x * 100).toFixed(1) + '% ' + (y * 100).toFixed(1) + '%';
  }

  document.addEventListener('mouseover', function (e) {
    var img = e.target && e.target.closest ? e.target.closest(SEL) : null;
    if (!img || img === cur) return;
    cur = img; show(img); move(e);
  });
  document.addEventListener('mousemove', function (e) { if (cur) move(e); });
  document.addEventListener('mouseout', function (e) {
    if (!cur) return;
    var to = e.relatedTarget;
    if (!to || !cur.contains(to)) hide();
  });
  ['scroll', 'resize', 'blur', 'keydown'].forEach(function (ev) { root.addEventListener(ev, hide, true); });
  // 縮圖在 CSS 裡標示可以放大（游標變放大鏡）
  var st = document.createElement('style');
  st.textContent = 'img.ocr-preview,img.batch-preview{cursor:zoom-in}';
  document.head.appendChild(st);
})(typeof window !== 'undefined' ? window : this);
