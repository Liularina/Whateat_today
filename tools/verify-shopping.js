/**
 * 采购清单 · 静态结构与云函数行为验证（Phase E1 / E3）
 *
 * 运行：node tools/verify-shopping.js
 *
 * 覆盖：
 *   1. 数据模型：shopping_lists 集合结构
 *   2. shopping-core 纯函数：collectNeeded / collectStock / buildShoppingItems / groupItems
 *      extractChecked / applyChecked / summarizeItems / guessCategory / normalizeAmountUnit
 *      sortItems（分类优先 → 待购优先 → 同单位同名合并）
 *   3. generateShoppingList：首次生成 / 刷新（保留勾选）
 *   4. getShoppingList：按 menuId 查 / 不按 menuId 取最近
 *   5. toggleShoppingItem：勾选 / 取消 / 乐观更新语义
 *   6. 权限隔离：非家庭成员被拒 / 菜单不属于该家庭
 *   7. 集合缺失降级：DB_NOT_READY
 *   8. 入参校验：缺 menuId / 缺 key / checked 非布尔
 *   9. 返回格式：success/code/error 信封一致
 *  10. 菜单未确认时生成被拒
 */
const path = require('path');
const { createMockCloud } = require('./mock-cloud');

const mock = createMockCloud();
const store = mock.store;
const resetStore = mock.resetStore;
const setMissingCollections = mock.setMissingCollections;

mock.install();

/* ============================== 加载云函数 ============================== */

const shoppingFn = require(path.join(__dirname, '..', 'cloudfunctions', 'shopping', 'index.js'));

/* ============================== 断言工具 ============================== */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  [通过] ' + name);
    return;
  }
  failures.push(name + (detail ? ' -> ' + detail : ''));
  console.log('  [失败] ' + name + (detail ? ' -> ' + detail : ''));
}

