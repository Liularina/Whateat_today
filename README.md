# 今天吃什么 · 微信小程序

帮一个家庭完成「录入库存 → 推荐菜单 → 家人点菜 → 确认菜单 → 生成做法」的完整闭环。

> 当前进度：**Phase E：采购闭环（采购清单 + 过敏原/忌口硬过滤 + 体验优化）**。
> 微信登录（Phase 2）、家庭体系（Phase 3）、食材库存增删改查（Phase 4）、
> 营养估算（Phase 5）、基础菜谱库（Phase 6）、AI 智能推荐（Phase 7）、
> 菜单换菜与锁定（Phase 8）、家庭点单（Phase 9）、AI 菜谱与烹饪步骤（Phase 10）、
> 历史菜单与历史点单（Phase 11）已可用；
> 后续阶段待规划。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | 微信原生小程序 + TypeScript + TDesign Weapp |
| 后端 | 微信云开发（云函数 / 云数据库 / 云存储） |
| AI | 服务端调用 LLM API，严格 JSON Schema + 服务端二次校验 + 服务端营养重算 |

第一阶段**不使用** NestJS / PostgreSQL / Redis / Kubernetes / 微服务等复杂技术。

## 目录结构

```
miniprogram/
├── app.ts / app.json / app.wxss
├── assets/tabbar/           # TabBar 图标（81x81 PNG）
├── pages/                   # 18 个页面（含 4 个家庭页 + 营养估算页 + 2 个菜谱页 + AI 设置页）
├── components/              # 8 个公共组件
├── services/                # 统一封装云函数调用
├── types/                   # 实体 TypeScript 类型
├── utils/                   # cloud / storage / formatter / validator / family-form
├── constants/               # config / categories / units / recipe
└── typings/                 # IAppOption 等全局声明
cloudfunctions/
├── auth/ family/ ingredient/
├── nutrition/               # index.js + nutrition-core.js（纯函数）+ nutrition-data.js（基础数据）
├── recipe/                  # index.js + openai-compatible-client.js（菜谱库 + AI 生成做法）
├── ai-config/               # index.js + openai-compatible-client.js + ai-service.js（AI 统一入口 + 模式路由 + 额度）
├── menu/                    # index.js + openai-compatible-client.js + ai-service.js（菜单保存/锁定/换菜/确认）
├── order/                   # index.js（创建点单/提交选择/汇总/关闭/存量收尾）
├── recommend/               # index.js + openai-compatible-client.js + ai-service.js（推荐 3 套菜单）
├── shopping/                # index.js + shopping-core.js（购物清单聚合）
├── chat/                    # index.js + openai-compatible-client.js + ai-service.js（AI 做饭机器人对话）
├── cleanup/                 # index.js（定时维护：48 小时超时收尾 + 6 个月历史清理）
└── recommend/ menu/
tools/                       # 本地验证套件（内存版云开发，不依赖真实云环境）
```

## 快速开始

1. **安装依赖**

   ```bash
   npm install
   ```

2. **用微信开发者工具导入项目**，项目根目录选择本仓库根目录（`project.config.json` 所在目录）。

3. **填写 AppID**：`project.config.json` 中的 `appid` 已配置为真实 AppID，
   换项目时请替换为自己的小程序 AppID（云开发必须使用真实 AppID，游客模式无法使用云能力）。

4. **开通云开发**：开发者工具 → 云开发 → 新建环境，记下环境 ID。

5. **填写环境 ID**：编辑 `miniprogram/constants/config.ts`，把 `dev.cloudEnvId` 替换为真实环境 ID。
   项目只维护 `CURRENT_ENV = 'dev'`，发布前改为 `'prod'` 并填写 `prod.cloudEnvId`。

6. **构建 npm**（TDesign 必需）：开发者工具 → 工具 → 构建 npm。
   本项目使用 `packNpmManually`，对应 `project.config.json` 中的 `packNpmRelationList`。
   若未构建，使用了 TDesign 组件的页面（`recommend` / `order` / `mine`）会报组件找不到。

7. **部署云函数**：在 `cloudfunctions` 下对每个函数右键 → 上传并部署（云端安装依赖）。
   每个函数都提供 `ping` 用于部署后自检。

## 数据库集合

云开发控制台需要手动创建以下集合（权限建议：**仅创建者可读写**，所有读写经由云函数）。
共 **22 个**，缺任意一个对应的接口都会返回 `DB_NOT_READY` 或功能降级：

| # | 集合 | 用途 | 缺失时 |
| --- | --- | --- | --- |
| 1 | `users` | 用户与 openid 绑定 | 登录失败 |
| 2 | `families` | 家庭 | 建家失败 |
| 3 | `family_members` | 家庭成员关系 | 全部业务不可用 |
| 4 | `ingredients` | 食材库存 | `DB_NOT_READY` |
| 5 | `ingredient_aliases` | 食材别名 | 退回内置别名表（降级可用） |
| 6 | `nutrition_facts` | 营养基础数据 | 退回内置数据（降级可用） |
| 7 | `recipes` | 菜谱库 | `DB_NOT_READY` |
| 8 | `generated_recipes` | AI 生成做法缓存 | `DB_NOT_READY` |
| 9 | `family_cookbook` | 家庭菜谱本 | `DB_NOT_READY` |
| 10 | `cookbook_versions` | 菜谱本版本历史 | `DB_NOT_READY` |
| 11 | `menus` | 菜单（草稿 / 已确认 / 已完成） | 菜单功能不可用 |
| 12 | `menu_plans` | 餐次共享方案 | 看板不展示方案，主流程不受影响 |
| 13 | `meal_preferences` | 每餐口味偏好 | 按无偏好处理 |
| 14 | `meal_reviews` | 饭后评价 | 提交评分 `DB_NOT_READY` |
| 15 | `chef_points` | 掌勺人积分流水 | 可用但不记积分、不显示等级 |
| 16 | `family_orders` | 点单 | 点单功能不可用 |
| 17 | `family_order_items` | 点单明细 | 明细读不到 |
| 18 | `shopping_lists` | 购物清单 | `DB_NOT_READY` |
| 19 | `user_ai_configs` | 自定义 AI 配置 | `DB_NOT_READY` |
| 20 | `user_ai_prefs` | AI 模式偏好 | `DB_NOT_READY` |
| 21 | `ai_usage` | 每日 AI 额度计数 | 额度不生效 |
| 22 | `ai_logs` | AI 调用日志 | 只告警，不影响主流程 |

> Phase 2 / Phase 3 实际使用：`users`、`families`、`family_members`。
> Phase 4 额外使用：`ingredients`（**必需**，缺集合时接口返回 `DB_NOT_READY`）、
> `ingredient_aliases`（**可选**，缺集合时自动退回内置别名表）。
> Phase 5 额外使用：`nutrition_facts`（**可选**，缺集合时自动退回内置基础数据；
> 但 `seedNutritionFacts` 写入需要该集合存在）。
> Phase 6 额外使用：`recipes`（**必需**，缺集合时 `recipe` 云函数返回 `DB_NOT_READY`，
> 初始化也写不进去）。
> Phase 10 额外使用：`generated_recipes`（AI 生成的做法缓存；缺集合时返回提示，不阻碍查看原始菜谱。）
> Phase 1 餐次协作：`menu_plans`、`meal_preferences`（**可选**，缺集合时点菜页不展示共享方案，
> 原有「推荐 → 确认 → 点单」流程不受影响）。
> 阶段二饭后评价：`meal_reviews`（**必需**，缺集合时提交评分返回 `DB_NOT_READY`）、
> `chef_points`（**必需**，缺集合时完成与评分仍可用，只是不记积分、不显示等级）。

### 索引创建清单（Phase 11 已按真实查询核对）

> 仓库内**没有**数据库索引配置文件（只有 `project.config.json` / `package.json` / `tsconfig.json`），
> 微信云开发也不支持用该格式自动建索引，因此这里只给出手工执行清单，**不新增配置文件**。
> 下面的字段顺序与升降序都是照着代码里的 `where/orderBy` 反推的，不是拍脑袋定的。

**`menus`（历史菜单 + 当前菜单）**

| # | 索引字段（顺序） | 方向 | 对应查询代码 |
| --- | --- | --- | --- |
| 1 | `familyId`, `status`, `createdAt` | ↑, ↑, ↓ | `menu/index.js:716` `getTodayMenu`；`menu/index.js:768/772` `getMenuHistory` |

- 两处查询都是 `where({familyId, status}).orderBy('createdAt','desc')`，
  `familyId` / `status` 恒为等值条件、`createdAt` 恒为排序字段，一个复合索引全包。
- 有了该索引，单独的 `familyId` 索引就是**前缀重复**，不用再建。
- `getMenuHistory` 的日期范围（`createdAt` 的 `gte/lte`）落在索引最后一列，仍可走索引。

**`family_orders`（历史点单 + 列表）**

| # | 索引字段（顺序） | 方向 | 对应查询代码 |
| --- | --- | --- | --- |
| 2 | `familyId`, `createdAt` | ↑, ↓ | `order/index.js:548` `listOrders`（不筛状态） |
| 3 | `familyId`, `status`, `createdAt` | ↑, ↑, ↓ | `order/index.js:548` `listOrders`（按进行中/已关闭筛选） |
| 4（可选） | `familyId`, `menuId`, `status` | ↑, ↑, ↑ | `order/index.js:206` `createOrder` 重复点单检查 |

- 必须拆成 #2 和 #3：`status` 是**可选**条件，一旦索引里 `status` 夹在
  `familyId` 与 `createdAt` 之间，不筛状态时排序就用不上该索引。
- 方向必须和 `orderBy('createdAt','desc')` 一致（`createdAt` 用 ↓），否则退化为内存排序。
- #4 只在「发起点单」这一条低频写路径上用到；数据量不大时**可以不建**，
  建了也只是让这次重复检查不走全表扫描。

