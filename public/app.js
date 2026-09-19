'use strict';

/* 骑马钉拼版预演前端：调用 /api/impose 获取拼版结果，用原生 Canvas 逐张绘制纸面。 */

const BINDING_TEXT = { left: '左装订', right: '右装订' };
const FLIP_TEXT = { long: '长边翻转', short: '短边翻转' };
const LEVEL_TEXT = { trim: '成品越界', bleed: '出血不足', safety: '安全余量不足' };

const CANVAS_W = 1240;
const CANVAS_H = 720;

const form = document.getElementById('imposeForm');
const errorBox = document.getElementById('errorBox');
const resultCard = document.getElementById('resultCard');
const summaryBox = document.getElementById('summary');
const sheetSelect = document.getElementById('sheetSelect');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const exportBtn = document.getElementById('exportBtn');
const canvas = document.getElementById('sheetCanvas');
const tableBody = document.querySelector('#sheetTable tbody');
const jsonPreview = document.getElementById('jsonPreview');

const state = {
  result: null,
  flat: [], // 展平的 (帖, 张) 索引，便于逐张浏览
  idx: 0,
};

/** 读取一个可能为空的数字输入：空串 -> undefined（未提供），否则为数字（合法性由服务端判定）。 */
function readOptionalNumber(id) {
  const el = document.getElementById(id);
  const raw = el.value.trim();
  return raw === '' ? undefined : Number(raw);
}

/* ------------------------------ 数据获取与渲染 ------------------------------ */

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  const payload = {
    totalPages: Number(document.getElementById('totalPages').value),
    sheetsPerSignature: Number(document.getElementById('sheetsPerSignature').value),
    binding: document.getElementById('binding').value,
    flip: document.getElementById('flip').value,
    paperThickness: Number(document.getElementById('paperThickness').value),
    maxCompensation: Number(document.getElementById('maxCompensation').value),
    paperWidth: readOptionalNumber('paperWidth'),
    paperHeight: readOptionalNumber('paperHeight'),
    pageWidth: readOptionalNumber('pageWidth'),
    pageHeight: readOptionalNumber('pageHeight'),
    bleed: readOptionalNumber('bleed'),
    safetyMargin: readOptionalNumber('safetyMargin'),
  };

  try {
    const resp = await fetch('/api/impose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || `服务器返回 ${resp.status}`);
    }
    state.result = data;
    state.flat = [];
    data.signatures.forEach((sig, si) => {
      sig.sheets.forEach((sheet, shi) => state.flat.push({ si, shi }));
    });
    state.idx = 0;
    resultCard.hidden = false;
    renderAll();
  } catch (err) {
    errorBox.textContent = `生成失败：${err.message}`;
    errorBox.hidden = false;
  }
});

prevBtn.addEventListener('click', () => {
  if (state.idx > 0) {
    state.idx -= 1;
    renderSheetNav();
    draw();
  }
});

nextBtn.addEventListener('click', () => {
  if (state.idx < state.flat.length - 1) {
    state.idx += 1;
    renderSheetNav();
    draw();
  }
});

sheetSelect.addEventListener('change', () => {
  state.idx = Number(sheetSelect.value);
  renderSheetNav();
  draw();
});

