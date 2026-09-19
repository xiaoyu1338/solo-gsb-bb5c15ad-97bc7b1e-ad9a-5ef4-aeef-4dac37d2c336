'use strict';

/**
 * 骑马钉（saddle-stitch）拼版计算核心。
 *
 * 基本概念：
 * - 一「帖」由若干张纸叠放后对折而成；每张纸正、反面各印 2 页，
 *   故 每帖页数 = 每帖张数 × 4。
 * - 同一帖内，第 i 张纸（由外向内，i 从 0 起）：
 *     小号页对 = start + 2i（正面）与 start + 2i + 1（其背面）
 *     大号页对 = end   - 2i（正面）与 end   - 2i - 1（其背面）
 * - 装订方向决定正面左右页位：
 *     左装订：正面左位放大号页、右位放小号页（第 1 页在右侧，书脊在左）；
 *     右装订：镜像（第 1 页在左侧，书脊在右）。
 * - 背面页位按双面翻转方式做坐标变换（纸张坐标系，与正面同一视角）：
 *     长边翻转：绕水平长边翻转，(x, y) -> (x, H - y)，左右页位不变，内容旋转 180°；
 *     短边翻转：绕垂直短边翻转，(x, y) -> (W - x, y)，左右页位互换，内容方向不变。
 * - 成品页数不足整帖时，在末尾自动补空白页。
 *
 * 爬移补偿（creep compensation）：
 * - 内帖书背处向外隆起，内层纸页裁切后会比外层短，需要把内层页位向外侧平移补偿。
 * - 每帖第 i 张纸（由外向内，i 从 0 起）的补偿量：
 *     creep = min(i × 纸张厚度 × 2, 最大补偿量)（单位 mm）
 *   （乘 2 是因为每张纸在折缝两侧各贡献一个厚度；每帖独立从 i=0 起算。）
 * - 偏移符号：左装订时左页位取正、右页位取负；右装订时符号整体反转。
 * - 每个页位（含空白页）都带 offsetMm；纸张厚度或最大补偿量任一为 0（或缺省）时
 *   全部 offsetMm 为 0，页码拼版结果与不启用时完全一致。
 *
 * 纸张规格 / 出血 / 安全区检查（可选，见 checks.js）：
 * - 传入纸张宽高、成品页宽高（出血与安全边距可选）后，按每个正/背面页位的实际方向
 *   （长边翻转的背面内容旋转 180°）计算可用矩形、成品框、出血框、安全框并判定是否适配；
 * - 检查结果挂在每个页位的 check 字段与顶层 checks 汇总；缺省不传时 checks 为 null，
 *   页码拼版算法与旧版完全一致。
 */

const MAX_TOTAL_PAGES = 10000;
const MAX_SHEETS_PER_SIGNATURE = 100;

const { parseChecks, attachChecks } = require('./checks');

function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 解析非负长度参数（mm）。
 * 缺省（undefined / null）视为 0（不启用）；空串等非法值返回 NaN 由调用方报错。
 */