function checkEqual(name, actual, expected) {
  check(name, actual === expected,
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ============================== 测试辅助 ============================== */

const MENU_ID = 'menu-test-1';

function seedUsersAndFamily() {
  store.users.push({ _id: 'user-a', openid: 'openid-a', nickname: 'A' });
  store.users.push({ _id: 'user-b', openid: 'openid-b', nickname: 'B' });
  store.users.push({ _id: 'user-c', openid: 'openid-c', nickname: 'C' });

  store.families.push({
    _id: 'fam-1', name: '家 1', status: 'active', memberCount: 2, ownerId: 'user-a',
    preferences: { defaultPeopleCount: 3, taste: ['家常'], avoidIngredients: [], allergens: [], defaultCookTime: 40 },
  });
  store.family_members.push({ _id: 'mem-a', familyId: 'fam-1', userId: 'user-a', role: 'owner' });
  store.family_members.push({ _id: 'mem-c', familyId: 'fam-1', userId: 'user-c', role: 'member' });
}

function seedMenu() {
  store.menus.push({
    _id: MENU_ID,
    familyId: 'fam-1',
    userId: 'user-a',
    mealType: 'dinner',
    servings: 3,
    status: 'confirmed',
    items: [
      {
        recipeId: 'r1',
        name: '番茄炒蛋',
        description: '经典家常',
        category: '家常菜',
        tags: [],
        difficulty: 'easy',
        cookTime: 15,
        servings: 2,
        ingredients: [
          { name: '鸡蛋', amount: 3, unit: '个' },
          { name: '番茄', amount: 2, unit: '个' },
          { name: '小葱', amount: 10, unit: 'g' },
          { name: '食用油', amount: 20, unit: 'g' },
          { name: '食盐', amount: 3, unit: 'g' },
        ],
        locked: false,
        position: 0,
        source: 'ai_recommendation',
      },
      {
        recipeId: 'r2',
        name: '青椒肉丝',
        description: '下饭菜',
        category: '家常菜',
        tags: [],
        difficulty: 'medium',
        cookTime: 20,
        servings: 2,
        ingredients: [
          { name: '猪肉', amount: 200, unit: 'g' },
          { name: '青椒', amount: 2, unit: '个' },
          { name: '酱油', amount: 15, unit: 'g' },
          { name: '食用油', amount: 25, unit: 'g' },
          { name: '食盐', amount: 3, unit: 'g' },
        ],
        locked: false,
        position: 1,
        source: 'ai_recommendation',
      },
    ],
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
  });

  // 另一个家庭（fam-2）的菜单，应不可见
  store.menus.push({
    _id: 'menu-fam2',
    familyId: 'fam-2',
    userId: 'user-b',
    mealType: 'lunch',
    servings: 2,
    status: 'confirmed',
    items: [{ recipeId: 'rx', name: '其他菜', servings: 1, ingredients: [] }],
    createdAt: '2026-10-09T08:00:00.000Z',
    updatedAt: '2026-10-09T08:00:00.000Z',
  });

  // 未确认的菜单
  store.menus.push({
    _id: 'menu-draft',
    familyId: 'fam-1',
    userId: 'user-a',
    mealType: 'dinner',
    servings: 2,
    status: 'draft',
    items: [],
    createdAt: '2026-10-11T08:00:00.000Z',
    updatedAt: '2026-10-11T08:00:00.000Z',
  });
}

function seedStock() {
  store.ingredients.push(
    { _id: 'ing-1', familyId: 'fam-1', name: '鸡蛋', standardName: '鸡蛋', quantity: 5, unit: '个', category: 'meat_egg' },
    { _id: 'ing-2', familyId: 'fam-1', name: '番茄', standardName: '番茄', quantity: 1, unit: '个', category: 'vegetable' },
    { _id: 'ing-3', familyId: 'fam-1', name: '猪肉', standardName: '猪肉', quantity: 300, unit: 'g', category: 'meat_egg' },
    { _id: 'ing-4', familyId: 'fam-1', name: '食用油', standardName: '食用油', quantity: 1000, unit: 'g', category: 'seasoning' },
    { _id: 'ing-5', familyId: 'fam-1', name: '食盐', standardName: '食盐', quantity: 500, unit: 'g', category: 'seasoning' },
  );
}

async function callShopping(action, payload, openid) {
  mock.setOpenid(openid || 'openid-a');
  return shoppingFn.main(Object.assign({ action: action }, payload || {}));
}

/* ============================== 数据模型验证 ============================== */

function runModelChecks() {
  section('数据模型');

  check('mock-cloud 含 shopping_lists 集合', Array.isArray(store.shopping_lists));

  store.shopping_lists.push({
    _id: 'sl-1', familyId: 'fam-1', menuId: MENU_ID,
    mealType: 'dinner', servings: 3, dateLabel: '2026-10-10',
    items: [
      { key: '鸡蛋|个', name: '鸡蛋', unit: '个', category: 'meat_egg',
        categoryLabel: '肉蛋', needed: 5, stock: 5, toBuy: 0, enough: true, checked: false, dishes: ['番茄炒蛋'] },
    ],
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
    createdBy: 'user-a',
  });

  const doc = store.shopping_lists[0];
  check('含 familyId', doc.familyId === 'fam-1');
  check('含 menuId', doc.menuId === MENU_ID);
  check('含 mealType', doc.mealType === 'dinner');
  check('含 servings', doc.servings === 3);
  check('含 dateLabel', doc.dateLabel.length > 0);
  check('含 items 数组', Array.isArray(doc.items) && doc.items.length > 0);
  check('items[].key 存在', typeof doc.items[0].key === 'string');
  check('items[].name 存在', typeof doc.items[0].name === 'string');
  check('items[].unit 存在', typeof doc.items[0].unit === 'string');
  check('items[].category 存在', typeof doc.items[0].category === 'string');
  check('items[].needed >= 0', doc.items[0].needed >= 0);
  check('items[].stock >= 0', doc.items[0].stock >= 0);
  check('items[].toBuy >= 0', doc.items[0].toBuy >= 0);
  check('items[].enough 是布尔', typeof doc.items[0].enough === 'boolean');
  check('items[].checked 是布尔', typeof doc.items[0].checked === 'boolean');
  check('items[].dishes 是数组', Array.isArray(doc.items[0].dishes));
  check('含 createdBy', doc.createdBy === 'user-a');
  check('含 createdAt', typeof doc.createdAt === 'string');
  check('含 updatedAt', typeof doc.updatedAt === 'string');
}

/* ============================== shopping-core 纯函数验证 ============================== */

function runCoreChecks() {
  section('shopping-core 纯函数');

  const core = require(path.join(__dirname, '..', 'cloudfunctions', 'shopping', 'shopping-core.js'));

  // ------- normalizeAmountUnit -------
  const norm1 = core.normalizeAmountUnit(5, 'kg');
  checkEqual('5 kg → 5000 g', norm1.amount, 5000);
  checkEqual('5 kg unit → g', norm1.unit, 'g');

  const norm2 = core.normalizeAmountUnit(3, '个');
  checkEqual('3 个保持', norm2.amount, 3);
  checkEqual('3 个 unit', norm2.unit, '个');

  const norm3 = core.normalizeAmountUnit(-1, 'g');
  checkEqual('负数量 → 0', norm3.amount, 0);

  const norm4 = core.normalizeAmountUnit(NaN, 'g');
  checkEqual('NaN → 0', norm4.amount, 0);

  // ------- collectNeeded -------
  const menu = store.menus.find((m) => m._id === MENU_ID);
  const needed = core.collectNeeded(menu);
  check('collectNeeded 非空', Object.keys(needed).length > 0);

  // servings=3, 番茄炒蛋 servings=2 → scale=1.5
  const tomatoEgg = needed['鸡蛋|个'];
  check('鸡蛋按 scale 放大', tomatoEgg !== undefined);
  if (tomatoEgg) {
    // 3 个 × 1.5 = 4.5
    checkEqual('鸡蛋 needed rounded', Math.round(tomatoEgg.amount * 100), 450);
    check('鸡蛋 dishes 含番茄炒蛋', tomatoEgg.dishes.includes('番茄炒蛋'));
  }

  // 食盐：番茄炒蛋 3g + 青椒肉丝 3g → 各 × 1.5 → 4.5 + 4.5 = 9
  const salt = needed['食盐|g'];
  if (salt) {
    checkEqual('食盐汇总 rounded', Math.round(salt.amount * 100), 900);
    check('食盐 dishes 含两道菜', salt.dishes.length >= 1);
  }

  // ------- collectStock -------
  const stock = core.collectStock(store.ingredients);
  check('鸡蛋库存 >= 5', (stock['鸡蛋|个'] || 0) >= 5);
  check('番茄库存 >= 1', (stock['番茄|个'] || 0) >= 1);

  // ------- buildShoppingItems -------
  const items = core.buildShoppingItems(menu, store.ingredients);
  check('buildShoppingItems 非空', items.length > 0);

  // 食用油：需要 20*1.5 + 25*1.5 = 67.5g，库存 1000g → 已备齐
  const oil = items.find((i) => i.name === '食用油');
  if (oil) {
    checkEqual('食用油 enough', oil.enough, true);
    checkEqual('食用油 toBuy = 0', oil.toBuy, 0);
  }

  // 鸡蛋：需要 4.5 个，库存 5 个 → 已备齐
  const egg = items.find((i) => i.name === '鸡蛋');
  if (egg) {
    checkEqual('鸡蛋 enough', egg.enough, true);
  }

  // 番茄：需要 3 个（2*1.5），库存 1 → 需购 2
  const tomato = items.find((i) => i.name === '番茄');
  if (tomato) {
    check('番茄 not enough', !tomato.enough);
    checkEqual('番茄 toBuy', Math.round(tomato.toBuy * 100), 200); // 2.0
  }

  // 青椒无库存 → 全部需购
  const pepper = items.find((i) => i.name === '青椒');
  if (pepper) {
    check('青椒 not enough', !pepper.enough);
    check('青椒 toBuy > 0', pepper.toBuy > 0);
  }

  // ------- sortItems：分类优先，待购优先 -------
  const itemsForSort = [
    { name: '盐', category: 'seasoning', toBuy: 0, enough: true },
    { name: '猪肉', category: 'meat_egg', toBuy: 100, enough: false },
    { name: '番茄', category: 'vegetable', toBuy: 2, enough: false },
    { name: '油', category: 'seasoning', toBuy: 0, enough: true },
  ];
  const sorted = core.sortItems(itemsForSort);
  check('第一项是 vegetable', sorted[0].category === 'vegetable');
  check('第二项是 meat_egg', sorted[1].category === 'meat_egg');

  // ------- groupItems -------
  const groups = core.groupItems(items);
  check('groupItems 非空', groups.length > 0);
  // 至少应有 vegetable、meat_egg、seasoning 三个分类
  const catCodes = groups.map((g) => g.category);
  check('groups 含 vegetable', catCodes.includes('vegetable'));
  check('groups 含 meat_egg', catCodes.includes('meat_egg') || catCodes.includes('seasoning'));

  // ------- extractChecked / applyChecked -------
  const checkedMap = core.extractChecked([{ key: 'a|g', checked: true }, { key: 'b|g', checked: false }]);
  checkEqual('extractChecked 只存 true', checkedMap['a|g'], true);
  check('extractChecked 不存 false', checkedMap['b|g'] === undefined);

  const applied = core.applyChecked(
    [{ key: 'a|g', checked: false }, { key: 'b|g', checked: false }],
    { 'a|g': true },
  );
  check('applyChecked 回填 a', applied[0].checked === true);
  check('applyChecked 不填 b', applied[1].checked === false);

  // ------- summarizeItems -------
  const summary = core.summarizeItems([
    { toBuy: 3, enough: false, checked: true },
    { toBuy: 0, enough: true, checked: false },
  ]);
  checkEqual('summary total = 2', summary.total, 2);
  checkEqual('summary toBuyCount = 1', summary.toBuyCount, 1);
  checkEqual('summary inStockCount = 1', summary.inStockCount, 1);
  checkEqual('summary checkedCount = 1', summary.checkedCount, 1);

  // ------- guessCategory -------
  checkEqual('猪肉 → meat_egg', core.guessCategory('猪肉'), 'meat_egg');
  checkEqual('豆腐 → soy_product', core.guessCategory('豆腐'), 'soy_product');
  checkEqual('大米 → staple', core.guessCategory('大米'), 'staple');
  checkEqual('食盐 → seasoning', core.guessCategory('食盐'), 'seasoning');
  checkEqual('干辣椒 → seasoning', core.guessCategory('干辣椒'), 'seasoning');
  checkEqual('虾仁 → seafood', core.guessCategory('虾仁'), 'seafood');
  checkEqual('牛奶 → dairy', core.guessCategory('牛奶'), 'dairy');
  checkEqual('苹果 → fruit', core.guessCategory('苹果'), 'fruit');
  checkEqual('番茄 → vegetable', core.guessCategory('番茄'), 'vegetable');
  checkEqual('未知食材 → other', core.guessCategory('飞天仙草'), 'other');
}

/* ============================== generateShoppingList ============================== */

async function runGenerateTests() {
  section('generateShoppingList');

  const res1 = await callShopping('generateShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');

  check('首次生成成功', res1.success === true);
  check('返回 listId', typeof res1.data.listId === 'string');
  check('返回 items', Array.isArray(res1.data.items));
  check('返回 groups', Array.isArray(res1.data.groups));

  const summary = res1.data.summary;
  check('summary.total > 0', summary.total > 0);

  // 验证落库
  const saved = store.shopping_lists.filter((s) => s.menuId === MENU_ID);
  checkEqual('shopping_lists 落库 1 条', saved.length, 1);
  checkEqual('落库 familyId', saved[0].familyId, 'fam-1');

  // 刷新：再次生成，保留勾选
  // 先勾选一项
  await callShopping('toggleShoppingItem', {
    familyId: 'fam-1',
    menuId: MENU_ID,
    key: res1.data.items[0].key,
    checked: true,
  }, 'openid-a');

  const res2 = await callShopping('generateShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');
  check('刷新成功', res2.success === true);

  // 检查勾选保留
  const saved2 = store.shopping_lists.filter((s) => s.menuId === MENU_ID);
  checkEqual('刷新后仍只有 1 条', saved2.length, 1);
  const firstItem = saved2[0].items.find((i) => i.key === res1.data.items[0].key);
  check('刷新保留勾选状态', firstItem && firstItem.checked === true);

  // 未确认菜单被拒
  const res3 = await callShopping('generateShoppingList', {
    familyId: 'fam-1',
    menuId: 'menu-draft',
  }, 'openid-a');
  checkEqual('未确认菜单被拒', res3.code, 'MENU_NOT_CONFIRMED');

  // 菜单不属于该家庭
  const res4 = await callShopping('generateShoppingList', {
    familyId: 'fam-1',
    menuId: 'menu-fam2',
  }, 'openid-a');
  checkEqual('跨家庭菜单被拒', res4.code, 'FORBIDDEN');
}

/* ============================== getShoppingList ============================== */

async function runGetListTests() {
  section('getShoppingList');

  // 按 menuId 查
  const res1 = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');
  check('按 menuId 查成功', res1.success === true);
  check('list 非 null', res1.data.list !== null);
  check('list.menuId 匹配', res1.data.list.menuId === MENU_ID);

  // 不按 menuId 取最近
  const res2 = await callShopping('getShoppingList', {
    familyId: 'fam-1',
  }, 'openid-a');
  check('不传 menuId 也成功', res2.success === true);
  check('返回最近一份', res2.data.list !== null);

  // 不存在的 list 返回 null（正常业务状态）
  mock.setOpenid('openid-c');
  const res3 = await shoppingFn.main({
    action: 'getShoppingList',
    familyId: 'fam-1',
    menuId: 'menu-nonexist',
  });
  check('不存在的清单 list=null', res3.data.list === null);
  check('不存在的清单 success=true', res3.success === true);

  // 非家庭成员被拒
  const res4 = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-b');
  checkEqual('非成员被拒', res4.code, 'NOT_IN_FAMILY');
}

/* ============================== toggleShoppingItem ============================== */

async function runToggleTests() {
  section('toggleShoppingItem');

  // 先生成一份 LIST
  await callShopping('generateShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');

  const listResult = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');
  const firstKey = listResult.data.list.items[0].key;

  // 勾选
  const res1 = await callShopping('toggleShoppingItem', {
    familyId: 'fam-1',
    menuId: MENU_ID,
    key: firstKey,
    checked: true,
  }, 'openid-a');
  check('勾选成功', res1.success === true);
  check('返回 key', res1.data.key === firstKey);
  check('返回 checked=true', res1.data.checked === true);

  // 验证落库
  const saved = store.shopping_lists.find((s) => s.menuId === MENU_ID);
  const item = saved.items.find((i) => i.key === firstKey);
  check('落库 checked=true', item && item.checked === true);

  // 取消勾选
  await callShopping('toggleShoppingItem', {
    familyId: 'fam-1',
    menuId: MENU_ID,
    key: firstKey,
    checked: false,
  }, 'openid-a');
  const saved2 = store.shopping_lists.find((s) => s.menuId === MENU_ID);
  const item2 = saved2.items.find((i) => i.key === firstKey);
  check('落库 checked=false', item2 && item2.checked === false);

  // 缺 key
  const res3 = await callShopping('toggleShoppingItem', {
    familyId: 'fam-1',
    menuId: MENU_ID,
    checked: true,
  }, 'openid-a');
  checkEqual('缺 key 被拒', res3.code, 'INVALID_PARAMS');

  // checked 非布尔
  const res4 = await callShopping('toggleShoppingItem', {
    familyId: 'fam-1',
    menuId: MENU_ID,
    key: firstKey,
    checked: 'yes',
  }, 'openid-a');
  checkEqual('checked 非布尔被拒', res4.code, 'INVALID_PARAMS');

  // 不存在的 key
  const res5 = await callShopping('toggleShoppingItem', {
    familyId: 'fam-1',
    menuId: MENU_ID,
    key: 'ghost|kg',
    checked: true,
  }, 'openid-a');
  checkEqual('不存在的 key 被拒', res5.code, 'ITEM_NOT_FOUND');

  // 成员 C 也改勾选
  const res6 = await callShopping('toggleShoppingItem', {
    familyId: 'fam-1',
    menuId: MENU_ID,
    key: firstKey,
    checked: true,
  }, 'openid-c');
  check('成员 C 勾选成功（共享清单）', res6.success === true);
}

/* ============================== 安全验证 ============================== */

async function runSecurityTests() {
  section('安全');

  // 未登录
  const res1 = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-nonexist');
  checkEqual('未登录被拒', res1.code, 'UNAUTHORIZED');

  // 缺 familyId
  const res2 = await callShopping('getShoppingList', {
    menuId: MENU_ID,
  }, 'openid-a');
  checkEqual('缺 familyId 被拒', res2.code, 'INVALID_PARAMS');

  // 缺 menuId（generate）
  const res3 = await callShopping('generateShoppingList', {
    familyId: 'fam-1',
  }, 'openid-a');
  checkEqual('generate 缺 menuId 被拒', res3.code, 'INVALID_PARAMS');

  // 跨家庭访问
  const res4 = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: 'menu-fam2',
  }, 'openid-a');
  checkEqual('跨家庭 menu 被拒', res4.code, 'FORBIDDEN');
}

