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
│   │   ├── components/cutting/  排样图、木料库存与开料记录面板
│   │   ├── hooks/               步序编排与 SVG 热区解析
│   │   ├── pages/               图鉴、详情、步序、绘制台、家具反查与开料台
│   │   ├── router/              前端路由
│   │   ├── stores/              Zustand 状态与数据落库
│   │   ├── types/               核心数据模型
│   │   ├── utils/               Dexie、尺寸换算、排样算法、跨页签事件与 JSON 导出
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
- `version(3)`：新增 `boards`（板材/余料库存）、`cutRecords`（开料记录）两张表；为构件回填开料版本号 `cutRev = 1`，并给老库补入初始板材库存。
- 首次创建数据库时通过 Dexie `populate` 回调写入榫卯、构件、步骤、内联 SVG、家具关联的种子数据，以及顺纹/横纹整板与回库余料库存。
- 新建记录、尺寸修改、SVG 保存和步骤拖拽调序都会实时写回 IndexedDB，刷新页面后仍可读取。

## 开料台规则

| 规则 | 实现 |
| --- | --- |
| 顺纹件只上顺纹板，长边沿纹向、禁止旋转；横纹件上横纹板，可旋转 90° | 排样候选仅取纹向一致且厚度足够的板，顺纹件只尝试原向 |
| 构件不越界、不重叠 | 自由矩形减去落位矩形的条带分片算法（`utils/packing.ts`），落位坐标全部夹在板面内 |
| 几件构件可共用同一块木料 | 评分优先"已开料的板"，尽量把件并入同一张板；余料优先级最高 |
| 容量不够或纹向不符 | 排样返回 `CAPACITY` / `GRAIN_MISMATCH`，整批拒绝，不产出部分排样 |
| 切剩余料回库 | 确认时源板删除，可再用自由矩形（最小边 ≥ 50mm）作为余料写回，碎料计入废弃面积 |
| 开料记录 | 每次确认生成批号（`KL日期-序号`），含构件落位、扣减板材、回存余料 |
| 尺寸/纹向修改后旧排样失效 | 构件带 `cutRev`，排样快照保存指纹（纹向+长宽厚+版本）；任一变化或本页签/其它页签改料，确认或界面提示作废并重排 |
| 两个页签同时开同一批木料 | 确认逻辑在单个 Dexie `rw` 事务中校验引用板材仍存在且料面一致；事务串行，先到成功扣料，后到整笔回滚并保留件数草稿重排；跨页签通过 BroadcastChannel（storage 事件兜底）通知 |

## 核心功能与路由表

| 路由 | 页面 | 核心功能 |
| --- | --- | --- |
| `/` | 入口重定向 | 自动进入榫卯图鉴 |
| `/joints` | 榫卯图鉴总览 | 按家族与难度分组，新建类型，显示构件数与步骤数，导出全部数据 |
| `/joints/:id` | 类型详情 | 查看尺寸表、公差校验、适用家具与步骤；导出当前类型 |
| `/joints/:id/steps` | 拆装步序编排 | 原生拖拽调序并落库，逐步预览内联 SVG 与风险提醒 |
| `/joints/:id/diagram` | 示意图绘制台 | 点击热区回填构件，编辑构件名称、尺寸与 SVG 源 |
| `/furniture` | 家具榫卯反查 | 按家具聚合使用部位与承力说明，新建家具关联 |
| `/cutting` | 开料台 | 待加工构件排样、整批拒绝、确认扣料、余料回库与开料记录 |

排样与开料事务提供两个不依赖浏览器的 Node 验证脚本（经 esbuild 即时打包 TS）：

```bash
cd frontend
npm run verify:packing   # 排样：纹向、越界、重叠、容量拒绝、余料回存
npm run verify:cutting   # 事务：并发提交只成功一次、后到者回滚、旧排样失效
```
