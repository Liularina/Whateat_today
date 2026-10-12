# 《今天吃什么》下一阶段开发 · 阶段 0 盘点报告

> 生成日期：2026-10-12  
> 基于：`master` 当前 HEAD (4fb7f67 1.0Release + 未提交的 AI 超时优化)

---

## 1. 页面与路由

### app.json 注册的 17 个页面

| 路径 | 说明 | 入口 |
|---|---|---|
| `pages/home/index` | 首页 | TabBar |
| `pages/ingredients/index` | 食材库存 | TabBar |
| `pages/order/index` | 家庭点单列表 | TabBar（标注「点菜」） |
| `pages/menu/index` | 菜单（今日 / 历史） | TabBar |
| `pages/mine/index` | 我的 | TabBar |
| `pages/ai-settings/index` | AI 模型 API 设置 | mine 页入口 |
| `pages/family/index` | 我的家庭 | mine 页入口 |
| `pages/family/create` | 创建家庭 | family 页 |
| `pages/family/join` | 加入家庭 | family 页 |
| `pages/family/settings` | 家庭设置 | family 页 |
| `pages/nutrition/index` | 营养估算 | home 页入口 |
| `pages/recommend/index` | 发起推荐（条件选择） | home 页入口 |
| `pages/recommend-result/index` | 推荐结果 / 保存菜单 | recommend 页 |
| `pages/order-detail/index` | 点单详情 | order 页 |
| `pages/menu-detail/index` | 菜单详情（从历史进入） | menu 历史列表 |
| `pages/recipes/index` | 菜谱库浏览 | home 页入口 |
| `pages/recipes/detail` | 菜谱详情 + AI 做法 | recipes 列表 |

### 页面组织方式

- 仅 `home`、`ingredients`、`menu`、`nutrition`、`order`、`order-detail`、`menu-detail`、`mine`、`ai-settings`、`recommend`、`recommend-result`、`recipes/index` 采用 `目录/index.*` 方式
- `family/create`、`family/join`、`family/settings`、`recipes/detail` 采用**单文件**方式（无子目录）
- `family/index` 是目录格式

### 公共组件（8 个）

| 组件 | 位置 | 用途 |
|---|---|---|
| `empty-state` | `/components/empty-state/index` | 空状态占位 |
| `error-state` | `/components/error-state/index` | 错误提示 |
| `loading-state` | `/components/loading-state/index` | 加载中 |
| `ingredient-item` | `/components/ingredient-item/index` | 食材条目 |
| `menu-card` | `/components/menu-card/index` | 菜单卡片 |
| `nutrition-card` | `/components/nutrition-card/index` | 营养卡片 |
| `order-item` | `/components/order-item/index` | 订单条目 |
| `recipe-card` | `/components/recipe-card/index` | 菜谱卡片 |

---

## 2. 云函数

### 实际部署的 9 个云函数

| 函数 | 入口文件 | 核心 action | AI 调用 |
|---|---|---|---|
| **auth** | `index.js` | login, getCurrentUser, updateProfile | 不调用 AI |
| **family** | `index.js` | createFamily, joinFamily, leaveFamily, getMyFamily, dissolveFamily, updateFamily, removeMember | 不调用 AI |
| **ingredient** | `index.js` | listIngredients, createIngredient, updateIngredient, deleteIngredient | 不调用 AI |
| **nutrition** | `index.js` + `nutrition-core.js` + `nutrition-data.js` | calculateNutrition, seedNutritionFacts, ping | 不调用 AI |
| **recipe** | `index.js` | listRecipes, getRecipe, **generateCookingSteps**, seedRecipes, generateRecipe(stub), retryRecipe(stub), getRecipeDetail(stub) | **是**（generateCookingSteps） |
| **recommend** | `index.js` + `openai-compatible-client.js` | recommendMenus, ping | **是** |
| **menu** | `index.js` + `openai-compatible-client.js` | saveMenu, getMenu, setMenuItemLocked, replaceMenuItem, regenerateUnlockedItems, confirmMenu, getTodayMenu, getMenuHistory | **是**（换菜 / 重推） |
| **order** | `index.js` | createOrder, getOrder, submitOrderItems, getOrderSummary, closeOrder, listOrders | 不调用 AI |
| **ai-config** | `index.js` + `openai-compatible-client.js` | getAiConfig, saveAiConfig, deleteAiConfig, testAiConfig | **是**（测试连通性） |