function toNonNegativeMm(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

/** 保留 4 位小数，避免 0.1×3×2 这一类浮点尾数进入 JSON。 */
function round4(n) {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

/** 生成一个页位；超出成品页数的页位为空白页。 */
function makeSlot(page, totalPages) {
  if (page > totalPages) {
    return { page: null, blank: true };
  }
  return { page, blank: false };
}

/**
 * 计算整本册子的拼版。
 *
 * @param {object} input
 * @param {number} input.totalPages         成品页数（≥1 的整数）
 * @param {number} input.sheetsPerSignature 每帖张数（≥1 的整数）
 * @param {string} input.binding            装订方式：'left' | 'right'
 * @param {string} input.flip               双面翻转方式：'long' | 'short'
 * @param {number} [input.paperThickness]   纸张厚度（mm，≥0，缺省 0 = 不做爬移补偿）
 * @param {number} [input.maxCompensation]  爬移最大补偿量（mm，≥0，缺省 0 = 不做爬移补偿）
 * @param {number} [input.paperWidth]       纸张宽度（mm，>0，与其余 3 个尺寸项同时提供才启用纸张检查）
 * @param {number} [input.paperHeight]      纸张高度（mm，>0）
 * @param {number} [input.pageWidth]        成品页宽度（mm，>0）
 * @param {number} [input.pageHeight]       成品页高度（mm，>0）
 * @param {number} [input.bleed]            出血（mm，≥0，缺省 0）
 * @param {number} [input.safetyMargin]     安全边距（mm，≥0，缺省 0；不得超过成品页宽/高的一半）
 * @returns {object} 拼版结果（按帖 -> 张 -> 正/背面 -> 左/右页位；启用检查时每个页位带 check，顶层带 checks 汇总）
 */
function computeImposition(input) {
  const totalPages = toInteger(input && input.totalPages);
  const sheetsPerSignature = toInteger(input && input.sheetsPerSignature);
  const binding = input && input.binding;
  const flip = input && input.flip;
  const paperThickness = toNonNegativeMm(input && input.paperThickness);
  const maxCompensation = toNonNegativeMm(input && input.maxCompensation);

  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > MAX_TOTAL_PAGES) {
    throw new Error(`成品页数必须为 1 ~ ${MAX_TOTAL_PAGES} 的整数`);
  }
  if (!Number.isInteger(sheetsPerSignature) || sheetsPerSignature < 1 || sheetsPerSignature > MAX_SHEETS_PER_SIGNATURE) {
    throw new Error(`每帖张数必须为 1 ~ ${MAX_SHEETS_PER_SIGNATURE} 的整数`);
  }
  if (binding !== 'left' && binding !== 'right') {
    throw new Error("装订方式必须为 'left'（左装订）或 'right'（右装订）");
  }
  if (flip !== 'long' && flip !== 'short') {
    throw new Error("双面翻转方式必须为 'long'（长边翻转）或 'short'（短边翻转）");
  }
  if (Number.isNaN(paperThickness)) {
    throw new Error('纸张厚度必须为 ≥ 0 的数字（单位 mm）');
  }
  if (Number.isNaN(maxCompensation)) {
    throw new Error('最大补偿量必须为 ≥ 0 的数字（单位 mm）');
  }

  // 纸张规格 / 出血 / 安全区检查参数（全部缺省时不启用，向后兼容）。
  // 参数合法性错误直接抛出，与其它参数一样由接口返回 400。
  const checkConfig = parseChecks(input);

  const pagesPerSignature = sheetsPerSignature * 4;
  const signatureCount = Math.ceil(totalPages / pagesPerSignature);
  const paddedPages = signatureCount * pagesPerSignature;

  // 爬移补偿：每帖独立从最外层（i=0）起算，故各帖同序号纸张的补偿量相同。
  // 任一参数为 0 时补偿量恒为 0，拼版页位与原结果完全一致。
  const creepEnabled = paperThickness > 0 && maxCompensation > 0;
  const sheetCompensationMm = [];
  for (let i = 0; i < sheetsPerSignature; i++) {
    const creep = creepEnabled ? Math.min(i * paperThickness * 2, maxCompensation) : 0;
    sheetCompensationMm.push(round4(creep));
  }
  // 左装订：左页位为正、右页位为负；右装订：符号整体反转。
  const sideSign = binding === 'left' ? 1 : -1;

  const signatures = [];
  for (let s = 0; s < signatureCount; s++) {
    const start = s * pagesPerSignature + 1;
    const end = start + pagesPerSignature - 1;
    const sheets = [];

    for (let i = 0; i < sheetsPerSignature; i++) {
      const lowFront = start + 2 * i; // 小号页（正面）
      const lowBack = lowFront + 1;   // 小号页之背
      const highFront = end - 2 * i;  // 大号页（正面）
      const highBack = highFront - 1; // 大号页之背

      // 正面左右页位（左装订：第 1 页在右；右装订镜像）
      const frontLeft = binding === 'left' ? highFront : lowFront;
      const frontRight = binding === 'left' ? lowFront : highFront;

      // 各正面页位「物理正后方」应承接的页（保证折叠后阅读顺序连续）
      const behindLeft = binding === 'left' ? highBack : lowBack;
      const behindRight = binding === 'left' ? lowBack : highBack;

      // 背面坐标变换：
      //   长边翻转 (x,y)->(x,H-y)：左右页位不变，背面内容需旋转 180°；
      //   短边翻转 (x,y)->(W-x,y)：左右页位互换，背面内容方向不变。
      const backLeft = flip === 'long' ? behindLeft : behindRight;
      const backRight = flip === 'long' ? behindRight : behindLeft;

      const front = {
        left: makeSlot(frontLeft, totalPages),
        right: makeSlot(frontRight, totalPages),
      };
      const back = {
        left: makeSlot(backLeft, totalPages),
        right: makeSlot(backRight, totalPages),
      };

      // 爬移偏移量：正反面同方向（由装订侧决定），空白页同样保留偏移。
      const creep = sheetCompensationMm[i];
      front.left.offsetMm = round4(sideSign * creep);
      front.right.offsetMm = round4(-sideSign * creep);
      back.left.offsetMm = round4(sideSign * creep);
      back.right.offsetMm = round4(-sideSign * creep);

      // 标注每个背面页位物理上位于哪一正面页之后（用于校验折叠后的阅读顺序）
      back.left.backOf = flip === 'long' ? front.left.page : front.right.page;
      back.right.backOf = flip === 'long' ? front.right.page : front.left.page;

      sheets.push({ index: i + 1, front, back });
    }

    signatures.push({ index: s + 1, pageStart: start, pageEnd: end, sheets });
  }

  // 未启用检查时 input 回显保持原样（旧调用方输出不变）；启用时追加纸张规格字段。
  const inputEcho = { totalPages, sheetsPerSignature, binding, flip, paperThickness, maxCompensation };
  if (checkConfig.enabled) {
    inputEcho.paperWidth = checkConfig.paperMm.width;
    inputEcho.paperHeight = checkConfig.paperMm.height;
    inputEcho.pageWidth = checkConfig.pageMm.width;
    inputEcho.pageHeight = checkConfig.pageMm.height;
    inputEcho.bleed = checkConfig.bleedMm;
    inputEcho.safetyMargin = checkConfig.safetyMm;
  }

  const result = {
    meta: {
      app: 'saddle-stitch-imposition',
      version: '1.2.0',
      generatedAt: new Date().toISOString(),
    },
    input: inputEcho,
    pagesPerSignature,
    signatureCount,
    paddedPages,
    blankPages: paddedPages - totalPages,
    creep: {
      paperThickness,
      maxCompensation,
      enabled: creepEnabled,
      // 每帖由外向内第 i 张纸的补偿量（mm），各帖相同
      sheetCompensationMm,
    },
    signatures,
  };

  // 纸张 / 出血 / 安全区检查：未启用时 checks 为 null，页码拼版算法结果完全不变。
  result.checks = attachChecks(checkConfig, result);

  return result;
}

module.exports = { computeImposition };