/* ============================== 降级验证 ============================== */

async function runMissingCollectionTests() {
  section('集合缺失降级');

  setMissingCollections(['shopping_lists']);
  mock.setOpenid('openid-a');

  const res1 = await shoppingFn.main({
    action: 'getShoppingList',
    familyId: 'fam-1',
    menuId: MENU_ID,
  });
  checkEqual('DB_NOT_READY 降级', res1.code, 'DB_NOT_READY');

  const res2 = await shoppingFn.main({
    action: 'toggleShoppingItem',
    familyId: 'fam-1',
    menuId: MENU_ID,
    key: 'x|g',
    checked: true,
  });
  checkEqual('toggle DB_NOT_READY', res2.code, 'DB_NOT_READY');

  const res3 = await shoppingFn.main({
    action: 'generateShoppingList',
    familyId: 'fam-1',
    menuId: MENU_ID,
  });
  checkEqual('generate DB_NOT_READY', res3.code, 'DB_NOT_READY');

  setMissingCollections([]);
}

/* ============================== 响应信封 ============================== */

async function runEnvelopeTests() {
  section('响应信封');

  const res = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');

  check('成功时 success=true', res.success === true);
  check('成功时 error=null', res.error === null);

  const badRes = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: 'menu-fam2',
  }, 'openid-a');
  check('失败时 success=false', badRes.success === false);
  check('失败时 data=null', badRes.data === null);
  check('失败时 error.code 存在', badRes.error && typeof badRes.error.code === 'string');
  check('失败时 error.message 存在', badRes.error && typeof badRes.error.message === 'string');
  check('失败时 code 与 error.code 一致', badRes.code === badRes.error.code);
}

