'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { computeImposition } = require('../src/imposition');
const { parseChecks } = require('../src/checks');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
// SRA3 450×320 + A4 210×297：半张 225×320，外/上/下余量 (15, 11.5, 11.5)
const FIT = { paperWidth: 450, paperHeight: 320, pageWidth: 210, pageHeight: 297, bleed: 3, safetyMargin: 5 };

test('未传纸张参数：checks 为 null，页位上没有 check 字段（向后兼容）', () => {
  const r = computeImposition({ ...BASE });
  assert.equal(r.checks, null);
  const slot = r.signatures[0].sheets[0].front.left;
  assert.equal(slot.check, undefined);
});

test('空字符串与 null 均视为未启用', () => {
  const r = computeImposition({
    ...BASE, paperWidth: '', paperHeight: '', pageWidth: '', pageHeight: '',
    bleed: '', safetyMargin: null,
  });
  assert.equal(r.checks, null);
});

test('适配用例：SRA3 + A4 + 出血3 + 安全5，所有页位 fit', () => {
  const r = computeImposition({ ...BASE, ...FIT });
  assert.equal(r.checks.enabled, true);
  assert.equal(r.checks.fit, true);
  assert.deepEqual(r.checks.totals, {
    slots: 8, checkedSlots: 8, skippedBlankSlots: 0, fitSlots: 8, failedSlots: 0, worstLevel: null,
  });
  const slot = r.signatures[0].sheets[0].front.left;
  assert.equal(slot.check.status, 'fit');
  assert.equal(slot.check.fit, true);
  assert.deepEqual(slot.check.violations, []);
  assert.deepEqual(slot.check.usableRect, { x: 0, y: 0, width: 225, height: 320 });
  assert.deepEqual(slot.check.trimRect, { x: 15, y: 11.5, width: 210, height: 297 });
  assert.deepEqual(slot.check.bleedRect, { x: 12, y: 8.5, width: 216, height: 303 });
  assert.deepEqual(slot.check.safetyRect, { x: 20, y: 16.5, width: 200, height: 287 });
  assert.deepEqual(slot.check.margins, { outer: 15, inner: 0, top: 11.5, bottom: 11.5 });
  // 右页位可用矩形从折缝开始
  const right = r.signatures[0].sheets[0].front.right;
  assert.deepEqual(right.check.usableRect, { x: 225, y: 0, width: 225, height: 320 });
  assert.deepEqual(right.check.trimRect, { x: 225, y: 11.5, width: 210, height: 297 });
  assert.deepEqual(right.check.margins, { inner: 0, outer: 15, top: 11.5, bottom: 11.5 });
});

test('出血/安全缺省为 0：纸张恰好等于 2×成品页时适配', () => {
  const r = computeImposition({
    ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297,
  });
  assert.equal(r.checks.bleedMm, 0);
  assert.equal(r.checks.safetyMm, 0);
  assert.equal(r.checks.fit, true);
});

test('纸张恰好但出血>0：外/上/下报 bleed 与 safety，订口不报', () => {
  const r = computeImposition({
    ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297,
    bleed: 3, safetyMargin: 5,
  });
  assert.equal(r.checks.fit, false);
  assert.equal(r.checks.totals.worstLevel, 'bleed');
  const edges = r.signatures[0].sheets[0].front.left.check.violations.map((v) => `${v.level}/${v.edge}`);
  assert.deepEqual(edges.sort(), ['bleed/bottom', 'bleed/outer', 'bleed/top', 'safety/bottom', 'safety/outer', 'safety/top']);
});

test('成品页超出纸边：trim 级超限，shortByMm 为超出量', () => {
  const r = computeImposition({
    ...BASE, paperWidth: 400, paperHeight: 290, pageWidth: 210, pageHeight: 297,
    bleed: 3, safetyMargin: 5,
  });
  assert.equal(r.checks.totals.worstLevel, 'trim');
  const v = r.signatures[0].sheets[0].front.left.check.violations;
  // 外切口余量 = 200-210 = -10；上下余量 = (290-297)/2 = -3.5
  const outer = v.find((x) => x.edge === 'outer');
  assert.equal(outer.level, 'trim');
  assert.equal(outer.actualMm, -10);
  assert.equal(outer.shortByMm, 10);
  const top = v.find((x) => x.edge === 'top');
  assert.equal(top.level, 'trim');
  assert.equal(top.actualMm, -3.5);
  assert.equal(top.shortByMm, 3.5);
  // trim 越界时不再重复报 bleed/safety
  assert.ok(v.every((x) => x.level === 'trim'));
});

