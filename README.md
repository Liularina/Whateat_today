# 今天吃什么 · 微信小程序

帮一个家庭完成「录入库存 → 推荐菜单 → 家人点菜 → 确认菜单 → 生成做法」的完整闭环。

> 当前进度：**Phase 5：营养计算**。
> 微信登录（Phase 2）、家庭体系（Phase 3）、食材库存增删改查（Phase 4）、
> 营养估算（Phase 5）已可用；AI 推荐、点菜、菜单、做法仍为骨架，按后续阶段推进。

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
├── pages/                   # 15 个页面（含 4 个家庭页 + 营养估算页）
├── components/              # 8 个公共组件
├── services/                # 统一封装云函数调用
├── types/                   # 实体 TypeScript 类型
├── utils/                   # cloud / storage / formatter / validator / family-form
├── constants/               # config / categories / units
└── typings/                 # IAppOption 等全局声明
cloudfunctions/
├── auth/ family/ ingredient/
├── nutrition/               # index.js + nutrition-core.js（纯函数）+ nutrition-data.js（基础数据）
└── recommend/ order/ menu/ recipe/
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

云开发控制台需要手动创建以下集合（权限建议：**仅创建者可读写**，所有读写经由云函数）：

`users`、`families`、`family_members`、`ingredients`、`recipes`、`menus`、
`family_orders`、`family_order_items`、`nutrition_facts`、`ingredient_aliases`、`ai_logs`

> Phase 2 / Phase 3 实际使用：`users`、`families`、`family_members`。
> Phase 4 额外使用：`ingredients`（**必需**，缺集合时接口返回 `DB_NOT_READY`）、
> `ingredient_aliases`（**可选**，缺集合时自动退回内置别名表）。
> Phase 5 额外使用：`nutrition_facts`（**可选**，缺集合时自动退回内置基础数据；
> 但 `seedNutritionFacts` 写入需要该集合存在）。

建议索引（避免家庭查询全表扫描）：

| 集合 | 索引字段 |
| --- | --- |
| `family_members` | `familyId`、`userId` |
| `ingredients` | `familyId` |
| `menus` | `familyId` |
| `family_orders` | `familyId` |
| `family_order_items` | `orderId` |
| `nutrition_facts` | `standardName` |

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

- **页面**：`pages/ingredients/index`（TabBar「食材」）。列表 + 底部弹层新增 / 编辑，删除有二次确认。
- **字段**：名称、数量、单位、分类、保质期（可选）、备注（可选）。
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
- 本阶段**不做**：拍照识别、OCR、语音输入、临期算法、自动扣库存、复杂单位、库存统计。

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

## 校验命令

```bash
npm run typecheck          # TypeScript 严格类型检查（无输出即通过）
npm run verify:family      # 家庭系统静态结构 + 云函数行为验证（181 项断言）
npm run verify:ingredient  # 食材库存静态结构 + 云函数行为验证（155 项断言）
npm run verify:nutrition   # 营养计算静态结构 + 云函数行为验证（212 项断言）
```

`verify:*` 用内存版 `wx-server-sdk`（`tools/mock-cloud.js`）驱动**真实的云函数代码**，不依赖云环境，
可以反复在本地 / CI 执行。`verify:family` 覆盖创建 / 加入 / 成员 / 权限 / 退出 / 移除 /
解散 / 邀请码 / 越权攻击等场景；`verify:ingredient` 覆盖增删改查 / 跨家庭隔离 /
身份伪造 / 别名映射 / 入参校验 / 可写字段白名单 / 集合缺失降级 / 已解散家庭等场景；
`verify:nutrition` 覆盖单位换算 / 计算公式 / 总量与人均 / **AI 传入营养值被丢弃** /
缺失与无法换算降级为 `partial` / 数据库覆盖内置数据 / 基础数据一键写入 / 鉴权 / 入参校验等场景。
加 `-- --quiet` 可只看小节标题、失败项与总计。

云函数改完后建议额外做一次纯语法检查：

```bash
node --check cloudfunctions/family/index.js
node --check cloudfunctions/ingredient/index.js
node --check cloudfunctions/nutrition/index.js
node --check cloudfunctions/nutrition/nutrition-core.js
node --check cloudfunctions/nutrition/nutrition-data.js
```

## 第一阶段闭环（后续阶段逐步实现）

```
微信登录 → 创建/加入家庭 → 添加食材 → 今天吃什么 → AI 推荐 3 套菜单
→ 换一换 / 锁定 → 发起家庭点菜 → 家人选择 → 管理员汇总 → 截止
→ 确认菜单 → 生成做法 → 查看做法
```

Phase 1 之后各阶段：登录 → **家庭（已完成）** → **食材（已完成）** → **营养（已完成）** → 推荐 UI → recommend 云函数 →
AI Schema → 换菜/锁定 → 点菜 → 菜单确认 → AI 做法 → 历史 → 异常/权限 → 分享 → 完整测试。