**`family_order_items`（点单明细）**

| # | 索引字段（顺序） | 方向 | 对应查询代码 |
| --- | --- | --- | --- |
| 5 | `orderId`, `userId` | ↑, ↑ | `order/index.js:283/370` `where({orderId,userId})`；`order/index.js:425/621` `where({orderId})` |

- 复合索引前缀是 `orderId`，因此**只需要这一个**，
  原来表里那条单独的 `orderId` 索引可以不要再建。

**其它集合（沿用之前的建议，未改动）**

| 集合 | 索引字段 |
| --- | --- |
| `family_members` | `familyId`、`userId` |
| `ingredients` | `familyId` |
| `nutrition_facts` | `standardName` |

**`menu_plans`（本餐次共享方案）**

| # | 索引字段（顺序） | 方向 | 对应查询 |
| --- | --- | --- | --- |
| 6 | `familyId`, `date`, `mealType`, `status`, `updatedAt` | ↑, ↑, ↑, ↑, ↓ | `menu/index.js` `readMealPlan`（点菜页按餐次） |
| 7 | `familyId`, `date`, `status`, `updatedAt` | ↑, ↑, ↑, ↓ | 首页不限定餐次，取当天最近更新的一份 |

**`meal_preferences`（成员偏好）**

| # | 索引字段（顺序） | 方向 | 对应查询 |
| --- | --- | --- | --- |
| 8 | `familyId`, `date`, `mealType` | ↑, ↑, ↑ | `menu/index.js` `loadPreferences` |
| 9（可选） | `familyId`, `date`, `mealType`, `userId` | ↑, ↑, ↑, ↑ | 同一成员一条记录的定位（并发去重） |

**`meal_reviews`（阶段二：每位成员每餐一条评价）**

| # | 索引字段（顺序） | 方向 | 对应查询 |
| --- | --- | --- | --- |
| 10 | `familyId`, `menuId` | ↑, ↑ | `menu/index.js` `loadReviews`（按用餐记录取所有成员评分） |

记录 `_id` 固定为 `rv_<menuId>_<userId>`，主键本身就是索引，按成员读写不需要额外索引。

**`chef_points`（阶段二：掌勺人积分流水）**

| # | 索引字段（顺序） | 方向 | 对应查询 |
| --- | --- | --- | --- |
| 11 | `familyId`, `cookId`, `createdAt` | ↑, ↑, ↓ | `menu/index.js` `loadPointsLedger`（求和 + 取最近一笔） |

记录 `_id` 固定为 `pt_<menuId>_<type>`，这一条固定键同时是幂等键，不需要额外索引。

**`recipes`（公共内置菜谱 + 家庭 AI 菜谱）**

| # | 索引字段（顺序） | 方向 | 对应查询 |
| --- | --- | --- | --- |
| 13 | `source`, `isActive` | ↑, ↑ | `menu/index.js` `loadRecipes`（内置菜谱）；`recommend/index.js:791` 候选加载；`recipe/index.js:264` `listRecipes` |
| 14 | `source`, `familyId`, `isActive` | ↑, ↑, ↑ | `menu/index.js` `loadRecipes`（本家庭 AI 菜谱） |
| 15 | `name`, `isActive` | ↑, ↑ | `recommend/index.js:620`、`menu/index.js:389` 落库前查同名菜 |

- #13 是 #14 的前缀，但**两条都需要**：`loadRecipes` 刻意用两次独立查询而非 `$or`，
  每次查询都能命中各自索引的最左前缀，也不依赖 `$or` 的线上支持。
- #15 用于库外菜落库前的同名复用检查。数据量小，**可以不建**，建了可避免全表扫描。
- `recipe/index.js` 的列表查询在 `source=builtin` 上还会叠加 `category` / `name` 正则，
  当前内置菜谱仅 200 道，`limit(1000)` 一次读回内存过滤，#13 已足够。

**`cleanup` 定时维护（跨家庭扫描）**

| # | 索引字段（顺序） | 方向 | 对应查询代码 |
| --- | --- | --- | --- |
| 16（建议） | `menus`: `status`, `createdAt` | ↑, ↑ | `cleanup/index.js` `findStale`（超时未收尾菜单） |
| 17（建议） | `menus`: `status`, `updatedAt` | ↑, ↑ | 同上（更新过但超时的菜单） |
| 18（建议） | `menu_plans`: `status`, `createdAt` | ↑, ↑ | `cleanup/index.js` `findStale`（超时未锁定方案） |
| 19（建议） | `menu_plans`: `status`, `updatedAt` | ↑, ↑ | 同上 |

- 这四条查询**不带 `familyId`**，是跨家庭的全量扫描，因此上面的 #1 / #6 / #7
  最左前缀都是 `familyId`，**完全用不上**。
- 目前数据量小（每家庭每天最多 3 餐），每天只跑一次、单次上限 500 条，
  不建索引也能接受，代价是全表扫描。
- 当 `menus` 或 `menu_plans` 超过约 10 万条时建议补 #16~#19，
  否则 cleanup 的执行时间会随总量线性增长，可能撞上云函数超时。
- 之所以要分别建 `createdAt` 与 `updatedAt` 两条：老数据没有 `updatedAt`，
  兜底查询按 `createdAt` 判断，两类查询各自需要匹配的最左前缀。

### 本轮新增字段（无需新建集合）

AI 推荐升级后，`recipes` 中新增两类文档，**复用现有集合，不需要建新集合**：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `source` | `builtin` / `ai_generated` | 原有字段，新增 `ai_generated` 取值 |
| `familyId` | 家庭 ID | AI 生成的菜谱归属家庭，读取时按此隔离 |
| `createdBy` | 用户 `_id` | AI 菜谱的生成者 |
| `steps` | `[]` | AI 菜谱先不写做法，进入详情页时按需生成 |

- 内置菜谱没有 `familyId` 字段，这是正常的：它们对所有家庭可见，
  查询时按 `source='builtin'` 单独取，不参与家庭隔离。
- 若历史数据里已有同名 `source` 字段的其它取值，不影响现有查询。

**字段可用性核对**：`menus` 的所有写入路径（`menu/index.js:308` `createMenu`、
`confirmMenu`、`setMenuItemLocked`、`replaceMenuItem`、`regenerateMenu`）都会落
`familyId` / `status` / `createdAt`；`family_orders` 的写入路径（`order/index.js:236`）
同样落 `familyId` / `status` / `createdAt` / `menuId`。**不需要为了建索引改动任何业务数据。**

在云开发控制台的执行位置：数据库 → 选择集合 → 索引管理 → 新建索引 →
按上表填字段与升降序 → 保存（等索引构建完成，历史数据量大时需要一点时间）。

### users 唯一索引（登录幂等必需）

请在云开发控制台为 `users` 集合建立 **`openid` 唯一索引**
（数据库 → 索引管理 → 新建索引，字段 `openid`、升序、勾选「唯一」）。

代码层已做「查不到才创建 + 创建失败回查 + 固定按 createdAt 升序取第一条」的兜底，
唯一索引是「同一微信用户只存在一条 users 记录」的最终保障。

## 密钥与环境变量

