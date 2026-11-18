/* 發票照片放大（電腦用）：滑鼠移到發票照片的縮圖上，旁邊會浮出「整張照片」放大的視窗（縮到螢幕放得下的最大尺寸、維持原本比例，不裁切、不隨游標移動）；游標移開就收起來。
 * 只在有滑鼠的裝置啟用（手機沒有「游標移上去」）；套用在「發票登錄」的預覽縮圖（.ocr-preview）與批次登錄每張發票的縮圖（.batch-preview）。
 * 這個檔案不依賴主程式：用事件代理，縮圖重新產生（批次清單重畫）也照常運作。 */
(function (root) {
  if (!root.matchMedia || !root.matchMedia('(hover:hover) and (pointer:fine)').matches) return;
  var SEL = 'img.ocr-preview,img.batch-preview';
  var GAP = 14, MARGIN = 8;
  var pop = null, cur = null;

  function ensure() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = 'imgZoom';
    pop.setAttribute('aria-hidden', 'true');
    pop.style.cssText = 'position:fixed;z-index:3000;display:none;pointer-events:none;border:2px solid #315c9c;border-radius:8px;background:#fff center/100% 100% no-repeat;box-shadow:0 10px 34px rgba(0,0,0,.38)';
    document.body.appendChild(pop);
    return pop;
  }
  function hide() { if (pop) pop.style.display = 'none'; cur = null; }

  function show(img) {
    var src = img.currentSrc || img.src;
    if (!src) return;
    var p = ensure(), vw = root.innerWidth, vh = root.innerHeight, r = img.getBoundingClientRect();
    var nw = img.naturalWidth || r.width || 1, nh = img.naturalHeight || r.height || 1;
    // 放在縮圖左右兩邊中空間比較大的那一邊；整張照片縮到放得下的最大尺寸（不放大超過照片本身的像素，避免變糊）
    var roomR = vw - r.right - GAP - MARGIN, roomL = r.left - GAP - MARGIN;
    var onRight = roomR >= roomL, room = Math.max(60, onRight ? roomR : roomL);
    var maxW = Math.min(room, Math.round(vw * 0.7)), maxH = vh - MARGIN * 2;
    var scale = Math.min(maxW / nw, maxH / nh, 1);
    var w = Math.max(40, Math.round(nw * scale)), h = Math.max(40, Math.round(nh * scale));
    var left = onRight ? r.right + GAP : r.left - GAP - w;
    var top = Math.max(MARGIN, Math.round((vh - h) / 2));
    p.style.width = w + 'px'; p.style.height = h + 'px'; p.style.left = Math.max(MARGIN, left) + 'px'; p.style.top = top + 'px';
    p.style.backgroundImage = 'url("' + src + '")';
    p.style.display = 'block';
  }

  document.addEventListener('mouseover', function (e) {
    var img = e.target && e.target.closest ? e.target.closest(SEL) : null;
    if (!img || img === cur) return;
    cur = img; show(img);
  });
  document.addEventListener('mouseout', function (e) {
    if (!cur) return;
    var to = e.relatedTarget;
    if (!to || !cur.contains(to)) hide();
  });
  ['scroll', 'resize', 'blur', 'keydown'].forEach(function (ev) { root.addEventListener(ev, hide, true); });
})(typeof window !== 'undefined' ? window : this);
