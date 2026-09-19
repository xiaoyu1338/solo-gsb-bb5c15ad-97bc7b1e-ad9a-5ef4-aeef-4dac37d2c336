# 骑马钉小册子拼版预演

基于 **Node.js + Express + 原生 Canvas** 的骑马钉（saddle-stitch）拼版预演 Web 应用。

输入成品页数、每帖张数、装订方向与双面翻转方式后，系统会：

- 成品页数不足整帖时，**自动在末尾补空白页**；
- **按帖拆分页码**（每帖页数 = 每帖张数 × 4），生成每张纸正、反面的左右页位；
- 背面依据 **长边 / 短边翻转** 执行坐标变换，保证裁切折叠后的阅读顺序；
- 可选 **爬移补偿（creep compensation）**：按纸张厚度由外向内平移内层页位，画布叠加原始页位虚线框与补偿后实线框，每个页位（含空白页）输出 `offsetMm`；
- 画布**逐张显示**纸面、页码、空白页位与翻转方向示意；
- 一键**导出拼版清单 JSON**。

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
  "maxCompensation": 2
}
```

- `totalPages`：成品页数，1 ~ 10000 的整数
- `sheetsPerSignature`：每帖张数，1 ~ 100 的整数
- `binding`：`left`（左装订）或 `right`（右装订）
- `flip`：`long`（长边翻转）或 `short`（短边翻转）
- `paperThickness`：**可选**，纸张厚度（mm，≥ 0，缺省为 0）
- `maxCompensation`：**可选**，爬移最大补偿量（mm，≥ 0，缺省为 0）

后两个参数任一为 0（或不传）时不做爬移补偿，所有页位 `offsetMm` 为 0，旧调用方无需改动。

响应（节选）：完整拼版清单，与前端导出的 JSON 一致。`creep.sheetCompensationMm` 按帖由外向内给出每张纸的补偿量；每个页位对象（含空白页）都带 `offsetMm`。

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
  ]
}
```

参数非法时返回 `400` 与错误信息（含纸张厚度 / 最大补偿量为负或非数字的情况）。另提供 `GET /api/health` 健康检查。

## 目录结构

```
├── server.js            # Express 服务：静态页面 + /api/impose
├── src/imposition.js    # 拼版计算核心（按帖拆分、正反面页位、翻转坐标变换、爬移补偿 offsetMm）
├── public/              # 前端（原生 Canvas 逐张绘制、原始/补偿页位叠加、JSON 导出）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── test/imposition.test.js
├── Dockerfile
└── docker-compose.yml
```
