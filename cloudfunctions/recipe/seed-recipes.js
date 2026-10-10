/**
 * 内置菜谱初始化（Phase 6）
 *
 * 把 recipe-data.js 里的 33 道基础菜谱写入云数据库 recipes 集合。
 *
 * 幂等性（规范第 5 章要求）：
 *   - 以 name 作为内置菜谱的业务唯一键：
 *     已存在的内置菜谱走 update，缺失的才 add，因此重复执行不会产生重复数据；
 *   - 只读取并更新 source = 'builtin' 的记录，
 *     用户自建菜谱（manual）与 AI 生成菜谱（ai）既不会被覆盖也不会被删除。
 *
 * 运行方式（两者都需要能访问云数据库的环境，本地 `node seed-recipes.js` 不可用）：
 *   1) 推荐：微信开发者工具 → 云开发控制台 → 云函数 recipe → 测试，
 *      入参填 {"action":"seedRecipes"}，返回 inserted / updated / total；
 *   2) 备选：在「云函数本地调试」中直接运行本文件。
 *
 * 直接执行（方式 2）依赖 wx-server-sdk 的运行环境，仅有 node 的本机跑不通，
 * 因此这里不伪装成功，失败会以非 0 退出码明确报错。
 */
const { BUILTIN_RECIPES } = require('./recipe-data');

/** 内置菜谱总量很小，一次读回即可；上限用于防止误读全表 */
const SEED_READ_LIMIT = 1000;

/** 内置菜谱标记 */
const SOURCE_BUILTIN = 'builtin';

/**
 * 执行初始化。db 由调用方注入（云函数环境或本地测试替身），便于验证幂等性。
 *
 * @param {object} db cloud.database() 返回的数据库实例
 * @returns {Promise<{inserted:number, updated:number, total:number}>}
 */
async function seedRecipes(db) {
  const collection = db.collection('recipes');

  const existing = await collection.where({ source: SOURCE_BUILTIN }).limit(SEED_READ_LIMIT).get();

  const existingByName = {};
  for (const row of existing.data || []) {
    if (row && row.name) {
      existingByName[row.name] = row;
    }
  }

  let inserted = 0;
  let updated = 0;
  const now = new Date();

  for (const recipe of BUILTIN_RECIPES) {
    const payload = {
      name: recipe.name,
      description: recipe.description,
      category: recipe.category,
      tags: recipe.tags,
      difficulty: recipe.difficulty,
      cookTime: recipe.cookTime,
      servings: recipe.servings,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      source: SOURCE_BUILTIN,
      isActive: true,
      updatedAt: now,
    };

    const found = existingByName[recipe.name];
    if (found) {
      // 已存在：更新，保留原有 _id 与 createdAt
      await collection.doc(found._id).update({ data: payload });
      updated += 1;
    } else {
      await collection.add({ data: Object.assign({}, payload, { createdAt: now }) });
      inserted += 1;
    }
  }

  return { inserted: inserted, updated: updated, total: BUILTIN_RECIPES.length };
}

module.exports = { seedRecipes, SOURCE_BUILTIN, SEED_READ_LIMIT };

/* ------------------------------ 直接执行入口 ------------------------------ */

if (require.main === module) {
  (async () => {
    let cloud;
    try {
      cloud = require('wx-server-sdk');
    } catch (error) {
      console.error(
        '无法加载 wx-server-sdk，本机 node 环境读不到云数据库。\n' +
          '请在开发者工具的「云函数本地调试」中运行本文件，或改用 recipe 云函数的 seedRecipes 动作。',
      );
      process.exit(1);
      return;
    }

    try {
      cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
      const result = await seedRecipes(cloud.database());
      console.log(
        '内置菜谱初始化完成：新增 ' +
          result.inserted +
          ' 条，更新 ' +
          result.updated +
          ' 条，共 ' +
          result.total +
          ' 条。',
      );
    } catch (error) {
      console.error('内置菜谱初始化失败：', error);
      process.exit(1);
    }
  })();
}