### NOT_IMPLEMENTED 桩

`cloudfunctions/recipe/index.js` 中有三个桩需要在本轮实现：

- `generateRecipe()` — 按菜单生成做法
- `retryRecipe()` — 重新生成做法
- `getRecipeDetail()` — 查询做法（按 menuId+recipeId）

---

## 3. 数据库集合

### 现有集合与核心字段

| 集合 | 核心字段 | 职责 |
|---|---|---|
| **users** | `_id, openid, nickname, avatarUrl, createdAt, updatedAt` | 用户身份（openid 仅供服务端） |
| **families** | `_id, name, ownerId, inviteCode, preferences, status, createdAt, updatedAt` | 家庭信息 |
| **family_members** | `_id, familyId, userId, role, joinedAt, createdAt` | 家庭-用户关联 |
| **ingredients** | `_id, familyId, name, standardName, quantity, unit, category, expireDate, remark, createdBy, createdAt, updatedAt` | 食材库存 |
| **ingredient_aliases** | `_id, alias, standardName` | 别名映射（可选集合） |
| **recipes** | `_id, name, description, category, tags, difficulty, cookTime, servings, ingredients[], steps[], source, isActive, createdAt, updatedAt` | 菜谱模板库（内置+buildin） |
| **menus** | `_id, familyId, userId, mealType, servings, items[], status, createdAt, updatedAt` | 菜单（draft/confirmed/completed） |
| **family_orders** | `_id, familyId, menuId, menuName, title, status, deadline, note, initiatorUserId, recipeIds[], createdAt, updatedAt, closedAt, finalSummary, totalParticipants` | 家庭点单 |
| **family_order_items** | `_id, orderId, familyId, userId, items[], createdAt, updatedAt` | 点单明细 |
| **nutrition_facts** | `_id, standardName, per100g, edibleRate, averageWeight, source` | 营养基础数据 |
| **generated_recipes** | `recipeId, userId, data, createdAt` | AI 生成的做法（按 userId+recipeId 索引，**不是**按 familyId） |
| **user_ai_configs** | 用户的 OpenAI API 配置（加密存储） | 用户自配 API |
| **ai_logs** | AI 调用日志（敏感信息脱敏） | 调用追踪 |

### MenuItem 结构（menus.items[] 子文档）

```ts
{
  recipeId, name, description, category, tags[], ingredients[], 
  cookTime, difficulty, servings, 
  nutrition?: { calories, protein, fat, carbohydrate },  // ← 已有营养字段
  locked, position, source
}
```

**关键发现**：`MenuItem.nutrition` 字段已定义，但 `confirmMenu` handler **未在确认时写入营养快照**——确认时仅设置 `status: 'confirmed'`，没有调用 nutrition 云函数重新计算各菜的 nutrition 值。

---

## 4. AI 服务现状

### 调用链

```
小程序前端 → services/*.ts → callFunction → 云函数 → openai-compatible-client.js → 用户自配 API
```

### 当前工作流程

| 功能 | 云函数 | 使用的 AI 能力 |
|---|---|---|
| 推荐菜单 | recommend.recommendMenus | chatCompletion：从候选菜谱中选出 3 套菜单 |
| 换菜 | menu.replaceMenuItem | chatCompletion：在已有菜单中替换一道菜 |
| 重新生成 | menu.regenerateUnlockedItems | chatCompletion：重新生成未锁定菜品 |
| 生成做法 | recipe.generateCookingSteps | chatCompletion：生成详细烹饪步骤 JSON |
| 连接测试 | ai-config.testAiConfig | chatCompletion：用 5 token 测试连通性 |

### 「内置 AI」当前状态

**完全不存在。** 项目没有任何服务端模型供应商凭据、调用通道或额度管理。所有 AI 能力依赖用户在「AI 设置」页面自行配置 OpenAI 兼容 API（Base URL + Model + API Key）。

已具备的基础设施：
- `openai-compatible-client.js`（4 份，SHA256 完全一致）
- API Key AES-256-GCM 加密存储
- `enable_thinking: false` + 400 自动回退
- 超时 50s、重试、错误分类、日志脱敏
- `user_ai_configs` 集合可存储用户配置

### 已有的 400 回退 + 空响应判定