- **LLM API Key 只能放在云函数的环境变量里**（云开发控制台 → 云函数 → 配置 → 环境变量），
  例如 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`。
- 严禁写入 `miniprogram/` 下任何文件、`app.ts`、页面、utils、配置或 Git 提交内容。
- `.gitignore` 已排除 `.env` 等本地文件。

### AI 调用超时与「思考模式」

- 微信云函数执行时长上限为 **60 秒**。必须在云开发控制台把 `ai-config` / `recommend` /
  `menu` / `recipe` / `chat` 五个函数的**超时时间调到 60 秒**，否则推荐、生成做法、
  对话会被平台提前终止，前端只能看到一个笼统的网络错误，排查不到真正原因。
- 五个函数各自带一份 `openai-compatible-client.js` 与 `ai-service.js`，**内容必须完全一致**
  （改一个就要同步另外四个，否则线上行为不一致）。
  当前 5 份的 SHA256 一致，可用 `md5sum cloudfunctions/*/ai-service.js` 核对。
- 客户端默认在请求体里带 `chat_template_kwargs: { enable_thinking: false }` 关闭思考模式：
  思考型模型（Qwen3 系列等）会先输出大段推理再给正文，这些内容同样耗费生成时间，
  在 60 秒上限内极易超时；本项目提示词已把输出约束为纯 JSON，不需要模型自行推理。
  服务商若不认这个字段并返回 400，客户端会**去掉该字段自动重试一次**；
  也可把客户端里的 `DISABLE_THINKING` 置为 `false` 彻底关闭该行为。
- 业务调用的 HTTP 超时为 `AI_CALL_TIMEOUT_MS = 50000`，刻意比云函数上限少 10 秒，
  给数据库读写和组包返回留余量，**不要调到贴着 60000**。

## 登录与用户身份（Phase 2）

```
小程序启动 → App.initCloud（校验环境 ID）
        → App.restoreLocalState（先用本地缓存恢复 UI）
        → App.initAuth
             有缓存 → auth.getCurrentUser 校验
                       服务端无此用户 → 清缓存 → auth.login
             无缓存 → auth.login
        → 写入 globalData.user / isLoggedIn，广播给订阅页面
```

关键约定：

- **身份只来自 `cloud.getWXContext().OPENID`**，云函数绝不读取、也绝不信任前端传入的身份字段。
- 前端**不缓存、不传播 openid**：本地只存 `wte:currentUser`（`_id`/昵称/头像/时间戳）与 `wte:currentFamilyId`。
- 业务统一使用 `users._id` 作为用户业务 ID，后续 `family_members.userId` 等均关联它。
- `login` **幂等**：同一微信用户重复登录只返回同一用户，服务端仅刷新 `updatedAt`。
- `login` 与 `getCurrentUser` 职责分离：前者确保用户存在，后者只查询、不存在时返回 `USER_NOT_FOUND`。
- 前端 `authService.login()` 内有 Promise 级**并发保护**，App 启动与页面同时触发也只发一次请求。
- 页面**不各自调用 login**，统一通过 `getApp().getAuthState()` 或 `onAuthStateChange()` 获取登录态。
- 云服务暂时异常时**保留本地登录数据**，只提示网络异常，不清空登录态。

## 家庭系统（Phase 3）

```text
无家庭 ──创建家庭──▶ 管理员(owner)
   ▲                   │ 分享 6 位邀请码
   │                   ▼
   └──退出/被移除/解散── 普通成员(member)
```

- **一个用户同时最多属于一个家庭**，不做多家庭切换。
- **权限判定始终在服务端**：`openid → users → family_members → families`。
  前端传入的 `familyId` 只表示「想操作哪个家庭」，不作为权限依据；
  本地 `wte:currentFamilyId` 只是 UI 与导航辅助，永远不是权威。
- **服务端只接受白名单字段**（`name` / `preferences`），
  客户端传入的 `openid` / `ownerId` / `role` / `status` / `inviteCode` 一律忽略。
- **「没有家庭」是正常业务状态**：`getMyFamily` 返回 `family: null`，不算异常。
- **数据库是唯一事实**：App 启动与页面 `onShow` 都会重新拉取，服务端返回空就清掉本地脏 `currentFamilyId`；
  网络异常时保留现有状态与本地缓存，只提示错误，不清空数据。
- **退出登录 ≠ 退出家庭**：`clearFamily()` 只清家庭态，不动 `currentUser`。
- **邀请码**：6 位，字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（排除 O/0/I/1），
  由服务端生成、不可自定义、不可修改、日志只记布尔值不记明文。
- **管理员（owner）**：可改家庭设置、移除成员、解散家庭；
  不能退出家庭（避免产生无主家庭），也不能移除自己。
- **普通成员（member）**：可查看家庭与成员、可自行退出；不能改设置、不能移除他人。
- **家庭人数上限** 10 人；重复加入返回 `ALREADY_MEMBER`，超员返回 `FAMILY_FULL`。
- **解散家庭**：`families.status` 置为 `deleted` 并清理全部成员关系；旧邀请码立即失效。

家庭相关页面：`pages/family/index`（家庭主页）、`create`（创建）、`join`（加入）、`settings`（设置）。
首页与「我的」页均按「无家庭 / 有家庭」两种状态渲染，不强制跳转。

## 食材库存（Phase 4）

- **页面**：`pages/ingredients/index`（TabBar「食材」）。按分类折叠的列表 + 底部弹层新增 / 编辑，删除有二次确认。
- **字段**：名称、数量、单位、分类、购买日期（可选）、保质天数（可选）、到期日（可选）、备注（可选）。
- **单位只支持 `g` / `kg` / `个` / `袋` / `盒`**，`kg → g` 展示时按 ×1000 换算；
  `个` / `袋` / `盒` 在缺 `averageWeight` 时**不猜测换算**，只原样展示；
  换算成克只在 Phase 5 的营养计算里做（见「营养计算」）。
- **云函数**：`ingredient`，四个 action —— `listIngredients` / `createIngredient` /
  `updateIngredient` / `deleteIngredient`。
- **权限**：所有操作都走同一套 `openid → users → family_members → families` 复核，
  前端传入的 `familyId` 只表示「想操作哪个家庭」，不作为权限依据。
- **归属字段由服务端生成**：`familyId` / `createdBy` / `standardName` / `createdAt` / `updatedAt`
  一律不看客户端传值，客户端伪造这些字段会被直接丢弃。
- **只写白名单字段**：`name` / `quantity` / `unit` / `category` / `expireDate` / `remark`。
- **标准名（别名映射）**：`name` 原样保留，`standardName` 由服务端查表得出
  （如 西红柿 → 番茄、香葱 → 小葱、马铃薯 → 土豆）。
  内置一份常用映射，`ingredient_aliases` 集合中的记录覆盖内置项；
  该集合可以不存在，缺集合时自动退回内置表，不阻塞添加食材。
- **跨家庭隔离**：修改 / 删除前必须用 `{_id, familyId}` 一起定位，
  别人的食材一律返回 `INGREDIENT_NOT_FOUND`（不泄露其是否存在）。
- **网络异常不清空列表**：仅提示错误并保留现有数据，避免误以为库存被清空。
- 本阶段**不做**：拍照识别、OCR、语音输入、自动扣库存、复杂单位、库存统计。

### 食材保质期（Phase B）

- **自动到期日**：填了购买日期 + 保质天数时，服务端自动推导 `expireDate` 并落库；
  优先级为 显式 `expireDate` > 购买日期 + 保质天数 > 空。推导只在服务端做一次，服务端独立校验。
- **临期与过期**：阈值 `SHELF_LIFE_WARNING_DAYS = 3`（`miniprogram/utils/shelf-life.ts`）。
  今天到期算临期（⏰），严格早于今天算已过期（⚠）。日期按 UTC 天数序号计算，不受时区影响。
- **分类折叠**：列表按 `INGREDIENT_CATEGORIES` 分组，组内「过期 → 临期 → 新鲜 → 无到期日」排序，
  折叠状态在前端保留；历史遗留的未知分类统一归入「其他」。
- **快捷操作**：每项提供「已用完」（从库存移除）、「补货」（改总数并刷新购买日期）、
  「做法」（跳转菜谱页并按食材名预填关键词）。
- **推荐排除过期食材**：`cloudfunctions/recommend/shelf-filter.js` 在构建库存名单前
  过滤掉到期日早于北京时间当天的食材；当天到期仍参与推荐，未填到期日不受影响。
- **列表直接显示卡路里**：每项食材名旁展示「约 N kcal」（该食材全部数量的合计估值）。
  数值由 `nutrition` 云函数按 `nutrition_facts` 算出，前端**不养第二份营养表、不做任何换算**；
  超过 100 种食材时分批请求。拿不到热量时只隐藏该数字，不影响库存列表。
- **表单面板**：`scroll-view` 必须给显式高度约束（`max-height`），否则内容会先把弹层撑高，
  把底部的保存 / 删除按钮顶出可视区域。

## 统一 AI 服务（Phase C）

Phase C 将「内置 AI」（开箱即用）加入项目，与已有的用户自配 API 平级，通过统一入口路由。

### 两种模式

| 模式 | 凭据来源 | 存储位置 | 说明 |
|------|---------|---------|------|
| `builtin` | 云函数环境变量 | 不落库（明文，服务端内存） | 默认模式，开箱即用 |
| `custom` | 用户在 AI 设置页填写 | `user_ai_configs`（AES-256-GCM 密文） | Phase 7 已有，保留不变 |

### 内置通道

- **凭据**：`AI_BUILTIN_ENABLED` / `AI_BUILTIN_BASE_URL` / `AI_BUILTIN_MODEL` / `AI_BUILTIN_API_KEY`
  四个环境变量。三件套（URL + 模型 + Key）缺一不可，未配置时 `fail closed`。
- **每日额度**：`AI_BUILTIN_DAILY_QUOTA` 控制每用户每日调用上限（默认 20，钳制在 1~1000）。
  按「北京时间自然日」重置。采用原子条件更新（`count < quota` 时才 +1），防止并发绕过。
- **用量日志**：每次调用写入 `ai_logs` 集合（脱敏），同时输出 console.log；集合缺失不影响调用。

### 模式切换

- **默认模式**：内置（首次使用无需任何配置）。
- **切换入口**：AI 设置页顶部提供两个选项卡，选中即切。
- **切到自定义前**：必须已有保存过的 API 配置（否则每次调用都失败，无法排查）。
- **删除自定义配置时**：服务端自动把模式退回内置。
- **内置未就绪 / 额度耗尽**：返回明确的中文提示，引导用户配置自己的 API。

### 统一入口

- `ai-service.js`（5 个 AI 云函数各一份，SHA256 一致）提供 `resolveAiCall` / `runAiCall`。
- `resolveAiCall(db, userId)` 按用户偏好选择模式 → 检查额度 → 返回 `aiConfig`（内置走环境变量明文，
  自定义走密文）。
- `runAiCall(db, userId, options, fn)` 在 `resolveAiCall` 基础上包装调用、计时、记日志。
- `menu` / `recipe` / `recommend` 三个 AI 云函数全部通过 `runAiCall` 发调用，不再各自直连
  `user_ai_configs`。

### 安全

- 内置 API Key **只在 `getBuiltinConfig` 的返回值中出现一次**，不经过日志、不进数据库、
  不进任何响应体；`getBuiltinStatus()` 返回值不含凭据、供应商 Base URL、模型名。
- `user_ai_prefs` 集合只存模式偏好（`builtin` / `custom`），与 `user_ai_configs` 的凭据行解耦。
- 客户端传入的任何字段（`apiKey` / `baseUrl` / `encryptedApiKey` / ……）都无法覆盖服务端构造的
  `aiConfig` —— `resolveAiCall` 只以服务端数据为准。

### 集合

| 集合 | 用途 |
|------|------|
| `user_ai_prefs` | 用户 AI 模式偏好（`builtin` / `custom`），与凭据行解耦 |
| `ai_usage` | 内置额度计数器，`_id = userId_日期` 保证同日同用户只有一行 |
| `ai_logs` | AI 调用日志（脱敏），每次调用写一行 |

### 部署

1. **创建数据库集合**：`user_ai_prefs`、`ai_usage`、`ai_logs`（如已存在则跳过）
2. **设置环境变量**（在需要使用内置 AI 的云函数上配置）：
   - `AI_BUILTIN_ENABLED=true`
   - `AI_BUILTIN_BASE_URL=https://your-vendor.example.com/v1`
   - `AI_BUILTIN_MODEL=your-model-name`
   - `AI_BUILTIN_API_KEY=sk-xxxxxxxx`
   - `AI_BUILTIN_DAILY_QUOTA=20`（可选，默认 20）
3. 上传 `ai-config` / `menu` / `recipe` / `recommend` / `chat` 五个云函数（含 `ai-service.js` 与 `openai-compatible-client.js`）
4. **验证**：`npm run verify:ai`（112 项全部通过即就绪）

### AI 做饭机器人（chat 云函数）

| 项目 | 说明 |
| --- | --- |
| action | `chat` |
| 入参 | `familyId`、`message`、`history`（可选，最近若干轮） |
| 权限 | 必须是该家庭成员（`requireFamilyMember` 复核） |
| 额度 | 复用 `ai-service` 的每日额度与限流，不单独计数 |
| 话题约束 | 系统提示词 + 服务端轻量规则双重限制在「做饭 / 家庭饮食」范围 |
| 缺集合 | `ai_usage` 缺失时额度不生效；`ai_logs` 缺失只告警 |

`chat` 与本项目其它 AI 函数共用同一份 `ai-service.js` / `openai-compatible-client.js`，
调用失败时返回统一错误结构（`AI_QUOTA_EXCEEDED` / `AI_DB_NOT_READY` 等），前端据 `code` 提示。

## 营养计算（Phase 5）

- **页面**：`pages/nutrition/index`（从食材页「营养估算」进入）。展示整桌合计、人均、
  逐项明细，并强制携带免责声明。
- **云函数**：`nutrition`，两个 action —— `calculateNutrition` / `seedNutritionFacts`。
- **核心口径：营养只能由程序算**。入参只接受「食材名 + 数量 + 单位 + 人数」，
  客户端或 AI 一并传来的 `calories` / `nutrition` 等字段在入参归一化阶段就被丢弃，
  绝不可能覆盖程序结果。
- **计算公式**（与规范第 5 章一致）：

  ```
  单位克数 = g → 数量 ; kg → 数量 × 1000 ; 个/袋/盒 → 数量 × averageWeight
  可食克数 = 单位克数 × edibleRate
  某项营养 = 可食克数 ÷ 100 × per100g.该项
  总营养   = 各食材求和 ; 人均 = 总营养 ÷ peopleCount
  ```

- **单位换算**：`g` / `kg` 为基础换算；`个` / `袋` / `盒` **只有**在
  `nutrition_facts.averageWeight` 存在时才换算，缺重量时返回 `grams: null`、
  `status: 'unconvertible'`，**不让 AI 猜**。
- **缺失食材不编数值**：数据库里没有的食材返回 `status: 'missing'`、`nutrition: null`，
  并出现在 `missing` 清单里。只要出现 `missing` 或 `unconvertible`，
  `nutritionStatus` 即为 `partial`，页面展示「部分营养数据缺失，仅供参考。」
- **返回结构**：`calories` / `protein` / `fat` / `carbohydrate`（整桌合计）、
  `perPerson`（人均）、`peopleCount`、`nutritionStatus`、`missing`、`unconvertible`、
  `computedCount`、`items`（逐项）。
- **热量展示**：统一「约 XXX kcal」（`KCAL_PREFIX`），禁止「精确」表述；
  免责声明「营养数据为估算值，仅供饮食参考。」由 `nutrition-card` 组件默认携带。
- **基础数据**：`cloudfunctions/nutrition/nutrition-data.js` 内置约 70 条常见食材的
  **参考值**（每 100g 可食部）。首次部署后调用一次 `seedNutritionFacts` 写入
  `nutrition_facts`，之后可在控制台按需替换 / 补充；数据库记录**覆盖**内置同名项。
  拿不准的食材请勿加入，宁可走 `partial`。
- **家庭数据边界**：`calculateNutrition` 是纯计算，登录即可调用；
  **只有**传了 `familyId` 时才走 `openid → users → family_members → families` 复核，
  非成员一律 `PERMISSION_DENIED`。
- 本阶段**不做**：医疗建议、减肥方案、疾病营养方案、每日营养分析、一周营养报告。

## 基础菜谱库（Phase 6）

- **页面**：`pages/recipes/index`（列表，从首页「家常菜谱」进入）与
  `pages/recipes/detail`（详情）。菜谱是**公共只读**数据，未登录也能浏览，
  因此没有新增 TabBar 项。
- **云函数**：`recipe`，本阶段实现三个 action —— `listRecipes` / `getRecipe` /
  `seedRecipes`。`generateRecipe` / `retryRecipe` 仍返回 `NOT_IMPLEMENTED`，留给后续阶段。
- **客户端没有任何写菜谱的口子**：`recipe` 云函数不提供创建 / 修改 / 删除接口，
  内置菜谱只能由初始化脚本写入，避免被前端或误操作改坏。
- **`listRecipes` 入参**：`{ category, keyword, page, pageSize }`
  - `category` 默认「全部」；`page` 默认 1；`pageSize` 默认 20、上限 50；
  - 只返回 `source = 'builtin'` 且 `isActive = true` 的菜谱；
  - 关键词按**字面量**匹配（正则元字符已转义），最长 20 字；
  - 返回 `{ items, total, page, pageSize }`，`items` 只含列表真正需要的字段，
    **不夹带 `ingredients` / `steps`**；
  - 按菜名升序稳定排序，分页用 `skip + limit`。
- **`getRecipe` 入参**：`{ recipeId }`，返回 `{ recipe }`。
  `recipeId` 缺失或非法 → `INVALID_PARAMS`；不存在**或已禁用** →
  `RECIPE_NOT_FOUND`（两种情况同一个错误码，不泄露某个菜谱是否存在）。
- **内置数据**：`cloudfunctions/recipe/recipe-data.js` 共 **200 道**菜谱，
  （家常菜 45 / 蔬菜类 40 / 汤类 35 / 主食类 30 / 儿童餐 25 / 减肥餐 25），每道含简介、标签、难度、总时长、
  适用人数、量化食材与逐道编写的步骤（每步带独立 `minutes`）。
  两条硬性约束：
  - **不允许「适量 / 少许」这类无法换算的写法** —— 否则 Phase 7 无法复用营养数据；

## AI 智能推荐（Phase 7）

Phase 7 允许用户自配 AI 模型 API，通过家庭食材和 Phase 6 菜谱库，由 AI 推荐 3 套菜单。

### 安全

| 约束 | 说明 |
|------|------|
| API Key 加密 | AES-256-GCM 加密存入数据库，密钥来自云函数环境变量 `USER_API_KEY_ENCRYPTION_SECRET`（64 位 hex） |
| 前端隔离 | 查询接口只返回 `sk-****abcd` 脱敏状态，完整 Key 绝不离开云函数 |
| URL 校验 | 仅允许 HTTPS，拒绝内网 / 回环 / 元数据地址（防 SSRF） |
| 调用链路 | 前端 → 云函数 → 用户配置的模型服务（不经过平台后台 AI） |
| AI 输出校验 | 推荐的 recipeId 必须在菜谱库中存在，营养值由 Phase 5 计算，不信任 AI 输出 |
| 日志安全 | 不记录 API Key、Authorization 头或完整请求体 |

### 数据模型

- **集合** `user_ai_configs`：字段 userId / baseUrl / model / encryptedApiKey / keyNonce / keyAuthTag / keyVersion / createdAt / updatedAt
- `encryptedApiKey` / `keyNonce` / `keyAuthTag` 为 AES-256-GCM 加密三要素
- `keyVersion` 用于未来轮换密钥

### 用户流程

1. 用户进入「模型 API 设置」（从「我的」页或推荐页进入）
2. 填写兼容 OpenAI Chat Completions 的 API Base URL、模型名称、API Key
3. 点击「测试连接」验证连通性（发一条短 ping 消息）
4. 保存配置后，在推荐页填写人数、餐次、口味偏好，点击「开始推荐」
5. 推荐页跳转到结果页，展示 3 套菜单（每套含 title / reason / dishes / totalCookTime）

### 推荐云函数工作流

```
前端入参（mealType / servings / preferences）
  → 身份校验（OPENID → users → family_members）
  → 读取 AI 配置（解密 API Key）
  → 读取家庭食材
  → 读取菜谱库（isActive=true）
  → 生成候选列表（最多 50 个，按食材匹配度排序）
  → 构建提示词（系统提示 + 候选菜谱 JSON + 食材清单）
  → 调用用户自配 API（OpenAI Chat Completions）
  → 解析 JSON → 二次校验（recipeId 存在性）
  → 返回真实菜谱数据
```

### 前端文件

| 文件 | 说明 |
|------|------|
| `miniprogram/types/ai-config.ts` | AiConfigInfo / AiConfigInput / AiConfigTestResult / RecommendMenusResult 等类型 |
| `miniprogram/services/ai-config.ts` | aiConfigService（getConfig / saveConfig / deleteConfig / testConnection） |
| `miniprogram/services/recommend.ts` | 新增 recommendMenus 方法（generateRecommendations / replaceDish 仍为桩） |
| `miniprogram/pages/ai-settings/index.{ts,wxml,wxss,json}` | 模型 API 配置页面 |
| `miniprogram/pages/recommend/index.{ts,wxml}` | 推荐条件收集（接入真实 AI 调用） |
| `miniprogram/pages/recommend-result/index.{ts,wxml,wxss,json}` | 推荐结果展示 |

### 用户需手动操作

1. **创建数据库集合**：在云开发控制台创建 `user_ai_configs` 集合
2. **设置环境变量**：在云函数环境变量中设置 `USER_API_KEY_ENCRYPTION_SECRET`（64 位 hex 随机串）
3. **部署云函数**：上传 `ai-config` 和 `recommend` 两个云函数
4. **初始化菜谱**：调用 `recipe.seedRecipes` 初始化菜谱库（如之前 Phase 6 已完成则跳过）

## 菜单换菜与锁定（Phase 8）

Phase 8 在 AI 推荐结果页上增加菜单调整能力：用户可从 3 套 AI 推荐中选一套保存为草稿菜单，然后锁定满意的菜品、更换不满意的菜品、批量重新推荐未锁定菜品，最后确认菜单。

### menu 云函数

| action | 说明 |
|--------|------|
| `saveMenu` | 将 AI 推荐结果保存为 draft 菜单（数据写入 `menus` 集合） |
| `getMenu` | 按 `menuId` 查询菜单详情 |
| `setMenuItemLocked` | 锁定 / 取消锁定一道菜 |
| `replaceMenuItem` | 换一道菜：排除已有菜品，AI 从菜谱库中选取替换 |
| `regenerateUnlockedItems` | 批量重新推荐：保留锁定菜品，只替换未锁定项 |
| `confirmMenu` | 确认菜单（status → confirmed） |

### 安全与数据规则

| 约束 | 说明 |
|------|------|
| 身份校验 | `openid → users → family_members`，菜单必须属于当前家庭 |
| 锁定保护 | 已锁定菜品不能被单独替换或批量重推覆盖 |
| AI 输出校验 | 所有 recipeId 必须在 `recipes` 集合中存在，拒绝 AI 编造的菜品 |
| 原子更新 | 批量重推失败时原菜单保持不变；确认后菜单不可再修改 |
| 防重复 | 换菜和批量重推均排除已在菜单中的菜品 |
| 候选不足 | 候选菜品不够时返回明确提示，不伪造不重复 |

### 前端页面

`pages/recommend-result/` 重构为三模态页面：

1. **选择模式**（selection）：展示 3 套 AI 推荐方案，每套底部有「选这套」按钮
2. **交互模式**（interactive）：展示已保存菜单，每道菜有锁定/解锁和换一道按钮；底部有「重新推荐未锁定菜品」和「确认菜单」
3. **已确认模式**（confirmed）：只读展示 + 绿色确认横幅

交互细节：
- 锁定状态有橙色边框 + 🔒 徽章
- 锁定/解锁操作先在 UI 乐观更新，服务端失败时回滚
- 防止连续点击（操作期间禁用按钮）
- 换菜返回新菜名 toast 提示

### 用户需手动操作

1. **创建 `menus` 集合**：云开发控制台 → 数据库 → 新建集合 `menus`，权限「仅创建者可读写」
2. **部署 `menu` 云函数**：上传 `menu` 云函数（包含 `openai-compatible-client.js`）
3. `menu` 云函数需要设置环境变量 `USER_API_KEY_ENCRYPTION_SECRET`（与 Phase 7 相同密钥）

## 家庭点单（Phase 9）

Phase 9 实现家庭点单闭环：从已确认菜单发起点单 → 家庭成员选择菜品和份数 → 管理员查看汇总 → 关闭点单。

### order 云函数

| action | 说明 |
|--------|------|
| `createOrder` | 从已确认菜单发起点单（status: open） |
| `getOrder` | 查询点单详情（含菜品列表、当前用户选择、权限信息） |
| `submitOrderItems` | 成员批量提交/修改自己的选择（覆盖式，非追加） |
| `getOrderSummary` | 管理员查看汇总（按菜品 + 按成员） |
| `closeOrder` | 管理员/发起人关闭点单（status: closed，保存最终汇总快照）；未超时点单要求全员提交份数，**超过 48 小时的点单可直接关闭** |
| `cleanupOpenOrders` | 一次性把本家庭所有 `open` 点单收尾为 `closed`（`closedBy=system`、`closeReason=legacy_cleanup`） | 仅家庭管理员；单次最多 50 条，可重复执行 |

### 数据模型

- **`family_orders`**：_id, familyId, menuId, title, status(open/closed), deadline, note, initiatorUserId, recipeIds[], createdAt, updatedAt, closedAt, finalSummary, totalParticipants
- **`family_order_items`**：_id, orderId, familyId, userId, items[{ recipeId, quantity, note }], createdAt, updatedAt（每个用户每个点单一条文档）

### 业务流程

```
确认菜单 → 发起点单 → 家庭成员选择菜品/份数/备注 → 管理员查看汇总 → 关闭点单
```

- 入口 1：确认菜单页（recommend-result）→「发起家庭点单」
- 入口 2：点单 Tab 页（order/index）→「发起家庭点单」
- 入口 3：微信分享卡片（携带 orderId）

### 权限规则

| 操作 | 权限 |
|------|------|
| 发起点单 | 任何家庭成员 |
| 提交/修改选择 | 本人（不可修改他人） |
| 查看汇总 | 任何家庭成员 |
| 关闭点单 | 管理员或发起人 |
| 重复发起同一菜单 | 拒绝（需先关闭进行中的） |

### 页面

| 页面 | 说明 |
|------|------|
| `pages/order/index` | 点单列表 Tab 页 + 发起入口 |
| `pages/order-detail/index` | 点单详情：菜品选择（勾选/份数/备注）、保存、管理员关闭/汇总 |
| `pages/recommend-result/index` | 确认菜单后新增「发起家庭点单」按钮 |

### 用户需手动操作

1. **创建数据库集合**：`family_orders` 和 `family_order_items`，权限均「仅创建者可读写」
2. **部署 `order` 云函数**：上传 order 云函数（云端安装依赖）

## AI 菜谱与烹饪步骤 / Phase 9 补齐（Phase 10）

### Phase 9 遗留问题修复

1. **`listOrders` action**：点单 Tab 页现在可以通过 `order.listOrders` 查询当前家庭的点单列表，支持分页和状态筛选
2. **成员昵称**：汇总中的 `memberSummary` 现在包含 `displayName`（从 `users.nickName` 批量查得），不再只显示 `userId`
3. **截止时间**：`createOrder` 可接受 `deadline` 并做服务端校验（格式 + 必须晚于当前时间）；`submitOrderItems` 在截止后返回 `DEADLINE_PASSED`

### recipe 云函数新增

| action | 说明 |
|--------|------|
| `generateCookingSteps` | 接收 recipeId + 可选 servings/preferences，通过用户自配 API 生成详细做法 |
| 已有 `listRecipes` / `getRecipe` / `seedRecipes` | 保持不变 |

### AI 生成流程

```
前端 → recipe.generateCookingSteps(recipeId)
  → 读取 recipes 集合原始菜谱
  → 检查 generated_recipes 缓存
  → 调用用户自配 OpenAI 兼容 API
  → 校验 JSON 结构（steps 非空、格式合法）
  → 保存到 generated_recipes 集合
  → 返回结构化烹饪数据
```

- **缓存优先**：已生成过的菜谱直接返回缓存，不重复调用 API
- **不覆盖原始数据**：生成结果保存在独立的 `generated_recipes` 集合
- **不信任 AI 输出**：服务端逐字段校验，空步骤/非法 JSON 拒绝并返回错误

### 前端改造

`pages/recipes/detail` 新增：
- 未配置 API 时显示「去配置」入口
- 已配置 API 时显示「生成详细做法」按钮
- 生成中显示 loading 状态
- 成功后展示：简介 → 食材准备 → 准备工作 → 详细步骤 → 小贴士 → 安全提示
- 失败后可重试，原始菜谱始终保留

### 用户需手动操作

1. **创建 `generated_recipes` 集合**：云开发控制台 → 数据库，权限「仅创建者可读写」
2. **部署 `recipe` 云函数**：上传 recipe 云函数（含 openai-compatible-client.js）
3. **设置环境变量**：`recipe` 云函数需要 `USER_API_KEY_ENCRYPTION_SECRET`（与 Phase 7 相同）
  - **不允许两道菜共用同一套通用步骤**，步骤必须逐道写。

  食材名尽量对齐 `nutrition-data.js` 的 `standardName`，便于后续自动复用营养库。
- **初始化（幂等）**：部署 `recipe` 后调用一次 `{"action":"seedRecipes"}`，
  返回 `inserted` / `updated` / `total`。以 `name` 作为内置菜谱的业务唯一键，
  已存在则更新、缺失才新增，**可重复执行不产生重复数据**；
  且只读改 `source = 'builtin'` 的记录 —— 用户自建（`manual`）与
  AI 生成（`ai`）菜谱既不被覆盖也不被删除。
  本机没有云环境时直接运行 `node seed-recipes.js` 会明确报错退出，不会伪装成写入成功。
- 本阶段**不做**：用户自建菜谱、收藏、评分、评论、拍照识菜、一周菜谱计划。

## 历史记录（Phase 11）

**不新增集合**：历史菜单直接读取 `menus` 中 `status = 'confirmed'` 的文档；
每份已确认菜单本身就是一份不可变快照（`items[]` 里已保存确认时的菜名、分类、
食材、时长），因此新菜单确认不会覆盖旧记录。历史点单读取 Phase 9 的
`family_orders` / `family_order_items`。

### 新增 / 补齐的云函数 action

| action | 云函数 | 说明 |
|--------|--------|------|
| `getMenuHistory` | menu | 本家庭已确认菜单列表；支持分页、状态、日期范围，默认时间倒序 |
| `getTodayMenu` | menu | 最近一份已确认菜单（原为未实现桩） |
| `getMenu` | menu | 由「传了 familyId 才校验」改为**强制**家庭归属校验 |
| `listOrders` / `getOrder` / `getOrderSummary` / `closeOrder` | order | 复用 Phase 9/10 实现，仅补历史展示字段与只读语义 |

### 权限校验

- 身份只取 `cloud.getWXContext().OPENID`，前端传的任何用户 ID 都被忽略；
- 所有历史查询先经 `requireFamilyMember(openid, familyId)`：
  未登录 → `UNAUTHORIZED`，非成员 → `NOT_IN_FAMILY`，缺参 → `INVALID_PARAMS`；
- 菜单详情额外校验 `menu.familyId === 该家庭`，跨家庭 → `FORBIDDEN`；
- 点单详情 / 汇总按 `order.familyId` 反查成员身份，跨家庭一律拒绝；
- 分页参数上限：菜单与点单 `pageSize ≤ 50`，页码非法回退为 1；
- 返回值不含 openid / API Key / 加密密钥；成员显示名来自 `users.nickName`，
  缺失时回退「家庭成员」。

### 页面

- `pages/menu/index`：当前菜单 / 历史菜单两个标签页，历史列表触底分页、
  空 / 加载 / 失败重试状态齐全，点击进入菜单详情，点击菜品进入菜谱详情；
- `pages/menu-detail/index`：展示当时菜单的菜品清单（含锁定标记），
  每道菜可跳转 Phase 6/10 的菜谱详情查看或生成做法；
- `pages/order/index`：新增全部 / 进行中 / 已关闭筛选，展示菜单名、发起人、
  截止时间、关闭时间与参与人数；
- `pages/order-detail/index`：新增关闭时间展示与「做法 ›」入口；
  已关闭订单不渲染任何编辑控件（只读）；
- `pages/recipes/detail`：支持 `?name=` 历史菜名快照兜底——菜谱已下架/删除时
  仍展示当时的菜名并明确提示「当前内容已不可用」；
- `pages/mine/index`：新增「历史菜单 / 历史点单」入口。

### 本阶段不做

营养趋势、周报月报、消费统计、评分评论、历史菜单一键复制。

## 采购闭环（Phase E）

Phase E 补齐从菜单到采买的最后一公里，并引入过敏原 / 忌口硬过滤作为安全约束。

### E1：采购清单

- **云函数**：`shopping`，三个 action —— `generateShoppingList` / `getShoppingList` / `toggleShoppingItem`
- **聚合核心**：`cloudfunctions/shopping/shopping-core.js`（纯函数，无云开发依赖）
  - 按菜单人数等比缩放菜品食材用量
  - 汇总同一食材同一单位，kg 归一化为 g
  - 扣减当前家庭库存，得出待购量与已备齐标记
  - 按食材分类分组，分类优先 → 待购优先排序
- **数据集合**：`shopping_lists`（每菜单一份，含 items + 勾选状态）
- **安全**：
  - 身份只取 `cloud.getWXContext().OPENID`，经 `requireFamilyMember` 复核
  - 生成时校验菜单归属 + 已确认状态
  - 读取时按 menuId 校验菜单属于该家庭（防跨家庭数据泄露）
  - 清单内容全部由服务端按菜单与库存推导，不信任客户端提交的采购项
- **前端（E1/E3）**：
  - 新增 `pages/shopping/index`（ts/wxml/wxss/json）
  - 新增 `miniprogram/services/shopping.ts`、`miniprogram/types/shopping.ts`
  - 菜单详情页（已确认时）显示「采购清单 」入口
  - 按分类分组展示，每项显示需要量 / 库存量 / 待购量
  - 勾选状态持久化（乐观更新 + 失败回滚）
  - 「重新生成」按最新库存刷新并保留勾选
  - 「复制清单」一键生成纯文本到剪贴板

### E2：过敏原 / 忌口硬过滤

- **纯函数模块**：`cloudfunctions/recommend/diet-filter.js`（menu 目录存字节一致副本）
- **关键词表**：
  - 8 组常见过敏原（花生/鸡蛋/牛奶/大豆/小麦/坚果/鱼类/甲壳类），每组对应菜谱中常见食材关键词
  - 6 组忌口标签扩充（海鲜/肉/猪肉/鸡肉/辣），标签经前缀剥离后匹配
  - 子串匹配菜名 + 每个食材名，命中的 recipeId 从候选列表排除
- **接入点**：
  - `recommend` 云函数 `recommendMenus`：候选列表先用硬过滤筛掉过敏/忌口菜谱，AI 提示词也写入禁止指令，AI 结果再做一次兜底复核
  - `menu` 云函数 `replaceMenuItem` / `regenerateUnlockedItems`：换菜候选同样按家庭偏好过滤
- **安全**：偏好只读取服务端 `families.preferences`，不信任客户端参数

### E3：体验优化

- 采购清单勾选状态持久化（跨家庭成员共享）
- 一键复制清单文本
- 空状态 / 加载态 / 错误态完整覆盖
- 刷新时保留已有勾选（按 key 匹配）

### 本阶段不做

- 不新建 TabBar 入口（采购清单从菜单详情进入）
- 不在前端展示或编辑过敏原 / 忌口标签（偏好设置留给家庭设置页后续迭代）
- 不根据勾选自动更新库存

## 餐次协作（Phase 1）

目标：一顿餐只有一个发起人（即掌勺人），由他从 AI 推荐里挑菜保存成本餐点单；
家人只对被保存的菜提建议；最终菜单由掌勺人锁定，掌勺人做完了家人才能评价加分。

### 角色与权限

- **一顿餐只有一个掌勺人**，由 `menu_plans.cookId` 决定，不是身份枚举。
  本餐次第一个发起推荐的人就是掌勺人；同一日期 + 餐次已有方案时，
  其他人再发起只会拿到同一份方案，不能另起一套。
- **管理员 ≠ 掌勺人**：管理员不会自动获得锁定 / 改菜权。
  交接只能由**当前掌勺人**发起；管理员无法接管一个还在家庭里的掌勺人。
- **兜底例外**：掌勺人已经退群（或方案里没有掌勺人）时，这一餐否则会永久卡死，
  此时允许家庭管理员接管（`canTakeOver`）。判定集中在 `resolveCookAuthority`，
  `saveMenu` / `setMealCook` / 看板共用同一套结论。
- **掌勺人**：从推荐结果里挑菜、保存点单、随时锁定（**不必等家人全部提完建议**）、
  标记完成制作、交接掌勺人、换一批推荐。
- **干饭人**：查看掌勺人保存的点单，对每道菜点「想吃 / 不想吃」、留言；
  **不能改菜、不能锁菜单**。建议只作参考，不影响最终菜单内容。
- **锁定之后**：家人才能评价；掌勺人本人不参与自己这餐的评价（避免自评刷分），
  评分汇总结算成掌勺人积分。

### 一次完整流程

1. 有人发起 AI 推荐 → 成为本餐次掌勺人（唯一）。
2. 掌勺人在推荐结果页挑菜 → 「保存点单」→ 生成 `menus.status = 'draft'`，
   并把 `draftMenuId` 回写到 `menu_plans`。
3. 干饭人在「点菜」页对这道点单里的菜点想吃 / 不想吃。建议不改变菜单。
4. 掌勺人在「点菜」页看到「谁想吃、谁不想吃」后**锁定菜单**；
   家人没提完也可以直接锁定 → `menus.status = 'confirmed'`。
5. 掌勺人做完 → 「完成制作」→ `menus.status = 'completed'`，写入菜品快照。
6. 干饭人评价 → 汇总平均分 → 折算成掌勺人积分（一餐只结算一次）。

### 数据模型

`menu_plans`（每家庭 / 每天 / 每餐次一份有效方案）

| 字段 | 说明 |
| --- | --- |
| `familyId`, `date`, `mealType`, `servings` | 归属与份量；`date` 为北京时间 |
| `status` | `open` 未锁定 / `confirmed` 已锁定 / `superseded` 已被新版本取代 / `expired` 48 小时未推进自动作废 |
| `version` | 同一餐次重新生成时递增 |
| `cookId`, `cookName` | 当前掌勺人（= 发起人） |
| `cookHistory` | 交接审计（最近 20 条，含操作人 / 前后掌勺人 / 时间） |
| `draftMenuId` | 掌勺人保存的点单（`menus` 草稿）；为空表示还没保存 |
| `plans[]` | AI 返回的 2–3 套候选；**只给掌勺人挑菜用**，不再对外投票 |
| `menuId`, `confirmedBy`, `confirmedAt` | 锁定后回写 |
| `generatedBy`, `createdAt`, `updatedAt` | 生成人与时间 |
| `type: plan_lock`（同集合） | 生成锁文档，`_id = lock_家庭_日期_餐次`，3 分钟过期；不参与方案查询 |

`meal_preferences`（每位成员每餐次一条）

| 字段 | 说明 |
| --- | --- |
| `planId` | 方案文档 `_id`（服务端校验归属） |
| `menuId` | 建议所针对的草稿点单；掌勺人换菜后旧建议自然失效 |
| `dishVotes` | `[{ recipeId, vote: want/avoid }]`，按 `recipeId` 去重，且必须在该点单里 |
| `note` | 给掌勺人的留言，最多 50 字 |

`menus` 新增 `cookId` / `cookName` / `planId` / `planTitle` / `draftMenuId` 来源，
用于「掌勺人已保存 / 已锁定」标记与历史追溯；旧菜单没有这些字段时保持原行为。

### menu 云函数 action

| action | 说明 | 权限 |
| --- | --- | --- |
| `getMealBoard` | 返回本餐次方案、掌勺人已保存的点单、建议汇总、成员 | 家庭成员；不传 `mealType` 时取当天最近一份 |
| `submitPreference` | 新增 / 更新自己的菜品建议 | 家庭成员；只能写自己；必须先有草稿点单；已锁定 / 已取代拒绝 |
| `setMealCook` | 交接掌勺人 | 仅当前掌勺人；掌勺人已离群时管理员可兜底；目标必须是成员 |
| `saveMenu` | 把推荐菜保存成本餐点单 | 仅当前掌勺人（离群时管理员兜底）；同一餐次复用同一份草稿 |
| `confirmMenu` | 锁定最终菜单 | 仅当前掌勺人；**不校验家人是否都已提建议** |

`confirmPlan` 已删除：选方案这一步合并进了 `saveMenu` + `confirmMenu`，
避免同时存在两套「确认」入口。

`confirmMenu` / `setMenuItemLocked` / `replaceMenuItem` / `regenerateUnlockedItems`
新增掌勺人校验：带 `cookId` 的菜单只有掌勺人能改；没有 `cookId` 的旧菜单保持兼容。
掌勺人交接后，旧草稿的权限以方案当前的 `cookId` 为准，确认时同步更新菜单上的掌勺人。

### recommendMenus 变化

- 本餐次已有有效方案时**直接复用**，不再重复调用 AI、不再各生成一套。
- `force: true` 表示换一批：只有掌勺人可以发起；会先写入新方案、再把旧方案标记
  `superseded`（写入失败时旧方案仍然有效，家人不会突然没有菜单）。
- 已确认方案只有在 `force: true` **且** `confirmReplace: true` 时才允许替换。
- 新方案使用新的文档 ID，旧偏好不会错误继承到一批全新的菜上。

### 页面

- **点菜 Tab**：「本餐点单」看板，含餐次切换、掌勺人、家人建议进度、菜品建议、
  留言、掌勺人锁定 / 交接 / 换一批，以及锁定后的最终菜单与采购清单入口。
  - 还没人发起：显示「发起推荐并掌勺」。
  - 掌勺人还没保存点单：家人看到「掌勺人还在挑菜」。
  - 已有草稿：家人点想吃 / 不想吃；掌勺人看到「谁想吃、谁不想吃」并可随时锁定。
- **首页**：菜单卡片下方显示「掌勺人 + 家人已提建议 N/M」，点击进入点菜页。
- **推荐结果页**：掌勺人挑菜后「保存点单」回到点菜页；也可直接「锁定菜单」。
- **菜单详情页**：已锁定 / 已完成菜单显示「掌勺人 X」。

### 用户需手动操作

1. 云开发控制台创建集合：`menu_plans`、`meal_preferences`
   （权限「仅创建者可读写」，所有读写经由云函数）。
2. 按「索引创建清单」为两个集合建索引（#6–#9）。
3. 重新部署 `recommend` 与 `menu` 云函数。
4. 不创建集合也能上线：点菜页不会显示方案看板，原有推荐 / 点单流程不受影响。

### 定时维护（cleanup 云函数）

`cleanup` 每天凌晨 3:00（北京时间）执行，处理两类「停滞」数据：

| 对象 | 条件 | 动作 | 原因 |
| --- | --- | --- | --- |
| `menu_plans` | `status=open` 且 48 小时没更新 | → `expired` | 这餐没人管了，不该继续占着「一顿餐只有一个人发起」的位置 |
| `menus` | `status=confirmed` 且 48 小时没更新 | → `completed`（`completedBy=system`、`completionReason=auto_timeout`） | 开过火但没人点完成，自动收尾，家人才能进入评价 |

- 只按时间推进状态，**不删除**仍在用的数据；`draft` / `completed` / `superseded` 一律不碰。
- 方案作废后，同一餐次可以重新发起推荐，不会被旧方案挡住。
- 自动完成不写 `snapshotItems`；评价侧 `resolveDishSnapshot` 会回落到当前菜品，不会断链。
- 单次最多处理 500 条，重复执行幂等。
- 原来「清理 6 个月前已确认菜单」的逻辑保留在这一步之后。

### 存量点单一次性收尾

份数点单功能已从产品中移除，不再产生新点单；但旧点单仍停在 `open`。
删除只允许 `closed`，而 `closeOrder` 要求「全员提交份数」——这个前提再也无法满足，
于是旧点单**既关不掉也删不掉**。

处理方式是**只清理存量、不改变日常规则**：

- 点菜页在检测到有 `open` 点单时显示「收尾进行中」按钮（仅管理员可见）；
- 云函数 `order.cleanupOpenOrders` 把这些点单标为 `closed`，
  用与 `closeOrder` 相同的口径写 `finalSummary`（共用 `buildFinalSummary`）；
- 标记 `closedBy = 'system'`、`closeReason = 'legacy_cleanup'` 便于审计；
- 关闭后即可按原有路径勾选删除。
- 列表接口额外返回 `openTotal`，前端据此决定是否显示该入口
  （本地只有当前页，算不全）。

**注意**：`cleanup` 定时任务不处理点单，它只推进 `menu_plans` 与 `menus` 的状态。
点单的收尾必须由管理员手动触发一次。

### 已知限制

- 同一餐次的生成任务通过 `menu_plans` 中的 `plan_lock` 文档做 best-effort 互斥
  （固定 `_id = lock_家庭_日期_餐次`，3 分钟自动过期，被占用时返回 `PLAN_GENERATING`）；
  集合缺失时会跳过加锁，极端情况下仍可能重复生成。
- 「一顿餐只有一个发起人」依赖唯一有效方案：并发发起时后到的一方拿到锁失败或
  读到已有方案，不会各自生成一套；但 `saveMenu` 的草稿复用不是事务，
  极端并发下仍可能写入两份草稿（只会有一份被 `draftMenuId` 引用）。
- 建议以「一位成员一条记录」为准，按草稿菜单的 `recipeId` 校验；
  掌勺人换菜后，旧菜上的建议自动不再统计。
- 日期发生在北京时间当天内；跨零点后视为新的一天。

## 阶段二：饭后评价与掌勺人成长

菜单确认 → 实际做饭与用餐 → 标记本餐已完成 → 家人逐道菜评价 →
汇总有效评分 → 掌勺人获得成长积分 → 更新厨师等级。

### 数据模型

**`menus`（扩展现有文档，不新建集合）**

| 字段 | 说明 |
| --- | --- |
| `menuVersion` | 菜单版本；方案确认时沿用 `planVersion`，兜底 1 |
| `status` | 新增流转 `confirmed → completed` |
| `completedAt` / `completedBy` | 完成时间与操作者 |
| `snapshotItems` | 完成时固化的菜品快照 `[{recipeId, name, category, position}]` |

`snapshotItems` 是评价对象的唯一依据：完成之后任何菜单改动（包括换菜、历史重推、
甚至直接改库）都不会改变已经产生的评价归属。

**`meal_reviews`（新增，每位成员每餐一条）**

| 字段 | 说明 |
| --- | --- |
| `_id` | `rv_<menuId>_<userId>`，主键即「一人一餐一条」 |
| `familyId` / `menuId` / `userId` | 归属关系；`userId` 只来自登录态 |
| `ratings` | `[{recipeId, stars(1-5), comment(≤50)}]`，只含已评分菜品 |
| `createdAt` / `updatedAt` | 首次提交与最近一次修改时间 |

**`chef_points`（新增，掌勺人积分流水）**

| 字段 | 说明 |
| --- | --- |
| `_id` | `pt_<menuId>_<type>`，主键即幂等键 |
| `familyId` / `cookId` / `menuId` | 积分归属：家庭 + 掌勺人 + 用餐记录 |
| `type` | `meal_complete`（完成本餐）/ `rating_bonus`（评分奖励） |
| `points` / `reason` | 积分数值与可读原因 |
| `avgStars` / `ratingCount` | 评分奖励结算时的平均值与评分人数（可追溯） |
| `createdAt` | 写入时间 |

累计积分**不做缓存字段**，一律由流水求和得出，因此余额与流水不可能不一致。

### 积分规则（最终采用）

| 项目 | 规则 |
| --- | --- |
| 基础积分 | 本餐首次成功标记完成：**+10 分** |
| 评分奖励 | 本餐首次产生有效评分汇总时结算一次：`round(整体平均分 × 2)`，**上限 +10 分** |
| 未评分 | 平均分为 `null` → 只拿基础分，**不按满分计算** |
| 反复改分 | 评分奖励只有一笔流水（固定 `_id`），改分只更新 `meal_reviews` |

整体平均分 = 该餐所有「菜 × 人」有效 1—5 星评分的算术平均。
例：3 道菜都拿到 5 星 → 平均 5.0 → 奖励 10 分；只有一道菜 3 星 → 平均 3.0 → 奖励 6 分。

选择「首次产生有效评分即结算一次」而不是「每次提交都结算」，是因为后者会让
成员反复改分无限刷分；选「整体平均」而不是「按菜累加」，是因为按菜累加会让
多菜大餐天然比少菜小餐拿分高得多，不利于长期公平。

### 厨师等级（最终采用）

| 等级 | 名称 | 累计积分门槛 |
| --- | --- | ---: |
| 1 | 初级厨师 | 0 |
| 2 | 家常好手 | 50 |
| 3 | 家庭大厨 | 150 |
| 4 | 星级掌勺人 | 350 |
| 5 | 米其林主厨 | 700 |

等级由服务端按累计流水计算，前端传入的 `level` / `points` 一律忽略。
「米其林主厨」仅为游戏化称号，不代表任何真实餐饮资质。
按「每餐 10 分基础 + 最高 10 分奖励」估算，2 级约 3 餐、3 级约 8 餐、4 级约 18 餐、5 级约 35 餐。

### 新增接口（均在 `menu` 云函数内）

| action | 权限 | 说明 |
| --- | --- | --- |
| `completeMeal` | 家庭成员 | 仅 `confirmed` 可完成；条件更新保证只成功一次；固化快照；发基础分 |
| `submitRatings` | 家庭成员 | 仅 `completed` 可评价；只能写自己的记录；按固定 `_id` 更新 |
| `getMealReview` | 家庭成员 | 完成状态 + 评价汇总 + 掌勺人成长 + 规则 |
| `getChefGrowth` | 家庭成员 | 本家庭内查自己或他人成长；跨家庭一律拒绝 |

### 防重复实现

| 风险 | 手段 |
| --- | --- |
| 重复标记完成 | `menus` 条件更新 `where({status:'confirmed'})`，只有一次 `updated > 0` |
| 重复发放基础分 | 流水固定 `_id = pt_<menuId>_meal_complete`，先查后插 + 主键冲突视为已处理 |
| 重复发放评分奖励 | 同上，`pt_<menuId>_rating_bonus` 只可能有一条 |
| 修改评分产生多条记录 | 评价记录固定 `_id = rv_<menuId>_<userId>`，只有 update 不 insert |
| 并发提交同一成员评分 | 插入冲突时回退为 update 已有记录 |
| 前端伪造他人评分 | `userId` 只取 `getWXContext().OPENID` 对应的 `users._id` |
| 菜单变更覆盖历史评价 | 评价对象来自 `snapshotItems`，不读当前 `items` |

### 页面

- **菜单详情页**（复用，不新增页面）：
  已确认菜单显示「标记本餐已完成」；已完成显示完成时间与「饭后评价」；
  评价区逐道菜 1—5 星 + 可选评语 + 该菜平均分 / 评分人数 / 他人评语；
  顶部显示本餐掌勺人成长卡（等级、累计积分、升级进度、最近一次积分原因）。
- **我的页**：家庭卡片下方新增厨师等级卡（等级、积分、进度条、距下一级、最近一次加分原因）。
  未担任过掌勺人时显示「初级厨师 0 分」，不阻塞其他功能。
- 不新增底部导航项，不新增独立评价页面。

### 用户需手动操作

1. 云开发控制台创建集合：`meal_reviews`、`chef_points`
   （权限「仅创建者可读写」，所有读写经由云函数）。
2. 按「索引创建清单」建索引 #10、#11。
3. 重新部署 `menu` 云函数（本次只改动了 `menu`，`recommend` 未变）。
4. 历史数据兼容：无需迁移。旧菜单没有 `menuVersion` / `snapshotItems` 时按 1 和当前菜品兜底，
   首次对该菜单执行完成操作会自动补写快照。

### 已知限制

- 评分奖励是「一餐一次」结算，首个人评分后即定档；后续成员补评只更新汇总，
  不再追加奖励。这是刻意的防刷分取舍（见上文规则说明）。
- 掌勺人未指定（`cookId` 为空）的菜单不能标记完成，会提示先去点菜页指定掌勺人，
  系统不会自行选人发分。
- 退群成员的历史评价记录保留，但不再计入有效汇总。
- 本阶段只记录评价数据，未接入 AI 推荐排序；`meal_reviews` 中的
  `recipeId + 名称快照 + 用餐时间 + 掌勺人 + 评分人数 + 平均分` 已可作为后续排序的输入。

## 校验命令

```bash
npm run typecheck          # TypeScript 严格类型检查（无输出即通过）
npm run verify:family      # 家庭系统静态结构 + 云函数行为验证（181 项断言）
npm run verify:ingredient  # 食材库存静态结构 + 云函数行为验证（262 项断言）
npm run verify:nutrition   # 营养计算静态结构 + 云函数行为验证（216 项断言）
npm run verify:recipe      # 基础菜谱库静态结构 + 云函数行为验证（186 项断言）
npm run verify:history     # 历史菜单 / 历史点单静态结构 + 云函数行为验证（112 项断言）
npm run verify:ai          # 统一 AI 服务静态结构 + 云函数行为验证（112 项断言）
npm run verify:cookbook     # 家庭菜谱库静态结构 + 云函数行为验证（91 项断言）
npm run verify:diet         # 过敏原 / 忌口硬过滤静态结构与纯函数验证（94 项断言）
npm run verify:shopping     # 采购清单静态结构 + 云函数行为验证（122 项断言）
npm run verify:meal-plan    # 餐次协作静态结构 + 云函数行为验证（123 项断言）
npm run verify:review       # 饭后评价与掌勺人成长静态结构 + 云函数验证（152 项断言）
npm run verify:voice        # 语音相关静态结构 + 云函数行为验证（35 项断言）
npm run verify:chat         # AI 做饭机器人静态结构 + 云函数行为验证（33 项断言）
npm run verify:recommend-chef      # 掌勺人推荐偏好静态结构 + 云函数验证（99 项断言）
npm run verify:recommend-diversity # 推荐多样性静态结构 + 云函数验证（66 项断言）
```

跑全部套件（任一失败即中断）：

```bash
npx tsc --noEmit -p tsconfig.json && for f in tools/verify-*.js; do node "$f" || exit 1; done
```

`verify:*` 用内存版 `wx-server-sdk`（`tools/mock-cloud.js`）驱动**真实的云函数代码**，不依赖云环境，
可以反复在本地 / CI 执行。`verify:family` 覆盖创建 / 加入 / 成员 / 权限 / 退出 / 移除 /
解散 / 邀请码 / 越权攻击等场景；`verify:ingredient` 覆盖增删改查 / 跨家庭隔离 /
身份伪造 / 别名映射 / 入参校验 / 可写字段白名单 / 集合缺失降级 / 已解散家庭等场景；
`verify:nutrition` 覆盖单位换算 / 计算公式 / 总量与人均 / **AI 传入营养值被丢弃** /
缺失与无法换算降级为 `partial` / 数据库覆盖内置数据 / 基础数据一键写入 / 鉴权 / 入参校验等场景。
`verify:recipe` 覆盖菜谱数据完整性 / 初始化幂等且不覆盖用户自建菜谱 /
列表筛选搜索分页 / 列表不夹带食材与步骤 / 关键词正则元字符按字面量处理 /
禁用菜谱不出现在列表与详情 / 详情「不存在」与「已禁用」同一错误码 /
无写菜谱接口等场景。
`verify:history` 覆盖历史菜单列表 / 时间倒序 / 分页不重复 / pageSize 上限 /
状态与日期范围筛选 / 家庭成员共享 / 跨家庭隔离 / 未登录与缺参被拒 /
新增菜单后旧历史仍在 / 集合缺失降级 / 菜单详情家庭归属强制校验 /
历史点单列表与详情 / 已关闭订单只读且幂等 / 汇总来自服务端（含昵称）/
不暴露 openid / 不存在的点单返回 ORDER_NOT_FOUND 等场景。
`verify:ai` 覆盖 5 份 client / ai-service 字节一致 / 内置通道 fail closed /
凭据不泄露 / 额度的原子性并发与北京日切 / 模式路由与默认值 /
客户端传入任何字段都无法覆盖服务端构造的 aiConfig / 用量日志持久化与脱敏等场景。
`verify:cookbook` 覆盖 family_cookbook 与 cookbook_versions 数据模型 /
缓存命中 / 版本递增 / 编辑覆盖当前版本 / 重试产生新版本 / 列表分页 /
跨家庭权限隔离 / 集合缺失降级等场景。
`verify:diet`（Phase E2）覆盖两份 diet-filter 字节一致 / 关键词映射全覆盖 /
前缀剥离 / 规则生成 / 菜名+食材两层匹配 / kept/blocked 分组 / 空偏好降级 /
内置菜谱实际命中验证等场景。
`verify:shopping`（Phase E1/E3）覆盖 shopping_lists 数据模型 /
shopping-core 纯函数（用量缩放/库存扣减/分类/KG 换算/勾选迁移）/
生成/读取/勾选/刷新保留勾选 / 权限隔离与跨家庭防泄露 /
集合缺失降级 / 入参校验 / 响应信封等场景。
`verify:meal-plan`（Phase 1）覆盖 meal-plan-core 纯函数（北京日切 / 入参规范化 /
偏好去重与退群成员过滤 / 方案转菜单快照）/ 看板读取 / 偏好权限与归属校验 /
掌勺人交接 / 确认生成最终菜单 / 旧菜单 cookId 兼容 / 已确认方案复用与替换 /
集合缺失降级等场景。
`verify:review`（阶段二）覆盖 chef-core 纯函数（1—5 星边界 / 不默认补分 /
同菜去重 / 快照固化 / 平均分与人数 / 无评分不除零 / 积分奖励与等级门槛）/
标记本餐完成（未确认拒绝、越权拒绝、跨家庭拒绝、重复完成不重复加分、
掌勺人未指定时拒绝、完成后禁止改菜）/ 逐道菜评分（未完成拒绝、越权拒绝、
伪造 userId 无效、不属于本餐的菜拒绝、修改更新原记录、未评分不参与平均）/
积分归属与防重复结算 / 家庭隔离 / 集合缺失降级 / 阶段一回归等场景。
加 `-- --quiet` 可只看小节标题、失败项与总计。

云函数改完后建议额外做一次纯语法检查：

```bash
node --check cloudfunctions/family/index.js
node --check cloudfunctions/ingredient/index.js
node --check cloudfunctions/nutrition/index.js
node --check cloudfunctions/nutrition/nutrition-core.js
node --check cloudfunctions/nutrition/nutrition-data.js
node --check cloudfunctions/recipe/index.js
node --check cloudfunctions/recipe/recipe-data.js
node --check cloudfunctions/recipe/seed-recipes.js
node --check cloudfunctions/ai-config/ai-service.js
node --check cloudfunctions/menu/ai-service.js
node --check cloudfunctions/recipe/ai-service.js
node --check cloudfunctions/recommend/ai-service.js
node --check cloudfunctions/recipe/seed-recipes.js
node --check cloudfunctions/menu/index.js
node --check cloudfunctions/menu/meal-plan-core.js
node --check cloudfunctions/menu/chef-core.js
node --check cloudfunctions/order/index.js
```

## 第一阶段闭环（后续阶段逐步实现）

```
微信登录 → 创建/加入家庭 → 添加食材 → 今天吃什么 → AI 推荐 3 套菜单
→ 换一换 / 锁定 → 发起家庭点菜 → 家人选择 → 管理员汇总 → 截止
→ 确认菜单 → 生成做法 → 查看做法
```

Phase 1 之后各阶段：登录 → **家庭（已完成）** → **食材（已完成）** → **营养（已完成）** →
**菜谱（已完成）** → 推荐 UI → recommend 云函数 →
AI Schema → 换菜/锁定 → 点菜 → 菜单确认 → AI 做法 → 历史 → 异常/权限 → 分享 → 完整测试。