exportBtn.addEventListener('click', () => {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `imposition-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

function renderAll() {
  renderSummary();
  renderSheetNav();
  renderTable();
  jsonPreview.textContent = JSON.stringify(state.result, null, 2);
  draw();
}

function renderSummary() {
  const r = state.result;
  const chips = [
    { text: `成品 ${r.input.totalPages} 页` },
    { text: `每帖 ${r.input.sheetsPerSignature} 张（${r.pagesPerSignature} 页）` },
    { text: `共 ${r.signatureCount} 帖` },
    { text: `补白后 ${r.paddedPages} 页` },
    { text: r.blankPages > 0 ? `自动补空白页 ${r.blankPages} 页` : '无需补白', cls: r.blankPages > 0 ? 'warn' : '' },
    { text: BINDING_TEXT[r.input.binding] },
    { text: FLIP_TEXT[r.input.flip] },
    {
      text: r.creep.enabled
        ? `爬移补偿：纸厚 ${formatMm(r.input.paperThickness)} mm · 上限 ${formatMm(r.input.maxCompensation)} mm`
        : '爬移补偿：未启用',
      cls: r.creep.enabled ? 'creep' : 'creep-off',
    },
  ];
  if (r.checks) {
    const t = r.checks.totals;
    if (r.checks.fit) {
      chips.push({ text: `纸张检查：全部适配 ✓（已检 ${t.checkedSlots} 页位${t.skippedBlankSlots ? `，空白跳过 ${t.skippedBlankSlots}` : ''}）`, cls: 'check-ok' });
    } else {
      const lvl = LEVEL_TEXT[t.worstLevel] || '不合格';
      chips.push({ text: `纸张检查：${t.failedSlots}/${t.checkedSlots} 个页位不合格（最严重：${lvl}）✗`, cls: 'check-fail' });
    }
  } else {
    chips.push({ text: '纸张检查：未启用', cls: 'check-off' });
  }
  summaryBox.innerHTML = '';
  chips.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = 'chip' + (cls ? ` ${cls}` : '');
    span.textContent = text;
    summaryBox.appendChild(span);
  });
}

/** 汇总一张纸的正面/背面四个页位的检查状态。 */
function sheetCheckStats(r, sig, sheet) {
  let fail = 0;
  let checked = 0;
  ['front', 'back'].forEach((sideName) => {
    ['left', 'right'].forEach((pos) => {
      const chk = sheet[sideName][pos].check;
      if (chk && chk.status !== 'skipped') {
        checked += 1;
        if (!chk.fit) fail += 1;
      }
    });
  });
  return { fail, checked };
}

/** Canvas 面板标题用的一面检查角标状态。 */
function sideCheckStatus(side) {
  if (!side.left.check) return null;
  let fail = 0;
  let skip = 0;
  [side.left, side.right].forEach((slot) => {
    if (slot.check.status === 'skipped') skip += 1;
    else if (!slot.check.fit) fail += 1;
  });
  if (fail > 0) return { key: 'fail', text: `✗ ${fail} 个页位不合格`, color: '#e03131' };
  if (skip === 2) return { key: 'skip', text: '（空白跳过）', color: '#9aa5b8' };
  return { key: 'fit', text: '✓ 适配', color: '#2f9e44' };
}

/** 绘制面板标题：基础文字深色 + 检查状态文字彩色。 */
function drawPanelTitle(ctx, baseTitle, status, cx, y) {
  ctx.save();
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#16233b';
  const baseW = ctx.measureText(baseTitle).width;
  const gap = status ? 8 : 0;
  const statusW = status ? ctx.measureText(status.text).width : 0;
  const startX = cx - (baseW + gap + statusW) / 2;
  ctx.textAlign = 'left';
  ctx.fillText(baseTitle, startX, y);
  if (status) {
    ctx.fillStyle = status.color;
    ctx.fillText(status.text, startX + baseW + gap, y);
  }
  ctx.restore();
}

/** mm 数值格式化为两位小数（保留正负号）。 */
function formatMm(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

function renderSheetNav() {
  const r = state.result;
  sheetSelect.innerHTML = '';
  state.flat.forEach((pos, i) => {
    const sig = r.signatures[pos.si];
    const sheet = sig.sheets[pos.shi];
    const opt = document.createElement('option');
    opt.value = String(i);
    const stats = sheetCheckStats(r, sig, sheet);
    opt.textContent = `第 ${sig.index} 帖 · 第 ${sheet.index} 张` + (stats.fail > 0 ? `　✗ ${stats.fail} 个页位不合格` : '');
    sheetSelect.appendChild(opt);
  });
  sheetSelect.value = String(state.idx);
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === state.flat.length - 1;
}

function slotText(slot) {
  return slot.blank ? '空白' : `第 ${slot.page} 页`;
}

function renderTable() {
  const r = state.result;
  const creepOn = r.creep.enabled;
  const flipNote = r.input.flip === 'long'
    ? '背面：左右页位不变，内容旋转 180°'
    : '背面：左右页位互换';
  const creepNote = creepOn
    ? `爬移：左页位 ${r.input.binding === 'left' ? '+' : '−'} / 右页位 ${r.input.binding === 'left' ? '−' : '+'}，上限 ${formatMm(r.input.maxCompensation)} mm`
    : '爬移补偿未启用，offsetMm 均为 0';
  tableBody.innerHTML = '';
  r.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      [
        { name: '正面', side: sheet.front, note: '正面' },
        { name: '背面', side: sheet.back, note: flipNote },
      ].forEach(({ name, side, note }) => {
        const tr = document.createElement('tr');
        [String(sig.index), String(sheet.index), name].forEach((t) => {
          const td = document.createElement('td');
          td.textContent = t;
          tr.appendChild(td);
        });
        let rowFail = false;
        [side.left, side.right].forEach((slot) => {
          const td = document.createElement('td');
          const main = document.createElement('div');
          main.textContent = slotText(slot);
          if (slot.blank) main.className = 'slot-blank';
          td.appendChild(main);
          const off = document.createElement('div');
          off.className = 'slot-offset' + (creepOn && slot.offsetMm !== 0 ? ' nonzero' : '');
          off.textContent = `偏移 ${slot.offsetMm > 0 ? '+' : ''}${formatMm(slot.offsetMm)} mm`;
          td.appendChild(off);
          if (slot.check) {
            const chk = document.createElement('div');
            if (slot.check.status === 'skipped') {
              chk.className = 'slot-check skipped';
              chk.textContent = '空白页 · 跳过检查';
            } else if (slot.check.fit) {
              chk.className = 'slot-check fit';
              chk.textContent = '✓ 适配';
            } else {
              chk.className = 'slot-check fail';
              const lvl = worstLevel(slot.check);
              chk.textContent = `✗ ${LEVEL_TEXT[lvl]} · ${slot.check.violations.length} 项`;
              slot.check.violations.forEach((v) => {
                const item = document.createElement('div');
                item.className = `slot-violation level-${v.level}`;
                item.textContent = `· ${v.message}`;
                chk.appendChild(item);
              });
              rowFail = true;
            }
            td.appendChild(chk);
          }
          if (slot.blank) td.classList.add('blank');
          tr.appendChild(td);
        });
        if (rowFail) tr.classList.add('row-fail');
        const tdNote = document.createElement('td');
        const notes = [`${note}；${creepNote}`];
        if (checksOn) notes.push(checkSideNote(side));
        tdNote.textContent = notes.join('；');
        tr.appendChild(tdNote);
        tableBody.appendChild(tr);
      });
    });
  });
}

/** 取一个页位检查结果中的最严重级别（trim > bleed > safety）。 */
function worstLevel(chk) {
  const rank = { trim: 3, bleed: 2, safety: 1 };
  return chk.violations.reduce((best, v) => (rank[v.level] > rank[best] ? v.level : best), 'safety');
}

/** 一面两个页位的检查汇总文字（用于清单备注列）。 */
function checkSideNote(side) {
  const parts = ['left', 'right'].map((pos) => {
    const chk = side[pos].check;
    if (!chk) return '';
    if (chk.status === 'skipped') return `${pos === 'left' ? '左' : '右'}：空白跳过`;
    if (chk.fit) return `${pos === 'left' ? '左' : '右'}✓`;
    return `${pos === 'left' ? '左' : '右'}✗${chk.violations.length}项`;
  });
  return `检查：${parts.join(' / ')}`;
}

/* ------------------------------ Canvas 绘制 ------------------------------ */

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS_W * dpr;
  canvas.height = CANVAS_H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  const r = state.result;
  if (!r) return;
  const pos = state.flat[state.idx];
  const sig = r.signatures[pos.si];
  const sheet = sig.sheets[pos.shi];
  const { flip, binding } = r.input;
  const ctx = setupCanvas();

  // 背景
  ctx.fillStyle = '#f4f6fa';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // 标题区
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillText(
    `第 ${sig.index} / ${r.signatureCount} 帖 · 第 ${sheet.index} / ${sig.sheets.length} 张（本帖页码 ${sig.pageStart}–${sig.pageEnd}）`,
    40, 44
  );
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = '#5a6b85';
  const creepSubtitle = r.creep.enabled
    ? `　爬移补偿：纸厚 ${formatMm(r.input.paperThickness)} mm · 上限 ${formatMm(r.input.maxCompensation)} mm · 本张补偿 ${formatMm(r.creep.sheetCompensationMm[sheet.index - 1])} mm`
    : '　爬移补偿未启用';
  const checkSubtitle = r.checks
    ? `　纸张 ${formatMm(r.checks.paperMm.width)}×${formatMm(r.checks.paperMm.height)} mm · 成品页 ${formatMm(r.checks.pageMm.width)}×${formatMm(r.checks.pageMm.height)} mm · 出血 ${formatMm(r.checks.bleedMm)} mm · 安全 ${formatMm(r.checks.safetyMm)} mm`
    : '　纸张检查未启用';
  ctx.fillText(
    `装订：${BINDING_TEXT[binding]}　双面翻转：${FLIP_TEXT[flip]}　成品 ${r.input.totalPages} 页 · 补白 ${r.blankPages} 页 · 共 ${r.paddedPages} 页${creepSubtitle}${checkSubtitle}`,
    40, 70
  );

  // 本张纸的页位检查统计
  const sheetStats = sheetCheckStats(r, sig, sheet);
  if (r.checks && sheetStats.fail > 0) {
    ctx.fillStyle = '#e03131';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText(`⚠ 本张纸有 ${sheetStats.fail} 个页位不合格（红色框标注，页位下方列出超限原因）`, 40, 94);
  }

  const sheetW = 460;
  const sheetH = 320;
  const top = 112;
  const frontRect = { x: 70, y: top, w: sheetW, h: sheetH };
  const backRect = { x: 710, y: top, w: sheetW, h: sheetH };

  // 面板标题
  drawPanelTitle(ctx, '正面（第 1 面）', sideCheckStatus(sheet.front), frontRect.x + sheetW / 2, top - 16);
  drawPanelTitle(
    ctx,
    flip === 'long' ? '背面（第 2 面 · 内容旋转 180°）' : '背面（第 2 面）',
    sideCheckStatus(sheet.back),
    backRect.x + sheetW / 2,
    top - 16
  );

  // 爬移像素比例：示意性放大，保证最大补偿量在页位内至少留 18px 边距且不超过页位宽 35%
  const maxCreepMm = r.creep.enabled ? Math.max(...r.creep.sheetCompensationMm) : 0;
  const creepPxPerMm = maxCreepMm > 0
    ? Math.max(1, Math.min(30, (sheetW / 2 * 0.35 - 18) / maxCreepMm))
    : 0;
  const drawOpts = { creepPxPerMm, creepEnabled: r.creep.enabled };

  drawSheet(ctx, frontRect, sheet.front, { rotated: false, isBack: false, ...drawOpts });
  drawSheet(ctx, backRect, sheet.back, { rotated: flip === 'long', isBack: true, ...drawOpts });
  drawFlipDiagram(ctx, { x: 530, y: top, w: 180, h: sheetH }, flip);
  drawNotes(ctx, r.input, r.creep, r.checks);
}

/** 绘制一张纸的一面：纸面、裁切角线、左右页位、折线与骑马钉。 */
function drawSheet(ctx, rect, side, opts) {
  // 阴影 + 纸面
  ctx.save();
  ctx.fillStyle = 'rgba(15, 30, 60, 0.12)';
  roundRect(ctx, rect.x + 5, rect.y + 7, rect.w, rect.h, 4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#33415c';
  ctx.lineWidth = 1.6;
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  drawCropMarks(ctx, rect);

  const midX = rect.x + rect.w / 2;
  drawSlot(ctx, { x: rect.x, y: rect.y, w: rect.w / 2, h: rect.h }, side.left, opts, '左');
  drawSlot(ctx, { x: midX, y: rect.y, w: rect.w / 2, h: rect.h }, side.right, opts, '右');

  // 折线（订口）与骑马钉
  ctx.save();
  ctx.strokeStyle = '#d6336c';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(midX, rect.y + 2);
  ctx.lineTo(midX, rect.y + rect.h - 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#8a94a6';
  [0.28, 0.72].forEach((t) => {
    const y = rect.y + rect.h * t;
    roundRect(ctx, midX - 2.5, y - 9, 5, 18, 2.5);
    ctx.fill();
  });
  ctx.fillStyle = '#d6336c';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.save();
  ctx.translate(midX, rect.y + rect.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('折线 · 订口（骑马钉）', 0, 0);
  ctx.restore();
  ctx.restore();
}

/** 绘制一个页位：原始页位虚线框（爬移前）+ 补偿后实线框；页码 / 空白斜纹 / 页首方向 / 背面物理关系标注。 */
function drawSlot(ctx, rect, slot, opts, posName) {
  const pad = 10;

  // 爬移偏移（屏幕像素）：offsetMm 正 = 向右，负 = 向左
  let shiftPx = 0;
  if (opts.creepEnabled && slot.offsetMm) {
    shiftPx = slot.offsetMm * opts.creepPxPerMm;
    // 限制在页位内部，避免超出纸面
    const maxShift = rect.w - pad * 2 - 24;
    shiftPx = Math.max(-maxShift, Math.min(maxShift, shiftPx));
  }

  // 原始页位（爬移补偿前）：虚线框，仅在确有偏移时叠加显示
  if (shiftPx !== 0) {
    ctx.save();
    ctx.strokeStyle = '#b0691a';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(rect.x + pad, rect.y + pad, rect.w - pad * 2, rect.h - pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 补偿后的页位（整体平移 shiftPx 后按原样式绘制）
  ctx.save();
  ctx.translate(shiftPx, 0);

  const inner = { x: rect.x + pad, y: rect.y + pad, w: rect.w - pad * 2, h: rect.h - pad * 2 };
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;

  // 框线颜色：检查不合格 = 红色粗框；否则爬移后橙框、普通灰框
  const checkFail = slot.check && slot.check.status === 'fail';
  if (checkFail) {
    ctx.strokeStyle = '#e03131';
    ctx.lineWidth = 2.4;
  } else {
    ctx.strokeStyle = shiftPx !== 0 ? '#e8820c' : '#c4ccd9';
    ctx.lineWidth = shiftPx !== 0 ? 1.8 : 1;
  }
  ctx.strokeRect(inner.x, inner.y, inner.w, inner.h);

  if (slot.blank) {
    // 空白页：灰色斜纹（补偿后位置）
    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();
    ctx.strokeStyle = '#e3e8f0';
    for (let d = -inner.h; d < inner.w + inner.h; d += 12) {
      ctx.beginPath();
      ctx.moveTo(inner.x + d, inner.y);
      ctx.lineTo(inner.x + d + inner.h, inner.y + inner.h);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#9aa5b8';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('空白页', cx, cy);
    ctx.textBaseline = 'alphabetic';
  } else {
    ctx.save();
    if (opts.rotated) {
      // 长边翻转：背面内容旋转 180°（页首朝下）
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI);
      ctx.translate(-cx, -cy);
    }
    ctx.fillStyle = '#1d4ed8';
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(slot.page), cx, cy - 8);
    ctx.fillStyle = '#5a6b85';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText(`第 ${slot.page} 页`, cx, cy + 30);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('▲ 页首', cx, inner.y + (shiftPx !== 0 ? 30 : 16));
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  // 爬移偏移量标注（补偿后框内顶部）
  if (shiftPx !== 0) {
    ctx.fillStyle = '#b0691a';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const sign = slot.offsetMm > 0 ? '+' : '';
    ctx.fillText(`爬移 ${sign}${formatMm(slot.offsetMm)} mm`, cx, inner.y + 14);
  }

  // 页位角标
  ctx.fillStyle = '#8a94a6';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = posName === '左' ? 'left' : 'right';
  ctx.fillText(`${posName}页位`, posName === '左' ? inner.x + 2 : inner.x + inner.w - 2, inner.y + inner.h - 6);

  // 背面页位：标注物理上位于哪一正面页之背（折叠后阅读顺序校验）
  if (opts.isBack && !slot.blank && slot.backOf != null) {
    ctx.fillStyle = '#0f766e';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`位于正面第 ${slot.backOf} 页之背`, cx, inner.y + inner.h - 22);
  }

  // 纸张/出血/安全区检查：左上角徽标（绿✓ / 红✗ / 灰跳过）
  if (slot.check) {
    if (slot.check.status === 'skipped') {
      drawCheckBadge(ctx, inner.x + 4, inner.y + 14, '— 检查跳过（空白页）', '#9aa5b8');
    } else if (slot.check.fit) {
      drawCheckBadge(ctx, inner.x + 4, inner.y + 14, '✓ 适配', '#2f9e44');
    } else {
      const lvl = worstLevel(slot.check);
      drawCheckBadge(ctx, inner.x + 4, inner.y + 14, `✗ ${LEVEL_TEXT[lvl]}`, '#e03131');
    }
  }
  ctx.restore();

  // 不合格页位的超限原因列在页位框下方（页面坐标系，不随爬移/旋转平移）
  if (checkFail) {
    drawViolationLines(ctx, rect, pad, slot.check);
  }
}

/** 页位框内左上角检查徽标（带浅色底，避免与页码/页首标注重叠时不可读）。 */
function drawCheckBadge(ctx, x, y, text, color) {
  ctx.save();
  ctx.font = 'bold 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(x - 3, y - 11, w + 6, 15);
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y - 10);
  ctx.restore();
}

const EDGE_SHORT = { outer: '外切口', inner: '订口', top: '上', bottom: '下' };

/** 页位框下方列出该页位的全部超限原因（按级别与边缩写，最多 4 条）。 */
function drawViolationLines(ctx, rect, pad, chk) {
  const lines = chk.violations.slice(0, 4).map((v) => {
    const lvl = v.level === 'trim' ? '成品越界' : v.level === 'bleed' ? '出血不足' : '安全不足';
    const m = formatMm(v.actualMm);
    return `✗ [${lvl}] ${EDGE_SHORT[v.edge]}：实际 ${m} mm，需 ${formatMm(v.requiredMm)} mm，缺 ${formatMm(v.shortByMm)} mm`;
  });
  if (chk.violations.length > 4) lines.push(`……另 ${chk.violations.length - 4} 项`);
  ctx.save();
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const x = rect.x + 2;
  let y = rect.y + rect.h + pad;
  lines.forEach((line) => {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    const w = ctx.measureText(line).width;
    ctx.fillRect(x - 1, y - 1, w + 2, 13);
    ctx.fillStyle = '#e03131';
    ctx.fillText(line, x, y);
    y += 13;
  });
  ctx.restore();
}

/** 裁切角线。 */
function drawCropMarks(ctx, rect) {
  const len = 14;
  const gap = 5;
  const corners = [
    [rect.x, rect.y, -1, -1],
    [rect.x + rect.w, rect.y, 1, -1],
    [rect.x, rect.y + rect.h, -1, 1],
    [rect.x + rect.w, rect.y + rect.h, 1, 1],
  ];
  ctx.save();
  ctx.strokeStyle = '#8a94a6';
  ctx.lineWidth = 1;
  corners.forEach(([x, y, sx, sy]) => {
    ctx.beginPath();
    ctx.moveTo(x + sx * gap, y);
    ctx.lineTo(x + sx * (gap + len), y);
    ctx.moveTo(x, y + sy * gap);
    ctx.lineTo(x, y + sy * (gap + len));
    ctx.stroke();
  });
  ctx.restore();
}

function drawArrowHead(ctx, x, y, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-9, -5);
  ctx.lineTo(-9, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 正背面之间的翻转示意图：翻转轴 + 弧形箭头 + 说明。 */
function drawFlipDiagram(ctx, zone, flip) {
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;

  ctx.save();
  // 正面 -> 背面 大箭头
  const ay = zone.y + 34;
  ctx.strokeStyle = '#2563eb';
  ctx.fillStyle = '#2563eb';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(zone.x + 10, ay);
  ctx.lineTo(zone.x + zone.w - 20, ay);
  ctx.stroke();
  drawArrowHead(ctx, zone.x + zone.w - 10, ay, 0, '#2563eb');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('翻面印刷', cx, ay - 10);

  // 小纸张图标
  const iw = 84;
  const ih = 60;
  const ix = cx - iw / 2;
  const iy = cy - 46;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#33415c';
  ctx.lineWidth = 1.4;
  ctx.fillRect(ix, iy, iw, ih);
  ctx.strokeRect(ix, iy, iw, ih);

  const iconCy = iy + ih / 2;
  const radius = iw / 2 + 16;

  ctx.strokeStyle = '#d6336c';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  if (flip === 'short') {
    ctx.moveTo(cx, iy - 18);
    ctx.lineTo(cx, iy + ih + 18);
  } else {
    ctx.moveTo(ix - 18, iconCy);
    ctx.lineTo(ix + iw + 18, iconCy);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 弧形翻转箭头
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (flip === 'short') {
    // 绕垂直轴：上方弧形箭头（左 -> 右）
    const a0 = Math.PI * 1.18;
    const a1 = Math.PI * 1.82;
    ctx.arc(cx, iconCy, radius, a0, a1);
    ctx.stroke();
    drawArrowHead(
      ctx,
      cx + radius * Math.cos(a1),
      iconCy + radius * Math.sin(a1),
      a1 + Math.PI / 2,
      '#2563eb'
    );
  } else {
    // 绕水平轴：右侧弧形箭头（上 -> 下）
    const a0 = -Math.PI / 3;
    const a1 = Math.PI / 3;
    ctx.arc(cx, iconCy, radius, a0, a1);
    ctx.stroke();
    drawArrowHead(
      ctx,
      cx + radius * Math.cos(a1),
      iconCy + radius * Math.sin(a1),
      a1 + Math.PI / 2,
      '#2563eb'
    );
  }

  // 说明文字
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(FLIP_TEXT[flip], cx, iy + ih + 34);
  ctx.fillStyle = '#5a6b85';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(flip === 'short' ? '绕垂直短边翻转' : '绕水平长边翻转', cx, iy + ih + 54);
  ctx.fillText(flip === 'short' ? '背面左右页位互换' : '背面内容旋转 180°', cx, iy + ih + 72);
  ctx.restore();
}

/** 底部图例与规则说明。 */
function drawNotes(ctx, input, creep, checks) {
  const lines = [
    '图例：蓝色数字 = 成品页码；灰色斜纹 = 自动补齐的空白页；红色虚线 = 对折线（订口）；灰色小角线 = 裁切标记；红色粗框 = 页位检查不合格。',
    input.flip === 'long'
      ? '长边翻转：纸张绕水平长边翻转，背面左右页位与正面相同，背面内容旋转 180°（页首朝下）。'
      : '短边翻转：纸张绕垂直短边翻转，背面左右页位与正面互换，背面内容方向不变。',
    input.binding === 'left'
      ? '左装订：第 1 页位于正面右页位，书脊在左。'
      : '右装订：第 1 页位于正面左页位，书脊在右。',
    '背面每个页位标注了它物理上位于哪一正面页之背；沿折线对折并配帖装订后，页码首尾相接，阅读顺序连续。',
  ];
  if (creep && creep.enabled) {
    lines.push(
      `爬移补偿：每帖由外向内第 i 张（i 从 0 起）补偿量 = min(i × ${formatMm(input.paperThickness)} mm × 2, ${formatMm(input.maxCompensation)} mm)；画布位移为示意性放大，非真实比例。`,
      input.binding === 'left'
        ? '符号约定：左装订时左页位向外侧（+，向右）、右页位向外侧（−，向左）平移；橙色实线框为补偿后页位，橙色虚线框为原始页位。'
        : '符号约定：右装订时符号整体反转，右页位向外侧（+，向右）、左页位向外侧（−，向左）平移；橙色实线框为补偿后页位，橙色虚线框为原始页位。'
    );
  } else {
    lines.push('爬移补偿未启用（纸张厚度或最大补偿量为 0）：各页位 offsetMm 均为 0，仅显示原始拼版页位。');
  }
  if (checks && checks.enabled) {
    lines.push(
      `纸张检查：纸张 ${formatMm(checks.paperMm.width)}×${formatMm(checks.paperMm.height)} mm，成品页 ${formatMm(checks.pageMm.width)}×${formatMm(checks.pageMm.height)} mm，出血 ${formatMm(checks.bleedMm)} mm、安全边距 ${formatMm(checks.safetyMm)} mm。`,
      '判定：成品框越界（含爬移后越过折缝）= 成品越界；纸边余量小于出血要求 = 出血不足；小于安全边距 = 安全余量不足；订口侧出血允许跨缝，只查越折缝。'
    );
  }
  ctx.save();
  ctx.font = '12.5px system-ui, sans-serif';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.fillStyle = '#5a6b85';
    ctx.fillText(`· ${line}`, 70, 578 + i * 23);
  });
  ctx.restore();
}