最近一轮已在 4 份 client 中统一了以下增强：

```js
// 关闭思考模式
body.chat_template_kwargs = { enable_thinking: false };

// 400 回退（服务商不支持时自动去掉字段）
if (e && e.statusCode === 400 && body.chat_template_kwargs) {
  // 去字段重试
}

// 空正文明确报错（原判断 !content && content !== '' 恒 false）
if (!content) throw { code: 'AI_EMPTY_RESPONSE' };
```

---

## 5. 历史记录现状

### 已实现

- `menu.getMenuHistory`：按 familyId + 状态 + 日期范围分页查询 menus 集合
- `menu.getTodayMenu`：取最近一条 confirmed 菜单
- `pages/menu/index.ts`：双 Tab（今日 / 历史），分页滚动加载
- `MenuListItem` 类型：含 menuId、mealType、servings、dishCount、dishNames[]
- `pages/menu-detail/index.ts`：从历史列表点击进入，查看完整菜单内容

### 缺失

- **无日历视图**：历史列表仅为分页列表，无日/周/月视图
- **无营养统计**：历史菜单列表项不含热量数据，详情页也不展示营养
- **无历史快照**：确认菜单时未保存当时的份量、热量和菜谱版本快照；历史记录的 items 是当前 menus 集合的最新数据（如果菜谱被修改，历史展示也会变）
- **无六个月清理**：没有任何清理逻辑
- **无定时触发器**：项目中没有云函数定时触发器
- **无 `completed` 状态的实际使用**：menus 只用到 draft 和 confirmed

---

## 6. 营养数据现状

### 已实现

- `nutrition` 云函数：根据 `nutrition_facts` 集合计算任意食材组合的热量/蛋白/脂肪/碳水
- 支持部分数据（partial）、缺少数据（missing）、不可换算（unconvertible）三种状态
- 内置基础营养数据（`nutrition-data.js`），集合缺失时自动降级
- `nutritionService.calculate()` 统一封装
- `MenuItem.nutrition` 字段类型定义
- `formatKcal()` / `formatGram()` 统一展示格式
- 统一免责声明 `KCAL_PREFIX = '约'`、`NUTRITION_DISCLAIMER`
- 烹饪用油系数（`nutrition-core.js` 中 `OIL_RATIO = 0.05`）

### 缺失

- 菜单确认时不保存营养快照
- 历史菜单不展示热量统计
- 食谱热量只在生成做法时由 AI 估算（`GeneratedCookingData` 的 AI 输出），**没有**在保存时调用 nutrition 云函数做程序重算

---

## 7. 食材分类现状

### 已有分类

| 代码 | 标签 | 任务书要求 |
|---|---|---|
| `vegetable` | 蔬菜 🥬 | 蔬菜 ✅ |
| `fruit` | 水果 🍎 | 水果 ✅ |
| `meat_egg` | 肉蛋 🥩 | 肉类（需拆分） + 蛋奶（需拆出 dairy） |
| `seafood` | 水产 🐟 | 水产 ✅ |
| `dairy` | 乳制品 🥛 | 蛋奶及豆制品（需与 soy_product 合并？） |
| `soy_product` | 豆制品 🫘 | 同上 |
| `staple` | 主食 🍚 | 粮油调料（需拆出 seasoning） |
| `seasoning` | 调味 🧂 | 同上 |
| `other` | 其他 🧺 | 其他 ✅ |

**差异分析**：
- 任务书要求 `肉类` 独立于 `蛋奶及豆制品`，当前 `meat_egg` 合在一起
- 任务书要求 `粮油调料` 合并，当前 `staple` 和 `seasoning` 分开
- `dairy` 和 `soy_product` 任务书要求合并为 `蛋奶及豆制品`
- 分类调整会影响已有食材数据的 category 字段——这是一个**数据迁移**问题

### 已有保质期字段

- `Ingredient.expireDate: string | null`（格式 YYYY-MM-DD）
- 只有静态值，**无**从购买日期+保质期自动计算的能力
- 食材列表页展示 expireDate 但无排序、无临期标识

---

## 8. 权限校验现状

### 已实现统一模式

所有云函数共用同一套校验模式：

