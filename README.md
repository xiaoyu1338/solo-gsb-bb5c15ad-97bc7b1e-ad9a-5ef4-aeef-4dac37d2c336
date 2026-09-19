# 骑马钉小册子拼版预演

基于 **Node.js + Express + 原生 Canvas** 的骑马钉（saddle-stitch）拼版预演 Web 应用。

输入成品页数、每帖张数、装订方向与双面翻转方式后，系统会：

- 成品页数不足整帖时，**自动在末尾补空白页**；
- **按帖拆分页码**（每帖页数 = 每帖张数 × 4），生成每张纸正、反面的左右页位；
- 背面依据 **长边 / 短边翻转** 执行坐标变换，保证裁切折叠后的阅读顺序；
- 可选 **爬移补偿（creep compensation）**：按纸张厚度由外向内平移内层页位，画布叠加原始页位虚线框与补偿后实线框，每个页位（含空白页）输出 `offsetMm`；
- 可选 **纸张规格 / 出血 / 安全区检查**：输入纸张与成品页尺寸、出血和安全边距后，服务端按每个正/背面页位的**实际方向**（长边翻转背面内容旋转 180°）计算可用矩形、成品框、出血框、安全框，返回每个页位是否适配及**具体超限原因**；前端在逐张预览（红色粗框）和拼版清单（不合格行高亮）中标出，并随清单一起导出 JSON；
- 画布**逐张显示**纸面、页码、空白页位与翻转方向示意；
- 一键**导出拼版清单 JSON**（启用检查时包含每个页位的 `check` 与顶层 `checks` 汇总）。

## 快速开始（Docker）

```bash
docker compose up --build
```

启动后访问：**http://localhost:8080**

## 本地开发

```bash
npm install
npm start          # 启动服务，默认 8080 端口（可用 PORT 环境变量覆盖）
npm test           # 运行拼版逻辑单元测试
```

## 拼版规则说明

- **帖与张**：一帖由若干张纸叠放对折而成，每张纸正反面各印 2 页，故每帖页数 = 每帖张数 × 4。
- **页码配对**：同一帖内由外向内，第 i 张纸的正面为「最大未排页 + 最小未排页」，背面为与其相邻的两页。
- **装订方向**：
  - 左装订：第 1 页在正面右页位（书脊在左）；
  - 右装订：镜像，第 1 页在正面左页位（书脊在右）。
- **双面翻转（背面坐标变换，纸张坐标系与正面同视角）**：
  - 长边翻转：绕水平长边翻转，`(x, y) → (x, H − y)`，背面左右页位不变，内容旋转 180°（页首朝下）；
  - 短边翻转：绕垂直短边翻转，`(x, y) → (W − x, y)`，背面左右页位互换，内容方向不变。
- **阅读顺序校验**：画布上每个背面页位都标注了它物理上位于哪一正面页之背（页码首尾相接）。

### 爬移补偿（creep compensation）

骑马钉装订时内层纸页在书背处被向外推出，折页裁切后内层页会比外层短，需要把内层页位向切口方向平移补偿。表单中的两个可选参数（均为 mm）：

- **纸张厚度** `paperThickness`：单张纸的厚度；
- **最大补偿量** `maxCompensation`：单张纸补偿量的封顶值。

规则：

- 每帖第 `i` 张纸由外向内以 `0` 起算，补偿量 = `min(i × 纸张厚度 × 2, 最大补偿量)`（一张纸在折缝两侧各贡献一个厚度，故乘 2；各帖独立从 `i = 0` 起算）；
- 偏移符号：**左装订时左页位取正、右页位取负**；**右装订时符号整体反转**（左负右正）；
- 偏移与双面翻转方式无关，正、背面同方向平移；
- 每个页位（包括自动补齐的**空白页**）都输出 `offsetMm`；
- **纸张厚度或最大补偿量任一为 0（或缺省）时，所有 `offsetMm` 为 0，页码拼版结果与不启用时完全一致**（向后兼容）。

画布上橙色**虚线框**表示补偿前的原始页位，橙色**实线框**表示补偿后页位；画布位移为示意性放大（非真实 mm 等比），精确数值以清单和导出 JSON 中的 `offsetMm` 为准。

