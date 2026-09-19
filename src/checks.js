'use strict';

/**
 * 纸张规格 / 出血 / 安全区检查。
 *
 * 几何模型（纸张平面坐标系，原点在左上角，单位 mm，一张纸对折后承载两个成品页）：
 *
 *   0 ←──────── 左页位 ──────── 折缝 ──────── 右页位 ────────→ Pw
 *   ┌──────────────┬──────────────┐  ↑
 *   │              │（订口，骑马钉）│  │
 *   │   左页位      │      右页位   │  Ph
 *   │ 外切口在左    │    外切口在右 │  │
 *   └──────────────┴──────────────┘  ↓
 *
 * - 每个页位的「可用矩形」usableRect 为纸张的一半：左 [0, Pw/2]、右 [Pw/2, Pw]。
 * - 成品框（trim）订口侧默认贴折缝放置，上下方向在纸内居中；爬移补偿后整体沿
 *   x 方向平移页位的 offsetMm（符号与拼版核心一致）。
 * - 出血框 bleedRect = 成品框向四周外扩 bleedMm。订口侧出血允许越过折缝与对侧
 *   页位跨缝拼版（cross-stitch），故订口方向不检查出血余量，只要求成品框不越过折缝。
 * - 安全框 safetyRect = 成品框向内收 safetyMm。
 * - 长边翻转时背面内容旋转 180°：页首/页脚、外切口/订口方向互换，检查结果中的
 *   contentEdge 按内容实际方向给出（几何尺寸不变）。
 *
 * 对每条纸边，以「成品框到纸边/折缝的实际余量 m」判定（m<0 表示成品框已越界）：
 *   1. m < 0                 → trim   级：成品页超出纸张（或越过折缝），致命；
 *   2. 0 ≤ m < bleedMm       → bleed  级：出血区落到纸外，出血不足；
 *   3. bleedMm ≤ m < safetyMm→ safety 级：纸边余量小于安全边距（但出血尚够）。
 * 订口边只做第 1 项检查（出血跨缝由对侧页位提供，安全边距是页内设计约束）。
 */

const EPS = 1e-9;
const MAX_DIM_MM = 10000;

const LEVEL_RANK = { trim: 3, bleed: 2, safety: 1 };