```js
async function requireFamilyMember(openid, familyId) {
  const user = await findUserByOpenid(openid);       // ① openid → user
  if (!user) return { error: 'UNAUTHORIZED' };
  
  const member = await db.collection('family_members')
    .where({ familyId, userId: user._id })           // ② 校验家庭归属
    .limit(1).get();
  if (!member) return { error: 'NOT_IN_FAMILY' };
  
  return { user, member };
}
```

- 身份只来自 `cloud.getWXContext().OPENID`
- 前端传入的 familyId 只作为「意图」，服务端用 openid 二次校验
- 食材、菜单、订单、推荐等全部经此校验

### 已实现家庭偏好

`FamilyPreferences` 含：
- `defaultPeopleCount`
- `taste[]` — 口味
- `avoidIngredients[]` — 明确忌口
- `allergens[]` — 过敏原（类型定义已支持硬性过滤）
- `defaultCookTime`

当前仅推荐时把 `preferences` 作为文本传给 AI 提示词，**未实现**硬性过敏原过滤。

---

## 9. 家庭菜谱库现状

### 已有

| 组件 | 说明 |
|---|---|
| `recipes` 集合 | 菜谱模板库，`source: 'builtin'`，所有家庭只读共用 |
| `generated_recipes` 集合 | AI 做法缓存，`{ recipeId, userId, data, createdAt }` |
| `generateCookingSteps` | 先查 `generated_recipes`，有缓存则返回 `source: 'cached'` |
| `pages/recipes/detail.ts` | 菜谱详情页，调用 `recipeService.generateCookingSteps()` |
| `RecipeDetail` 类型 | `{ _id, menuId, recipeId, name, preparation[], ingredients[], steps[], tips[], substitutions[], ... }` |

### 关键问题

1. **`generated_recipes` 按 userId 索引，不是 familyId**  
   同一家庭的不同成员打开同一道菜，会各自生成一份——缓存无法在家庭内共享。

2. **匹配键只有 recipeId，无份量/家庭/版本**  
   同名菜不同份量、同一菜谱不同家庭的编辑版本会冲突。

3. **`data` 字段是自由 JSON，无版本管理**  
   没有 version 字段、没有 status 字段、没有 edited 标记。

4. **`RecipeDetail` 类型是为「菜单做法」设计的（按 menuId+recipeId）**  
   与「家庭菜谱库」的职责不同：一个是菜单临时做法，一个是可复用菜谱。

5. **三个 NOT_IMPLEMENTED 桩**  
   `generateRecipe(menuId)` / `retryRecipe(key)` / `getRecipeDetail(key)` 是菜单做法（Phase 7/8 遗留），不是家庭菜谱库。

### 与任务书 D 阶段的差距

任务书要求的「家庭菜谱库」核心特点：
- 按家庭共享（familyId），不是 userId
- 稳定菜谱 ID + 版本号
- 做法版本可追溯、可编辑
- 缓存命中不调 AI
- 不受历史清理影响

当前 `generated_recipes` 设计仅满足「AI 做法缓存」的基础需求，**不能**直接升级为家庭菜谱库——需要重新设计数据模型。

---

## 10. 测试覆盖

### 5 个验证套件（803 项，0 失败）

| 套件 | 测试数 | 覆盖范围 |
|---|---|---|
| `verify-family.js` | 181 | 家庭创建、加入、退出、权限、邀请码 |
| `verify-ingredient.js` | 155 | 食材增删改查、分类校验、权限 |
| `verify-nutrition.js` | 212 | 营养计算、部分数据、换算、内置数据 |
| `verify-recipes.js` | 170 | 菜谱列表、详情、分类、AI 做法生成 |
| `verify-history.js` | 85 | 历史菜单查询、分页、状态筛选 |

### `npm run typecheck` ✓

### 未覆盖的流程

- 日历视图（不存在）
- 食材保质期排序与临期提醒（不存在）
- 内置 AI 调用（不存在）
- 家庭菜谱库的并发与缓存命中（不存在）
- 采购清单（不存在）
- 历史数据清理（不存在）
- AI 服务模式切换（不存在）
- 真机 / 云环境端到端流程

---

## 11. 与任务书各阶段的差距汇总

### 阶段 A（历史菜单日历与营养统计）