### 纸张规格 / 出血 / 安全区检查

表单中再提供 6 个参数（均为 mm）：

- **纸张宽度 / 高度** `paperWidth` / `paperHeight`：印刷纸张尺寸（>0）；
- **成品页宽度 / 高度** `pageWidth` / `pageHeight`：对折裁切后的单页尺寸（>0）；
- **出血** `bleed`：可选，≥0，缺省 0；
- **安全边距** `safetyMargin`：可选，≥0，缺省 0，且不得超过成品页宽/高的一半。

纸张宽高与成品页宽高 **4 项全部留空时不启用检查**（行为与旧版一致）；4 项须同时提供（任一缺失返回 400）。

几何模型（一张纸对折后承载两个成品页）：

- 每个页位的可用矩形为纸张的一半（左页位 `[0, 纸宽/2]`、右页位 `[纸宽/2, 纸宽]`）；
- 成品框**订口侧贴折缝**放置、上下方向在纸内居中，并随该页位的爬移 `offsetMm` 沿水平方向平移；
- 出血框 = 成品框四周外扩 `bleed`；安全框 = 成品框四周内收 `safetyMargin`；
- **长边翻转的背面内容旋转 180°**：页首/页脚、外切口/订口方向互换，检查结果中的 `contentEdge` 给出内容实际方向；短边翻转尺寸方向不变。

对每条纸边，以「成品框到纸边/折缝的实际余量」判定三级问题：

| 级别 | 条件 | 含义 |
| --- | --- | --- |
| `trim` | 余量 < 0 | 成品页超出纸张（或爬移后成品框越过折缝与对侧重叠），致命 |
| `bleed` | 0 ≤ 余量 < 出血 | 出血区落到纸外，出血不足 |
| `safety` | 出血 ≤ 余量 < 安全边距 | 纸边余量小于安全边距（但出血尚够） |

订口（折缝）侧只检查 `trim`：出血允许越过折缝与对侧跨缝拼版（cross-stitch），安全边距是页内设计约束。自动补齐的**空白页位跳过检查**（`status: "skipped"`），不计入失败统计。

前端表现：不合格页位在画布上以**红色粗框**标注，框下列出每条超限原因（边、实际余量、要求值、缺口量），面板标题与纸张下拉显示不合格数量，拼版清单中不合格行红底高亮，顶部摘要 chip 显示 `N/M 个页位不合格` 与最严重级别。

## API

### `POST /api/impose`

请求体：

```json
{
  "totalPages": 16,
  "sheetsPerSignature": 2,
  "binding": "left",
  "flip": "short",
  "paperThickness": 0.1,
  "maxCompensation": 2,
  "paperWidth": 450,
  "paperHeight": 320,
  "pageWidth": 210,
  "pageHeight": 297,
  "bleed": 3,
  "safetyMargin": 5
}
```

- `totalPages`：成品页数，1 ~ 10000 的整数
- `sheetsPerSignature`：每帖张数，1 ~ 100 的整数
- `binding`：`left`（左装订）或 `right`（右装订）
- `flip`：`long`（长边翻转）或 `short`（短边翻转）
- `paperThickness`：**可选**，纸张厚度（mm，≥ 0，缺省为 0）
- `maxCompensation`：**可选**，爬移最大补偿量（mm，≥ 0，缺省为 0）
- `paperWidth` / `paperHeight` / `pageWidth` / `pageHeight`：**可选**，纸张与成品页尺寸（mm，>0）；4 项同时提供才启用检查，只传其中一部分返回 400；全部缺省时不检查（`checks` 为 `null`）
- `bleed`：**可选**，出血（mm，≥ 0，缺省 0）
- `safetyMargin`：**可选**，安全边距（mm，≥ 0，缺省 0；超过成品页宽/高的一半返回 400）

后两个爬移参数任一为 0（或不传）时不做爬移补偿，所有页位 `offsetMm` 为 0，旧调用方无需改动。

响应（节选）：完整拼版清单，与前端导出的 JSON 一致。`creep.sheetCompensationMm` 按帖由外向内给出每张纸的补偿量；每个页位对象（含空白页）都带 `offsetMm`。启用检查时，每个非空白页位带 `check`（`usableRect` / `trimRect` / `bleedRect` / `safetyRect` / `margins` / `violations`），空白页位 `check.status` 为 `skipped`；顶层 `checks` 给出输入回显与汇总统计。

