# 榫卯结构拆解图鉴

面向传统木作学习者与家具设计人员的纯前端单页应用。项目把榫卯类型、构件尺寸、配合公差、拆装步骤、内联 SVG 示意图与适用家具整理为一套可查询、可编排、可追溯的本地图鉴，所有数据均保存在当前浏览器中。

## Docker 一键启动

```bash
cp .env.example .env && docker compose up -d --build
```

服务启动后访问：`http://localhost:21804`

停止服务：

```bash
docker compose down
```

## 技术栈

| 类别 | 技术 |
| --- | --- |
| UI | React 18、TypeScript 5 |
| 构建 | Vite 5 |
| 样式 | Tailwind CSS 3 |
| 路由 | React Router 6 |
| 状态 | Zustand 4 |
| 本地数据 | Dexie 4、IndexedDB |
| 容器 | Docker 多阶段构建、Nginx |

## 访问地址

- 宿主机端口：`21804`
- 页面地址：`http://localhost:21804`
- 前端路由回退由 Nginx 的 `try_files` 规则处理。

## 本地开发方式

```bash
cd frontend
npm install
npm run dev
```

类型检查与生产构建：

```bash
cd frontend
npm run build
```

本地开发默认使用 Vite 的 `5173` 端口；应用数据由浏览器中的 Dexie 数据库维护，不需要后端服务。

## 目录结构

```text
.
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── components/common/   共享 SVG、步骤轨道、尺寸字段和标签
│   │   ├── hooks/               步序编排与 SVG 热区解析
│   │   ├── pages/               图鉴、详情、步序、绘制台与家具反查
│   │   ├── router/              前端路由
│   │   ├── stores/              Zustand 状态与数据落库
│   │   ├── types/               核心数据模型
│   │   ├── utils/               Dexie、尺寸换算与 JSON 导出
│   │   ├── App.tsx
│   │   ├── index.css
│   │   └── main.tsx
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── docker-compose.yml
├── .env.example
└── README.md
```

## 数据存储说明

应用使用 IndexedDB，数据库封装库为 Dexie 4，库名为 `gbmortise-db`。

- `version(1)`：建立 `joints`、`members`、`steps`、`diagrams`、`furniture` 五张表及查询索引。
- `version(2)`：执行升级迁移，为五张表回填 `schemaRev = 2` 字段。
- `version(3)`：开料台上线，新增 `boards`（板材/余料台账）、`cutComponents`（待加工构件）、`cutBatches`（开料批次草稿）、`cutRecords`（开料流水）四张表，并为老库回填板材与构件种子数据。
- 首次创建数据库时通过 Dexie `populate` 回调写入榫卯、构件、步骤、内联 SVG 与家具关联的种子数据。
- 新建记录、尺寸修改、SVG 保存和步骤拖拽调序都会实时写回 IndexedDB，刷新页面后仍可读取。

## 核心功能与路由表

| 路由 | 页面 | 核心功能 |
| --- | --- | --- |
| `/` | 入口重定向 | 自动进入榫卯图鉴 |
| `/joints` | 榫卯图鉴总览 | 按家族与难度分组，新建类型，显示构件数与步骤数，导出全部数据 |
| `/joints/:id` | 类型详情 | 查看尺寸表、公差校验、适用家具与步骤；导出当前类型 |
| `/joints/:id/steps` | 拆装步序编排 | 原生拖拽调序并落库，逐步预览内联 SVG 与风险提醒 |
| `/joints/:id/diagram` | 示意图绘制台 | 点击热区回填构件，编辑构件名称、尺寸与 SVG 源 |
| `/furniture` | 家具榫卯反查 | 按家具聚合使用部位与承力说明，新建家具关联 |
| `/cutting` | 开料台 | 板材台账、待加工构件排样、余料回库、开料流水与跨页签单次提交 |

## 开料台业务规则

- **排样**：自由矩形 guillotine 排样（MAXRECTS 思路），大件优先、先填满已开板再开新板；锯路宽度参与占位，构件不越界、不重叠。
- **纹向**：顺纹件（`grainMode=along`）只允许长边平行板纹落位，不能转向；任意纹件可 90° 转向。库存只有横纹板时顺纹件整批拒绝。
- **整批拒绝**：厚度不足、纹向不符、单件超尺寸或整批容量不够时返回拒绝原因，不动任何库存。
- **余料账**：剩余区域双向边长均达到“最小回库边长”才整块登记回库（`source=offcut`，记录母板与批次），不足尺寸的零头记碎料、不回库。
- **失效控制**：板材与构件均带 `rev`；排样快照记录 rev 与数量，尺寸、纹向、数量或锯路/最小余料参数修改后，旧排样立即置为失效，必须重新排样。
- **确认原子性**：确认在单个 Dexie 读写事务内完成扣板、回料、写流水、批次转确认，并以 `status + rev` 做条件校验。
- **跨页签**：确认前按所用板材 id 排序申请 Web Locks 排他锁；两页签同批提交只成功一次，后到者事务校验失败且不写账，草稿保留（克隆为新草稿行）并标记失效等待重排。`BroadcastChannel`（辅以窗口聚焦兜底）实时推送库存变化。
