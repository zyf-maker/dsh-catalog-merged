# DSH Market

自有的 DeepSeek Harness 插件市场：**自己抓取、自己合并、自己排名、自己修兼容**，不是任何现成市场的套壳。

它是**两个仓库**，职责不重叠：

| 仓库 | 是什么 | 里面装什么 | 什么时候变 |
|---|---|---|---|
| **本仓库** `dsh-catalog-merged` | 数据集 + 采集管线 + 公开站点 | `ingest/`（抓取 → 归一 → 合并 → 准入 → 排名 → 产出）、`data/`（构建产物）、`web/`（公开页面）、`shared/quality.mjs`、`db/`、`api/`（可选 Worker） | `data/` 每 6 小时由 CI 重建 |
| [`dsh-market-own`](https://github.com/zyf-maker/dsh-market-own) | 插件本体（设置页里的「我的市场」） | 宿主半边（目录路由 + 安装 + 兼容修复 + 审计台账）、客户端半边（界面）、`cordis.patch.yml` | 只在改插件时 |

**依赖是单向的**：插件读本仓库发布出来的 `data/catalog.json`（可用 `DSH_MARKET_CATALOG` 覆盖）。本仓库不认识插件。

**为什么不合成一个仓**：

- 插件要能用 `dsh plugin add github:zyf-maker/dsh-market-own` 装上，而 pnpm 会 clone 整个仓库。本仓库光 `data/` 就有 62MB，且每 6 小时重建一次。合在一起，每次装插件都要拖 62MB，插件的"版本"还会跟着数据的提交不停漂。
- 本仓库的产物不止一个消费者——下面的 Pages 站点、兼容注册表 `plugins.json`、可选的 Worker API 都吃它。它们不该跟着插件的发版节奏走。

**这个仓库里没有插件代码，也不该有。** 曾经有一份 `plugin/`，是插件的旧副本（228 行 vs 现在的 804 行、用 `ctx.http` 而非 `webServer`、`package.json` 声明的 `ingest/compat.mjs` 根本不在目录里），全仓没有任何代码引用它，已删除。

## 从哪开始

- 数据与 UI：https://zyf-maker.github.io/dsh-catalog-merged/web/
- 兼容注册表（任何市场都能直接吃）：`https://raw.githubusercontent.com/zyf-maker/dsh-catalog-merged/main/data/plugins.json`
- **插件本体在另一个仓库**：[`dsh-market-own`](https://github.com/zyf-maker/dsh-market-own)（`dsh plugin --profile web add github:zyf-maker/dsh-market-own`）
- API（可选部署）：`api/worker.js`（Cloudflare Worker + D1）

## 1. 架构

```
┌──────────────────── GitHub Actions（定时，无本地常驻进程） ────────────────────┐
│  ingest/index.mjs                                                              │
│                                                                                │
│   ① sources.mjs                                                               │
│      种子目录（6 个）+ 自动发现（GitHub 上"长得像目录"的仓库 → 探测可读目录）      │
│   ② harvest.mjs                                                               │
│      catalog 源   → 拉 JSON / API                                              │
│      GitHub topic → topic:dsh-plugin、topic:deepseek-harness（找没人收录的新插件）│
│      npm keyword  → keywords:dsh-plugin（npm 分发的插件）                       │
│   ③ normalize.mjs                                                             │
│      统一记录形状 + 身份键（npm 名 > owner/repo > 名称）+ 安装目标分类           │
│      npm | github | tarball | other                                            │
│   ④ dedupe（mergeInto）                                                       │
│      同身份保留"最新最热"，并集来源（多源收录 = 一条记录 + 多条溯源）             │
│   ⑤ 排名  score = stars*1000 + downloads，次序 score→stars→downloads→name       │
│   ⑥ compat.mjs                                                                │
│      harness 格式校验 → 生成修复方案（overlay 包），而不是让安装失败              │
│   ⑦ shared/quality.mjs                                                        │
│      空壳判定 + 质量分档，把结论写进每一行（两个消费者读同一份，不许各判各的）      │
└───────────┬──────────────────────────────────────┬────────────────────────────┘
            │ data/{catalog,plugins,sources,rankings,health,new}.json
            │ db/schema.sql → SQLite / D1
   ┌────────┴─────────┐                 ┌──────────┴───────────┐
   │ 静态面 Pages      │                 │ API 面 Worker + D1    │
   │ /web/  自有 UI    │                 │ /api/v1/plugins …     │
   │ /plugins.json     │                 │ /api/v1/rankings …    │
   └────────┬─────────┘                 └──────────┬───────────┘
            └───────────────┬──────────────────────┘
                            │
                   两个消费者，都不依赖对方
                   ├── 公开页面  web/（本仓库）
                   └── DSH 设置页「我的市场」
                       由 dsh-market-own 插件读取同一份 catalog.json
```

设计要点：

- **没有常驻服务**。数据是构建产物（JSON + SQLite），消费者是静态主机、D1、或者 harness 自己。本地零依赖，CI 每 6 小时重建（`17 */6 * * *`）。
- **源是可发现的**。"主流源"会变，`discoverSources()` 用两个独立信号（仓库名像目录 + 真的能吐出 `plugins`/`items` 数组）决定是否采纳新源，采纳后自动进入后续每轮合并。
- **失败隔离**。任一源超时/改格式只记进 `sources.json` 的失败计数，不中断整轮；`health.json` 让消费者能区分"空"和"坏"。
- **可回退**。每次安装前 `compat` 给出 overlay，安装记录进 `install_events`，profile 快照由 harness 负责。

## 2. 文件结构

```
ingest/
  index.mjs          编排：发现 → 抓取 → 归一 → 合并 → 排名 → 产出
  sources.mjs        种子源表 + 自动发现（含 deny 名单：平台本体永不算插件）
  harvest.mjs        三种抓取器（catalog / GitHub topic / npm keyword），失败不致命
  normalize.mjs      记录形状、身份键、安装目标分类、排名规则
  compat.mjs         harness 格式校验 + 自动修复方案（overlay 包）
  load-sqlite.mjs    把 catalog.json 灌进 SQLite / D1（db/schema.sql）
db/schema.sql        数据模型（sources / plugins / plugin_sources / versions /
                     compat_fixes / install_events / rankings / FTS / 视图）
api/worker.js        REST API（health、sources、plugins、详情、rankings、new、触发重建）
api/wrangler.toml    Worker + D1 绑定
web/index.html       UI 外壳（搜索 / 分类 / 排序 / 目标筛选）
web/app.js           数据层（读 catalog.json，套用 shared/quality）+ 列表 + 详情 + 安装桥
shared/quality.mjs   空壳判定 + 质量分档 + 推荐排序（ingest 与浏览器共用同一份）
data/                构建产物（catalog / plugins / sources / rankings / health / new）
.github/workflows/   ingest.yml（每 6 小时）、pages.yml（发布 UI 与数据）
```

这里没有 `plugin/`：插件本体在 [`dsh-market-own`](https://github.com/zyf-maker/dsh-market-own)。

## 3. 数据库模式

见 `db/schema.sql`。核心表：

| 表 | 作用 |
|---|---|
| `plugins` | 规范记录：身份、安装目标与类型、stars/downloads/score、内容哈希 |
| `plugin_sources` | 多源溯源（一条插件多行来源） |
| `sources` / `source_runs` | 源表与每次抓取的结果（含自动发现的源） |
| `versions` | 版本历史，用于"已装版本是否落后" |
| `compat_fixes` | 每次自动修复的问题、方案、overlay 与是否验证通过 |
| `install_events` | 每次安装（用了哪个修复、成功/失败/回退） |
| `rankings` | 物化榜单（score / stars / downloads / new） |
| `plugins_fts` | FTS5 全文检索 |

## 4. API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 数据量与新鲜度、最近抓取 |
| GET | `/api/v1/sources` | 源表 + 健康度（含自动发现） |
| GET | `/api/v1/plugins` | `q` `category` `kind` `sort` `page` `limit` |
| GET | `/api/v1/plugins/:id` | 详情 + 溯源 + 修复记录 |
| GET | `/api/v1/rankings` | `kind=score\|stars\|downloads` |
| GET | `/api/v1/new` | 最近收录 |
| POST | `/api/v1/ingest/run` | 触发重建（Bearer `INGEST_TOKEN`） |

## 5. UI 架构

`web/` 是零构建的原生 ES 模块应用：控件在顶部、分类 chips 紧随其下、结果是**卡片网格**（从左往右读）。

版式与设置页里的「我的市场」是同一套：目录有一万多条，浏览是扫描，扫描要的是宽度——早先那版把分类放在左侧栏、卡片排成单列，结果是竖着拉一条长表，19 个分类还要靠侧栏自己滚动才看得全。

数据只有一条路：整份 `data/catalog.json` 读进来，筛选在浏览器里做。早先那版「优先打 `/api/v1`、失败回退静态」，等于对同一个问题有两个答案——页面列出 11538 条、设置页列出 10333 条。Worker API 仍然可用，只是不再是这个页面的数据源。

**空壳判定、质量分档、推荐排序不在这个页面里重写**：`shared/quality.mjs` 就是 `ingest/index.mjs` 导入的同一份文件，随页面一起发布。（`pages.yml` 把 `shared/` 拷进站点。）所以一行的判定只有一个答案，哪怕读者手上是旧的缓存产物。

安装调用 `window.dshMarket.install(target)`；独立打开没有桥时改为复制命令，不做假的成功。

## 6. 兼容与自动修复（第 4 条要求）

`ingest/compat.mjs` 把"不兼容"当作可修复的输入而不是错误：

| 问题 | 修复 |
|---|---|
| `dsh.bundle` 没有 `patch` | 指向仓库里已存在的 `cordis.patch.yml` |
| `dsh.client` 缺 `platform` | 补 `web` |
| peer 版本与宿主不一致 | 按宿主版本钉住 |
| 名称与包名不符 | 生成别名依赖 |

修复物是一个 **overlay 包**（本地小包，`dependencies` 指向真插件 + 补齐 `dsh` 元数据）：上游仓库零改动、pnpm 有真实目标、删一行即可回退。修复记录写入 `compat_fixes`，安装结果写入 `install_events`。

## 7. 运行

```bash
node ingest/index.mjs            # 全量：发现 + 抓取 + 合并 + 排名
node ingest/index.mjs --no-discover
node ingest/load-sqlite.mjs --db data/market.sql --apply
node --check web/app.js
```

CI 里 `ingest.yml` 每 6 小时跑一次并提交 `data/`，`pages.yml` 发布 UI 与数据。

预览站点：本仓库没有本地服务器（早先 `package.json` 里那个 `serve` 脚本指向不存在的 `scripts/serve.mjs`，已移除）。任意静态服务器指向仓库根目录即可，例如 `python -m http.server 8080`，然后打开 `/web/`。