/** 保留 4 位小数，避免浮点尾数进入 JSON。 */
function round4(n) {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function rect(x, y, w, h) {
  return { x: round4(x), y: round4(y), width: round4(w), height: round4(h) };
}

function expand(r, d) {
  return rect(r.x - d, r.y - d, r.width + d * 2, r.height + d * 2);
}

function inset(r, d) {
  return rect(r.x + d, r.y + d, r.width - d * 2, r.height - d * 2);
}

/**
 * 解析长度输入：缺省返回 undefined；空串/非数字/NaN/Infinity/负数抛错。
 * @param {*} value 输入值
 * @param {string} label 错误信息中的字段名
 * @param {{positive?: boolean}} [opts] positive=true 时要求严格大于 0
 */
function parseLength(value, label, { positive = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) {
    throw new Error(`${label}必须为 ≥ 0 的数字（单位 mm）`);
  }
  if (positive && n === 0) {
    throw new Error(`${label}必须大于 0（单位 mm）`);
  }
  if (n > MAX_DIM_MM) {
    throw new Error(`${label}不能超过 ${MAX_DIM_MM} mm`);
  }
  return n;
}

/**
 * 解析纸张 / 成品页 / 出血 / 安全区参数。
 * 纸张宽高与成品页宽高四项必须同时提供（任一提供即视为启用检查，缺项报错）；
 * 出血与安全边距可缺省，缺省为 0。
 *
 * @returns {{enabled: false} | {enabled: true, paperMm:{width,height}, pageMm:{width,height}, bleedMm:number, safetyMm:number}}
 */
function parseChecks(input) {
  const raw = input || {};
  const keys = ['paperWidth', 'paperHeight', 'pageWidth', 'pageHeight'];
  const provided = keys.some((k) => raw[k] !== undefined && raw[k] !== null && !(typeof raw[k] === 'string' && raw[k].trim() === ''));
  if (!provided) {
    return { enabled: false };
  }

  const paperWidth = parseLength(raw.paperWidth, '纸张宽度', { positive: true });
  const paperHeight = parseLength(raw.paperHeight, '纸张高度', { positive: true });
  const pageWidth = parseLength(raw.pageWidth, '成品页宽度', { positive: true });
  const pageHeight = parseLength(raw.pageHeight, '成品页高度', { positive: true });
  if ([paperWidth, paperHeight, pageWidth, pageHeight].some((n) => n === undefined)) {
    throw new Error('启用纸张检查时必须同时提供纸张宽高与成品页宽高（共 4 项）');
  }

  const bleedMm = parseLength(raw.bleed, '出血', { positive: false }) ?? 0;
  const safetyMm = parseLength(raw.safetyMargin, '安全边距', { positive: false }) ?? 0;

  if (safetyMm * 2 > pageWidth + EPS || safetyMm * 2 > pageHeight + EPS) {
    throw new Error('安全边距不能超过成品页宽度或高度的一半');
  }

  return {
    enabled: true,
    paperMm: { width: paperWidth, height: paperHeight },
    pageMm: { width: pageWidth, height: pageHeight },
    bleedMm,
    safetyMm,
  };
}

const EDGE_LABEL = { outer: '外切口', inner: '订口（折缝侧）', top: '页首方向（上）', bottom: '页脚方向（下）' };

/** 长边翻转背面旋转 180° 时，内容方向与纸张方向的对应互换。 */
function contentEdgeOf(edge, rotated) {
  if (!rotated) return edge;
  if (edge === 'outer') return 'inner';
  if (edge === 'inner') return 'outer';
  if (edge === 'top') return 'bottom';
  return 'top';
}

/** 格式化 mm 数值（调用方传入非负量；负余量由消息模板统一加 − 前缀）。 */
function fmt(n) {
  return String(round4(n));
}

/**
 * 计算单个页位的检查结果（不修改页位对象本身）。
 *
 * @param {object} slot 拼版页位（含 offsetMm）
 * @param {'left'|'right'} position 左/右页位
 * @param {boolean} rotated 该页位内容是否旋转 180°（长边翻转的背面）
 * @param {object} cfg parseChecks 返回的启用配置
 */
function checkSlot(slot, position, rotated, cfg) {
  const { paperMm, pageMm, bleedMm, safetyMm } = cfg;
  const Pw = paperMm.width;
  const Ph = paperMm.height;
  const fold = Pw / 2;
  const off = slot.offsetMm || 0;
  const y0 = (Ph - pageMm.height) / 2;

  let trimRect;
  let usableRect;
  let margins;
  if (position === 'left') {
    // 左页位：订口在右（折缝），外切口在左
    trimRect = rect(fold - pageMm.width + off, y0, pageMm.width, pageMm.height);
    usableRect = rect(0, 0, fold, Ph);
    margins = {
      outer: round4(trimRect.x),            // 外切口：成品框左边到纸张左边
      inner: round4(fold - (trimRect.x + trimRect.width)), // 订口：成品框右边到折缝
      top: round4(y0),
      bottom: round4(y0),
    };
  } else {
    // 右页位：订口在左（折缝），外切口在右
    trimRect = rect(fold + off, y0, pageMm.width, pageMm.height);
    usableRect = rect(fold, 0, fold, Ph);
    margins = {
      inner: round4(trimRect.x - fold),     // 订口：成品框左边到折缝
      outer: round4(Pw - (trimRect.x + trimRect.width)), // 外切口：纸张右边到成品框右边
      top: round4(y0),
      bottom: round4(y0),
    };
  }

  const bleedRect = expand(trimRect, bleedMm);
  const safetyRect = inset(trimRect, safetyMm);

  const base = {
    status: 'skipped',
    fit: null,
    rotated,
    orientation: rotated ? 'rotated180' : 'upright',
    usableRect,
    trimRect,
    bleedRect,
    safetyRect,
    margins,
    violations: [],
  };

  // 空白页：没有实际成品内容，仅给出几何信息，不参与合格判定。
  if (slot.blank) {
    return { ...base, status: 'skipped', reason: 'blank' };
  }

  const violations = [];
  const add = (edge, level, requiredMm, actualMm, shortByMm, message) => {
    violations.push({
      level,
      edge,
      contentEdge: contentEdgeOf(edge, rotated),
      requiredMm: round4(requiredMm),
      actualMm: round4(actualMm),
      shortByMm: round4(shortByMm),
      message,
    });
  };

  // 订口边：只检查成品框是否越过折缝（出血允许跨缝，不检查出血/安全余量）
  (() => {
    const m = margins.inner;
    if (m < -EPS) {
      add('inner', 'trim', 0, m, -m, `成品框越过折缝进入对侧页位 ${fmt(-m)} mm（爬移偏移后订口侧成品页相互重叠）`);
    }
  })();

  // 外切口 / 上 / 下：成品、出血、安全三级余量检查
  ['outer', 'top', 'bottom'].forEach((edge) => {
    const m = margins[edge];
    if (m < -EPS) {
      add(edge, 'trim', 0, m, -m, `成品页超出纸边：${EDGE_LABEL[edge]}余量为 −${fmt(-m)} mm（应 ≥ 0）`);
      return;
    }
    if (m + EPS < bleedMm) {
      add(edge, 'bleed', bleedMm, m, bleedMm - m,
        `出血不足：${EDGE_LABEL[edge]}实际余量 ${fmt(m)} mm < 出血要求 ${round4(bleedMm)} mm（缺 ${fmt(bleedMm - m)} mm）`);
    }
    if (m + EPS < safetyMm) {
      add(edge, 'safety', safetyMm, m, safetyMm - m,
        `安全余量不足：${EDGE_LABEL[edge]}实际余量 ${fmt(m)} mm < 安全边距 ${round4(safetyMm)} mm（缺 ${fmt(safetyMm - m)} mm）`);
    }
  });

  const fit = violations.length === 0;
  return { ...base, status: fit ? 'fit' : 'fail', fit, violations };
}

/**
 * 遍历拼版结果，给每个页位附加 check，并汇总检查统计。
 *
 * @param {object} cfg parseChecks 返回的配置（enabled=false 时返回 null）
 * @param {object} result computeImposition 的拼版结果
 * @returns {object|null} 顶层检查结果（挂到 result.checks），未启用时为 null
 */
function attachChecks(cfg, result) {
  if (!cfg || !cfg.enabled) return null;

  let checked = 0;
  let skipped = 0;
  let fitSlots = 0;
  let failedSlots = 0;
  let maxLevel = null;

  const visit = (side, isBack) => {
    ['left', 'right'].forEach((position) => {
      const slot = side[position];
      const rotated = isBack && result.input.flip === 'long';
      const chk = checkSlot(slot, position, rotated, cfg);
      slot.check = chk;
      if (chk.status === 'skipped') {
        skipped += 1;
      } else {
        checked += 1;
        if (chk.fit) fitSlots += 1;
        else {
          failedSlots += 1;
          chk.violations.forEach((v) => {
            if (!maxLevel || LEVEL_RANK[v.level] > LEVEL_RANK[maxLevel]) maxLevel = v.level;
          });
        }
      }
    });
  };

  result.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      visit(sheet.front, false);
      visit(sheet.back, true);
    });
  });

  return {
    enabled: true,
    paperMm: { width: cfg.paperMm.width, height: cfg.paperMm.height },
    pageMm: { width: cfg.pageMm.width, height: cfg.pageMm.height },
    bleedMm: cfg.bleedMm,
    safetyMm: cfg.safetyMm,
    totals: {
      slots: checked + skipped,
      checkedSlots: checked,
      skippedBlankSlots: skipped,
      fitSlots,
      failedSlots,
      worstLevel: maxLevel, // 'trim' | 'bleed' | 'safety' | null
    },
    fit: failedSlots === 0,
  };
}

module.exports = { parseChecks, attachChecks, checkSlot };