```json
{
  "input": {
    "totalPages": 8,
    "sheetsPerSignature": 2,
    "binding": "left",
    "flip": "short",
    "paperThickness": 0.1,
    "maxCompensation": 0.15
  },
  "pagesPerSignature": 8,
  "signatureCount": 1,
  "paddedPages": 8,
  "blankPages": 0,
  "creep": {
    "paperThickness": 0.1,
    "maxCompensation": 0.15,
    "enabled": true,
    "sheetCompensationMm": [0, 0.15]
  },
  "signatures": [
    {
      "index": 1,
      "pageStart": 1,
      "pageEnd": 8,
      "sheets": [
        {
          "index": 1,
          "front": {
            "left": { "page": 8, "blank": false, "offsetMm": 0 },
            "right": { "page": 1, "blank": false, "offsetMm": 0 }
          },
          "back": {
            "left": { "page": 2, "blank": false, "offsetMm": 0, "backOf": 1 },
            "right": { "page": 7, "blank": false, "offsetMm": 0, "backOf": 8 }
          }
        },
        {
          "index": 2,
          "front": {
            "left": { "page": 6, "blank": false, "offsetMm": 0.15 },
            "right": { "page": 3, "blank": false, "offsetMm": -0.15 }
          }
        }
      ]
    }
  ],
  "checks": {
    "enabled": true,
    "paperMm": { "width": 450, "height": 320 },
    "pageMm": { "width": 210, "height": 297 },
    "bleedMm": 3,
    "safetyMm": 5,
    "totals": {
      "slots": 8,
      "checkedSlots": 8,
      "skippedBlankSlots": 0,
      "fitSlots": 8,
      "failedSlots": 0,
      "worstLevel": null
    },
    "fit": true
  }
}
```

页位级检查结果示例（不合格页位）：

```json
{
  "page": 8,
  "blank": false,
  "offsetMm": 0,
  "backOf": 1,
  "check": {
    "status": "fail",
    "fit": false,
    "rotated": false,
    "orientation": "upright",
    "usableRect": { "x": 0, "y": 0, "width": 210, "height": 297 },
    "trimRect": { "x": 0, "y": 0, "width": 210, "height": 297 },
    "bleedRect": { "x": -3, "y": -3, "width": 216, "height": 303 },
    "safetyRect": { "x": 5, "y": 5, "width": 200, "height": 287 },
    "margins": { "outer": 0, "inner": 0, "top": 0, "bottom": 0 },
    "violations": [
      {
        "level": "bleed",
        "edge": "outer",
        "contentEdge": "outer",
        "requiredMm": 3,
        "actualMm": 0,
        "shortByMm": 3,
        "message": "出血不足：外切口实际余量 0 mm < 出血要求 3 mm（缺 3 mm）"
      }
    ]
  }
}
```

- `orientation`：`upright` / `rotated180`（长边翻转的背面）；`edge` 为纸张坐标系方向（`outer` 外切口 / `inner` 订口 / `top` / `bottom`），`contentEdge` 为考虑 180° 旋转后的内容方向；
- `margins`：成品框到四条纸边（订口边为折缝）的实际余量（mm）。

参数非法时返回 `400` 与错误信息（含纸张厚度 / 最大补偿量为负或非数字、纸张尺寸只传一部分、安全边距超过成品页一半等情况）。另提供 `GET /api/health` 健康检查。

## 目录结构

```
├── server.js            # Express 服务：静态页面 + /api/impose
├── src/imposition.js    # 拼版计算核心（按帖拆分、正反面页位、翻转坐标变换、爬移补偿 offsetMm）
├── src/checks.js        # 纸张规格/出血/安全区检查（按页位实际方向计算可用矩形与三级超限判定）
├── public/              # 前端（原生 Canvas 逐张绘制、不合格页位红框标注、清单高亮、JSON 导出）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── test/imposition.test.js
├── test/checks.test.js
├── Dockerfile
└── docker-compose.yml
```