test('安全余量够但出血不足：只报 bleed 级', () => {
  // 半张 214×301：外余量 4（>=安全3 但 <出血5），上余量 2（<安全3）
  const r = computeImposition({
    ...BASE, paperWidth: 428, paperHeight: 301, pageWidth: 210, pageHeight: 297,
    bleed: 5, safetyMargin: 3,
  });
  const v = r.signatures[0].sheets[0].front.left.check.violations;
  const outer = v.filter((x) => x.edge === 'outer').map((x) => x.level);
  assert.deepEqual(outer, ['bleed']);
  const top = v.filter((x) => x.edge === 'top').map((x) => x.level);
  assert.deepEqual(top.sort(), ['bleed', 'safety']);
});

test('长边翻转：背面页位标记 rotated180，内容方向边互换；短边翻转不旋转', () => {
  const r = computeImposition({
    totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'long',
    paperWidth: 400, paperHeight: 290, pageWidth: 210, pageHeight: 297, bleed: 3,
  });
  const back = r.signatures[0].sheets[0].back.left;
  assert.equal(back.check.orientation, 'rotated180');
  const edges = back.check.violations.map((v) => [v.edge, v.contentEdge]);
  // 纸张方向的外切口在内容上是订口侧；上↔下互换
  assert.deepEqual(edges.find(([e]) => e === 'outer'), ['outer', 'inner']);
  assert.deepEqual(edges.find(([e]) => e === 'top'), ['top', 'bottom']);
  assert.deepEqual(edges.find(([e]) => e === 'bottom'), ['bottom', 'top']);

  const r2 = computeImposition({
    totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short',
    paperWidth: 400, paperHeight: 290, pageWidth: 210, pageHeight: 297, bleed: 3,
  });
  assert.equal(r2.signatures[0].sheets[0].back.left.check.orientation, 'upright');
  assert.equal(r2.signatures[0].sheets[0].front.left.check.orientation, 'upright');
});

test('爬移偏移纳入可用矩形计算：内层页位越过折缝报 trim/inner', () => {
  // 4 张/帖，纸厚 1mm：i=2 -> ±4mm；A3/A4 外尺寸恰好，外侧同时报出血
  const r = computeImposition({
    totalPages: 16, sheetsPerSignature: 4, binding: 'left', flip: 'short',
    paperThickness: 1, maxCompensation: 5,
    paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297,
  });
  const outerSheet = r.signatures[0].sheets[0];
  assert.equal(outerSheet.front.left.check.violations.some((v) => v.edge === 'inner'), false);

  const innerSheet = r.signatures[0].sheets[2]; // offset +4 / -4
  const leftInner = innerSheet.front.left.check.violations.find((v) => v.edge === 'inner');
  assert.ok(leftInner);
  assert.equal(leftInner.level, 'trim');
  assert.equal(leftInner.shortByMm, 4);
  const rightInner = innerSheet.front.right.check.violations.find((v) => v.edge === 'inner');
  assert.ok(rightInner);
  assert.equal(rightInner.shortByMm, 4);
});

test('右装订：offset 符号反转，内层页位向各自外切口越界', () => {
  const r = computeImposition({
    totalPages: 16, sheetsPerSignature: 4, binding: 'right', flip: 'short',
    paperThickness: 1, maxCompensation: 5,
    paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297,
  });
  const innerSheet = r.signatures[0].sheets[2]; // 右装订：左页位 -4、右页位 +4
  // 左页位向纸张左侧（外切口）平移 4mm：外切口越界
  const leftOuter = innerSheet.front.left.check.violations.find((v) => v.edge === 'outer');
  assert.equal(leftOuter.level, 'trim');
  assert.equal(leftOuter.shortByMm, 4);
  assert.equal(innerSheet.front.left.check.violations.some((v) => v.edge === 'inner'), false);
  // 右页位向右（外切口）平移 4mm：右侧同样是外切口越界，订口不越
  const rightOuter = innerSheet.front.right.check.violations.find((v) => v.edge === 'outer');
  assert.equal(rightOuter.shortByMm, 4);
  assert.equal(innerSheet.front.right.check.violations.some((v) => v.edge === 'inner'), false);
});