| 需求 | 现有状态 | 差距 |
|---|---|---|
| 日历日/周/月视图 | 仅分页列表 | **需新建**，作为菜单 Tab 的第三个视图 |
| 每道菜热量展示 | `MenuItem.nutrition` 字段存在但**未写入** | 确认菜单时需调用 nutrition 云函数写入快照 |
| 历史营养统计 | 列表项无热量字段 | 需扩展 `MenuListItem` + 计算合计 |
| 历史快照 | 确认时仅改 status，不做快照 | 确认时保存当前的份量、热量、不可变性标记 |
| 6 个月自动清理 | 无任何清理逻辑 | 需新增清理云函数 + 预演模式 |

### 阶段 B（食材分类与保质期）— 已完成

| 需求 | 现有状态 | 差距 |
|---|---|---|
| 分类折叠 | 已实现：列表按 `INGREDIENT_CATEGORIES` 分组，组头可折叠并保持状态 | 无 |
| 临期排序与标识 | 已实现：组内「过期 → 临期 → 新鲜 → 无到期日」排序，≤3 天标 ⏰、已过期标 ⚠ | 无 |
| 自动计算到期日 | 已实现：新增 `purchaseDate` + `shelfLifeDays`，到期日 = 显式 `expireDate` > 购买日 + 保质天数 > 空 | 无 |
| 快捷操作 | 已实现：食材项提供「已用完 / 补货 / 做法」，「做法」跳转菜谱页并预填关键词 | 无 |
| 过期排除 | 已实现：`cloudfunctions/recommend/shelf-filter.js` 在构建库存名单前过滤已过期食材 | 无 |

实现要点：

- 到期日推导只在服务端做一次并落库，服务端独立校验（不信任前端）；
- 日期一律按 UTC 天数序号计算，避免 `new Date('YYYY-MM-DD')` 的时区偏移；
- 临期阈值常量 `SHELF_LIFE_WARNING_DAYS = 3`，今天到期算临期，严格早于今天算过期；
- 过期过滤按「北京时间当天」比较，未填到期日的食材不算过期。

验证：`npm run verify:ingredient`（含前端纯函数编译后行为测试）。

### 阶段 C（统一 AI 服务）

| 需求 | 现有状态 | 差距 |
|---|---|---|
| 内置 AI | 完全不存在 | **需从头建设**：供应商凭据、服务端通道、额度、日志 |
| 自定义 API | 已完成 | 保留即可 |
| 模式切换 | 不存在 | 需新增模式选择 UI + 服务端路由 |
| 统一入口 | 各云函数独立调用 client | 架构已统一，mode 切换只需在服务层添加路由 |

### 阶段 D（家庭菜谱库）

| 需求 | 现有状态 | 差距 |
|---|---|---|
| 家庭共享菜谱 | `generated_recipes` 按 userId | **需重设计**为 family-level |
| 做法版本管理 | 无 version/status/edited | **需新增**版本字段 |
| 缓存命中 | 仅 userId+recipeId 简单匹配 | **需扩展**匹配规则（familyId + 份量 + 版本） |
| 用户编辑 | 不支持 | **需新增**编辑 + 保存 + 版本保留 |
| 并发控制 | 无 | **需新增**分布式锁或乐观锁 |
| 历史数据保护 | 无关联 | 需确保清理时不级联删除 |

### 阶段 E（采购闭环）

| 需求 | 现有状态 | 差距 |
|---|---|---|
| 自动采购清单 | 无 | **需新建**页面 + 云函数 |
| 家庭成员口味 | 家庭级偏好已存在 | 需扩展到成员级 |
| 过敏原硬过滤 | 仅提示词文本 | **需实现**程序硬过滤 |
| 换菜 | 已有 replaceMenuItem | 可直接复用 |

---

## 12. 最小改动方案

### 不需要创建的
- ✗ 不需要新建历史页面（已有 `pages/menu/index.ts` 双 Tab）
- ✗ 不需要新建食材页面（已有 `pages/ingredients/index.ts`）
- ✗ 不需要新建 AI 客户端（已有 4 份统一的 `openai-compatible-client.js`）
- ✗ 不需要新建营养计算（已有完整的 `nutrition` 云函数）
- ✗ 不需要新建家庭系统（已有完整实现）
- ✗ 不需要新建菜谱详情页（已有 `pages/recipes/detail.ts`）
- ✗ 不需要新建菜谱浏览页（已有 `pages/recipes/index.ts`）