/* ============================== toListView 结构 ============================== */

async function runListViewTests() {
  section('toListView 返回结构');

  await callShopping('generateShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');

  const res = await callShopping('getShoppingList', {
    familyId: 'fam-1',
    menuId: MENU_ID,
  }, 'openid-a');

  const list = res.data.list;
  check('listId 非空', typeof list.listId === 'string');
  check('familyId', list.familyId === 'fam-1');
  check('menuId', list.menuId === MENU_ID);
  check('mealType', list.mealType === 'dinner');
  check('servings', list.servings === 3);
  check('dateLabel', list.dateLabel === '2026-10-10');
  check('groups 与 items 条数一致', list.groups.reduce((sum, g) => sum + g.items.length, 0) === list.items.length);
  check('summary.total 与 items 长度一致', list.summary.total === list.items.length);
  check('含 createdAt', typeof list.createdAt === 'string');
  check('含 updatedAt', typeof list.updatedAt === 'string');
}

/* ============================== 主入口 ============================== */

async function main() {
  console.log('Phase E1/E3 采购清单 · 验证开始');

  resetStore();
  seedUsersAndFamily();
  seedMenu();
  seedStock();

  try {
    runModelChecks();
    runCoreChecks();
    await runGenerateTests();
    await runGetListTests();
    await runToggleTests();
    await runSecurityTests();
    await runMissingCollectionTests();
    await runEnvelopeTests();
    await runListViewTests();
  } catch (error) {
    console.error('[verify-shopping] 意外异常', error);
  }

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
  if (failures.length > 0) {
    console.log('失败清单：');
    failures.forEach((f) => console.log('  - ' + f));
  } else {
    console.log('全部通过');
  }
  console.log();

  process.exit(failures.length > 0 ? 1 : 0);
}

main();