test('空白页页位：检查状态为 skipped 且不计入失败统计', () => {
  const r = computeImposition({
    totalPages: 6, sheetsPerSignature: 2, binding: 'left', flip: 'short', ...FIT,
  });
  assert.equal(r.blankPages, 2);
  const blankSlot = r.signatures[0].sheets[0].front.left; // 第 8 页为空白
  assert.equal(blankSlot.blank, true);
  assert.equal(blankSlot.check.status, 'skipped');
  assert.equal(blankSlot.check.reason, 'blank');
  assert.equal(blankSlot.check.fit, null);
  assert.equal(r.checks.totals.skippedBlankSlots, 2);
  assert.equal(r.checks.totals.checkedSlots, 6);
  assert.equal(r.checks.totals.failedSlots, 0);
  assert.equal(r.checks.fit, true);
});

test('全部页位为空白（完全空帖）：fit 仍为 true', () => {
  const r = computeImposition({
    totalPages: 4, sheetsPerSignature: 2, binding: 'left', flip: 'short', ...FIT,
  });
  // 4 页补到 8 页：第 2 张 4 个页位全空白
  const s2 = r.signatures[0].sheets[1];
  assert.ok(s2.front.left.check.status === 'skipped' && s2.back.right.check.status === 'skipped');
  assert.equal(r.checks.fit, true);
});

test('汇总 worstLevel 取所有违规中的最高级别', () => {
  // 一张大到不可能越界的纸，只有个别页位因爬移越折缝（trim 级）
  const r = computeImposition({
    totalPages: 16, sheetsPerSignature: 4, binding: 'left', flip: 'short',
    paperThickness: 1, maxCompensation: 5,
    paperWidth: 600, paperHeight: 400, pageWidth: 210, pageHeight: 297,
    bleed: 3, safetyMargin: 5,
  });
  assert.equal(r.checks.totals.worstLevel, 'trim');
  assert.ok(r.checks.totals.failedSlots > 0);
});

test('启用检查不改变页码拼版结果', () => {
  const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'check' || k === 'checks' || k === 'offsetMm' ? undefined : v)));
  const without = computeImposition({ ...BASE });
  const withChecks = computeImposition({ ...BASE, ...FIT });
  assert.deepEqual(strip(withChecks.signatures), strip(without.signatures));
});

test('input 回显：启用时包含纸张参数，未启用时保持原样', () => {
  const without = computeImposition({ ...BASE });
  assert.deepEqual(Object.keys(without.input).sort(),
    ['binding', 'flip', 'maxCompensation', 'paperThickness', 'sheetsPerSignature', 'totalPages']);
  const withChecks = computeImposition({ ...BASE, ...FIT });
  assert.equal(withChecks.input.paperWidth, 450);
  assert.equal(withChecks.input.bleed, 3);
  assert.equal(withChecks.input.safetyMargin, 5);
});

/* ------------------------------ 参数校验 ------------------------------ */

test('检查参数校验', () => {
  const mustThrow = (extra, re) => {
    assert.throws(() => computeImposition({ ...BASE, ...extra }), re);
  };
  mustThrow({ paperWidth: 420 }, /同时提供/);
  mustThrow({ paperWidth: 420, paperHeight: 297, pageWidth: 210 }, /同时提供/);
  mustThrow({ paperWidth: 0, paperHeight: 297, pageWidth: 210, pageHeight: 297 }, /纸张宽度/);
  mustThrow({ paperWidth: -1, paperHeight: 297, pageWidth: 210, pageHeight: 297 }, /纸张宽度/);
  mustThrow({ paperWidth: 'x', paperHeight: 297, pageWidth: 210, pageHeight: 297 }, /纸张宽度/);
  mustThrow({ paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297, bleed: -0.1 }, /出血/);
  mustThrow({ paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297, safetyMargin: -1 }, /安全边距/);
  mustThrow({ paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297, safetyMargin: 105.001 }, /不能超过/);
});

test('parseChecks 直接使用', () => {
  assert.deepEqual(parseChecks({}), { enabled: false });
  const cfg = parseChecks({ paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297 });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.bleedMm, 0);
  assert.equal(cfg.safetyMm, 0);
});

/* ------------------------------ HTTP 接口 ------------------------------ */

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/impose', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) })); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('HTTP：/api/impose 返回检查结果，非法参数返回 400', async (t) => {
  const app = require('../server');
  const server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  const port = server.address().port;
  t.after(() => server.close());

  const ok = await postJson(port, { ...BASE, ...FIT });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.checks.fit, true);
  assert.equal(ok.body.meta.version, '1.2.0');
  assert.ok(ok.body.signatures[0].sheets[0].front.left.check.usableRect);

  const bad = await postJson(port, { ...BASE, paperWidth: 420 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /同时提供/);

  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
  assert.equal(health.status, 200);
});