### 需要新建的
| 新增 | 说明 |
|---|---|
| 清理云函数 `cleanup` 或扩展现有函数 | 历史菜单 6 个月清理 |
| 内置 AI 服务端通道 | 取决于产品提供的供应商凭据和调用方式 |
| `generated_recipes` 集合 → 家庭菜谱库集合 | 重设计数据模型 |
| 采购清单页面 | `pages/shopping/index` |
| 采购云函数 | `shopping` 或扩展 `order` |

### 需要扩展的
| 扩展 | 文件 / 集合 |
|---|---|
| `pages/menu/index.ts` 新增日历 Tab | 菜单页面 |
| `menu` 云函数 `confirmMenu` 写营养快照 | `cloudfunctions/menu/index.js` |
| `MenuListItem` 类型补充 nutrition 字段 | `miniprogram/types/menu.ts` |
| `menu.getMenuHistory` 返回带热量的数据 | `cloudfunctions/menu/index.js` |
| `Ingredient` 类型新增 `purchaseDate`、`shelfLifeDays` | `miniprogram/types/ingredient.ts` |
| `ingredient` 云函数字段白名单扩展 | `cloudfunctions/ingredient/index.js` |
| `pages/ingredients/index.ts` 分类折叠+临期排序 | 食材页面 |
| `recommend` 云函数排除过期食材 | `cloudfunctions/recommend/index.js` |
| `openai-compatible-client.js` → AI 模式路由 | 4 份 client + `ai-config` 云函数 |
| `user_ai_configs` 集合新增 mode 字段 | 用户配置 |
| `pages/ai-settings/index.ts` 新增模式选择 | AI 设置页 |
| `generated_recipes` → family_cookbook + cookbook_versions | 新集合设计 |

---

## 13. 风险与阻塞项

| 风险 | 严重程度 | 说明 |
|---|---|---|
| **内置 AI 无供应商凭据** | 🔴 阻塞 C | 任务书要求「开箱即用」，但项目无任何服务端模型通道。需产品提供 API 供应商、凭据和部署方式 |
| **分类调整涉及数据迁移** | 🟡 中 | `meat_egg` → `meat` + `egg_dairy_soy` 拆分后，历史食材数据的 category 需要迁移脚本 |
| **`generated_recipes` 数据结构需重建** | 🟡 中 | 当前 userId 索引不能直接升级为 family-level 菜谱库，需新建集合 + 迁移 |
| **云函数 60 秒限制** | 🟡 中 | 确认菜单时如需计算营养+生成做法快照，需拆分为异步或分批处理 |
| **无定时触发器基础设施** | 🟡 中 | 6 个月自动清理需要定时触发器，微信云开发的定时触发器功能需确认可用 |
| **过敏原硬过滤需要 ingredient 到 allergen 的标准名映射** | 🟢 低 | availability 取决于 ingredient_aliases 的覆盖率 |
| **真机测试环境** | 🔴 阻塞验收 | 所有验收清单中的真机测试项需在有可用真机时执行 |

---

## 14. 推荐实施顺序

```
阶段 A（历史菜单 + 营养统计）
  └─ A1. 确认时写营养快照（最小改动，补上已有字段的实际写入）
  └─ A2. 历史菜单列表 + 日历 Tab 视图
  └─ A3. 热量统计展示
  └─ A4. 清理云函数（先预演，后启用）

阶段 B（食材保质期）
  └─ B1. 分类折叠 UI + purchaseDate/shelfLifeDays 字段
  └─ B2. 临期排序 + 到期提醒
  └─ B3. 过期排除 in 推荐

阶段 C（统一 AI 服务）
  └─ C1. 内置 AI 服务端通道（需产品提供凭据）
  └─ C2. 模式选择 UI + 路由
  └─ C3. 统一入口与错误处理

阶段 D（家庭菜谱库）
  └─ D1. 新数据模型（family_cookbook + cookbook_versions）
  └─ D2. 生成 + 缓存 + 版本管理
  └─ D3. 编辑 + 重新生成 + 并发保护
  └─ D4. 跨入口复用

阶段 E（采购闭环）
  └─ E1. 采购清单
  └─ E2. 口味与忌口增强
  └─ E3. 体验优化
```

---

> **下一步**：请确认以上盘点是否准确，以及是否现在进入阶段 A。如需调整实施顺序或范围，也请提出。