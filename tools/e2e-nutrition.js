/**
 * 营养估算 · 模拟器端到端验证（需要本机微信开发者工具）
 *
 * 运行：npm run e2e:nutrition
 *
 * 前置条件：
 *   1. 本机已安装微信开发者工具，且「设置 → 安全设置 → 服务端口」已开启；
 *   2. 云开发环境可用（登录、云函数调用要能真正走通）。
 *
 * 与 tools/verify-*.js 的区别：
 *   verify 套件跑的是内存版云开发，验证逻辑正确性；
 *   本脚本驱动真实模拟器，验证「页面接线 + 云函数 + 渲染」整条链路。
 *   因此它不属于 CI 门禁，失败可能来自环境而非代码。
 *
 * 覆盖的主流程：
 *   登录 → 建家庭（如无）→ 加食材（番茄 300g / 鸡蛋 2 个）→ 打开营养估算 → 核对数值与免责声明
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');

const automator = require('miniprogram-automator');

/* ============================== 断言工具 ============================== */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  [通过] ' + name);
    return true;
  }
  failures.push(name + (detail ? ' -> ' + detail : ''));
  console.log('  [失败] ' + name + (detail ? ' -> ' + detail : ''));
  return false;
}

function checkEqual(name, actual, expected) {
  return check(
    name,
    actual === expected,
    'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected),
  );
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

/* ============================== 环境配置 ============================== */

const PROJECT_PATH = path.join(__dirname, '..');
const CLI_PATH =
  process.env.WECHAT_DEVTOOLS_CLI ||
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
const AUTO_PORT = Number(process.env.WECHAT_DEVTOOLS_AUTO_PORT || 9420);
const SHOT_DIR = path.join(PROJECT_PATH, '.e2e-shots');

/** UNITS 顺序：g / kg / 个 / 袋 / 盒 */
const UNIT_INDEX = { g: 0, kg: 1, 个: 2, 袋: 3, 盒: 4 };
/** INGREDIENT_CATEGORIES 顺序：蔬菜 / 肉蛋 / 水产 / 主食 / ... */
const CATEGORY_INDEX = { vegetable: 0, meat_egg: 1, seafood: 2, staple: 3 };

/* ============================== 辅助函数 ============================== */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到 predicate 返回真值，超时抛错 */
async function waitUntil(label, predicate, { timeout = 20000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error('等待超时：' + label + '（最后取值 ' + JSON.stringify(last) + '）');
}

/** 在当前页面等待，直到 currentPage 的 path 命中 target */
async function waitForPage(miniProgram, target, timeout = 20000) {
  return waitUntil('进入页面 ' + target, async () => {
    const page = await miniProgram.currentPage();
    if (page && page.path && page.path.indexOf(target) !== -1) return page;
    return null;
  }, { timeout });
}

/** 读取 app 全局数据里的指定字段 */
async function readGlobal(miniProgram, key) {
  return miniProgram.evaluate((name) => {
    const app = getApp();
    return app && app.globalData ? app.globalData[name] : undefined;
  }, key);
}

async function screenshot(miniProgram, name) {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, name + '.png');
  await miniProgram.screenshot({ path: file });
  return file;
}

/** TCP 探测端口是否已监听 */
function probePort(port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), timeout);
  });
}

/**
 * 启动自动化会话。
 *
 * 不用 automator.launch：它在 Windows 上直接 child_process.spawn('...\\cli.bat')，
 * 不带 shell 时必然失败（且它显式拒绝 .exe）。这里自己起 `cli auto`，
 * 再按官方文档的 connect 路径接上。
 */
async function startAutomation() {
  // shell:true 时 Node 只拼接参数、不做转义，含空格的路径必须自己加引号
  const command =
    '"' + CLI_PATH + '" auto --project "' + PROJECT_PATH + '" --auto-port ' + AUTO_PORT;
  const child = spawn(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  const onData = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  try {
    await waitUntil('自动化端口 ' + AUTO_PORT + ' 就绪', () => probePort(AUTO_PORT), {
      timeout: 90000,
      interval: 1000,
    });
  } catch (error) {
    child.kill();
    throw new Error(error.message + '\n  cli auto 输出：' + output.trim());
  }

  // cli auto 启用自动化时会重置 appservice，早连会被踢掉，先等它安定下来
  await sleep(10000);

  const wsEndpoint = 'ws://127.0.0.1:' + AUTO_PORT;
  let lastError = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const miniProgram = await automator.connect({ wsEndpoint: wsEndpoint });
      await sleep(2000);
      const current = await miniProgram.send('App.getCurrentPage');
      console.log('  自动化就绪（第 ' + attempt + ' 次连接），当前页 ' + current.path);
      return { miniProgram: miniProgram, child: child };
    } catch (error) {
      lastError = error;
      console.log('  连接尚未就绪，重试中（' + attempt + '/8）');
      await sleep(5000);
    }
  }

  child.kill();
  throw new Error(
    '无法建立自动化会话：' + (lastError && lastError.message) + '\n  cli auto 输出：' + output.trim(),
  );
}

/* ============================== 主流程 ============================== */

async function main() {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error('未找到开发者工具 CLI：' + CLI_PATH + '，可用 WECHAT_DEVTOOLS_CLI 指定');
  }

  section('启动模拟器');
  console.log('  CLI   : ' + CLI_PATH);
  console.log('  项目  : ' + PROJECT_PATH);

  const session = await startAutomation();
  const miniProgram = session.miniProgram;
  console.log('  已连接自动化端口 ' + AUTO_PORT);

  try {
    /* ---------- 1. 等待登录完成 ---------- */
    section('登录状态');
    const isLoggedIn = await waitUntil('登录完成', () => readGlobal(miniProgram, 'isLoggedIn'), {
      timeout: 60000,
    });
    check('已登录', isLoggedIn === true, 'isLoggedIn=' + JSON.stringify(isLoggedIn));
    if (!isLoggedIn) {
      throw new Error('未登录，后续流程无法继续。请在模拟器里完成登录后重跑。');
    }
    const cloudReady = await readGlobal(miniProgram, 'cloudReady');
    check('云开发已初始化', cloudReady === true, 'cloudReady=' + JSON.stringify(cloudReady));

    /* ---------- 2. 确保有家庭 ---------- */
    section('家庭');
    let familyId = await readGlobal(miniProgram, 'currentFamilyId');
    if (!familyId) {
      console.log('  当前无家庭，走「创建家庭」流程');
      await miniProgram.reLaunch('/pages/family/create');
      const createPage = await waitForPage(miniProgram, 'pages/family/create');
      await createPage.setData({ name: 'E2E 测试家' });
      await createPage.callMethod('onSubmit');
      let createFailure = '';
      try {
        await waitUntil('创建家庭完成', async () => {
          const id = await readGlobal(miniProgram, 'currentFamilyId');
          if (id) return id;
          // 页面把云函数的失败原因写在 data.error 上，及时暴露而不是干等超时
          const pageError = (await createPage.data()).error;
          if (pageError) {
            createFailure = pageError;
            return 'FAILED';
          }
          return null;
        }, { timeout: 40000 });
      } finally {
        if (createFailure) {
          console.log('  创建家庭失败：' + createFailure);
        }
      }
      if (createFailure) {
        throw new Error('创建家庭失败：' + createFailure);
      }
      familyId = await readGlobal(miniProgram, 'currentFamilyId');
    }
    check('存在当前家庭', Boolean(familyId), 'familyId=' + JSON.stringify(familyId));

    /* ---------- 3. 添加食材 ---------- */
    section('添加食材');
    await miniProgram.reLaunch('/pages/ingredients/index');
    const ingPage = await waitForPage(miniProgram, 'pages/ingredients/index');
    await waitUntil('食材页就绪', async () => (await ingPage.data()).ready, { timeout: 30000 });

    // 先清空已有食材，否则重复运行会把同一批食材再加一遍，断言值随之飘移
    const stale = (await ingPage.data()).ingredients;
    if (stale.length) {
      console.log('  清理已有食材 ' + stale.length + ' 条');
      for (const item of stale) {
        await ingPage.callMethod('deleteIngredient', item._id);
      }
      await waitUntil('清理已有食材', async () => (await ingPage.data()).ingredients.length === 0, {
        timeout: 30000,
      });
    }

    /** 通过页面自身方法写入表单并提交，绕开原生 picker 无法自动化的限制 */
    async function addIngredient(name, quantity, unit, categoryIndex) {
      const before = (await ingPage.data()).ingredients.length;
      await ingPage.callMethod('onOpenCreate');
      await ingPage.setData({
        formName: name,
        formQuantity: String(quantity),
        formUnitIndex: UNIT_INDEX[unit],
        formCategoryIndex: categoryIndex,
      });
      await ingPage.callMethod('onSubmit');
      await waitUntil('食材「' + name + '」保存完成', async () => {
        const data = await ingPage.data();
        return data.formVisible === false && data.ingredients.length > before;
      }, { timeout: 30000 });
      console.log('  已添加 ' + name + ' ' + quantity + unit);
    }

    await addIngredient('番茄', 300, 'g', CATEGORY_INDEX.vegetable);
    await addIngredient('鸡蛋', 2, '个', CATEGORY_INDEX.meat_egg);

    const ingredientNames = (await ingPage.data()).ingredients
      .map((item) => item.name + ' ' + item.quantity + item.unit)
      .join(' / ');
    console.log('  当前食材：' + ingredientNames);
    check('食材列表已包含番茄', ingredientNames.indexOf('番茄') !== -1, ingredientNames);
    check('食材列表已包含鸡蛋', ingredientNames.indexOf('鸡蛋') !== -1, ingredientNames);

    const shotIngredients = await screenshot(miniProgram, '1-ingredients');

    /* ---------- 4. 从食材页入口进入营养估算 ---------- */
    section('营养估算页');
    await ingPage.callMethod('onOpenNutrition');
    const page = await waitForPage(miniProgram, 'pages/nutrition/index');
    await waitUntil('营养计算完成', async () => {
      const data = await page.data();
      return data.ready && !data.calculating;
    }, { timeout: 60000 });

    const data = await page.data();
    console.log('  total    = ' + JSON.stringify(data.total));
    console.log('  perPerson= ' + JSON.stringify(data.perPerson));
    console.log('  人数     = ' + data.peopleCount);
    console.log('  状态     = ' + (data.result && data.result.nutritionStatus));
    console.log('  缺失     = ' + JSON.stringify(data.missingText));
    console.log('  无法换算 = ' + JSON.stringify(data.unconvertibleText));

    check('页面已算出总量', Boolean(data.total), JSON.stringify(data.total));
    check('页面已算出人均', Boolean(data.perPerson), JSON.stringify(data.perPerson));

    if (data.result) {
      const items = data.result.items || [];
      const tomato = items.filter((item) => item.name === '番茄')[0];
      const egg = items.filter((item) => item.name === '鸡蛋')[0];

      if (tomato) {
        checkEqual('番茄可食克数 300', tomato.grams, 300);
        checkEqual('番茄热量 45 kcal', tomato.nutrition && tomato.nutrition.calories, 45);
      } else {
        check('结果含番茄', false, JSON.stringify(items.map((i) => i.name)));
      }

      if (egg) {
        // 2 个 × 50g × 0.88 = 88g 可食
        checkEqual('鸡蛋按平均重量换算为 88 g 可食', egg.grams, 88);
        checkEqual('鸡蛋热量 126.7 kcal', egg.nutrition && egg.nutrition.calories, 126.7);
      } else {
        check('结果含鸡蛋', false, JSON.stringify(items.map((i) => i.name)));
      }
    }

    if (data.total) {
      checkEqual('总量热量 172 kcal', data.total.calories, 172);
    }

    // nutrition-core.js:219 规定：人均热量取整（0 位小数），其余营养 1 位小数
    if (data.total && data.perPerson && data.peopleCount) {
      const expectedCalories = Math.round(data.total.calories / data.peopleCount);
      checkEqual('人均热量 = 总量 ÷ 人数（取整）', data.perPerson.calories, expectedCalories);
      const expectedProtein = Math.round((data.total.protein / data.peopleCount) * 10) / 10;
      checkEqual('人均蛋白质 = 总量 ÷ 人数（1 位小数）', data.perPerson.protein, expectedProtein);
    }

    checkEqual('营养状态 complete', data.result && data.result.nutritionStatus, 'complete');

    const shotNutrition = await screenshot(miniProgram, '2-nutrition');

    /* ---------- 5. 换人数，验证只有人均变化 ---------- */
    section('切换人数');
    const totalBefore = data.total ? data.total.calories : null;
    const targetIndex = data.peopleIndex === 1 ? 2 : 1;
    await page.callMethod('onPeopleChange', { detail: { value: targetIndex } });
    await waitUntil('人数切换后重算完成', async () => {
      const next = await page.data();
      return next.peopleIndex === targetIndex && !next.calculating && next.perPerson;
    }, { timeout: 60000 });

    const after = await page.data();
    checkEqual('切换人数后总量不变', after.total && after.total.calories, totalBefore);
    checkEqual('人数已切换', after.peopleIndex, targetIndex);
    if (after.total && after.perPerson && after.peopleCount) {
      const expectedCalories = Math.round(after.total.calories / after.peopleCount);
      checkEqual('切换后人均热量 = 总量 ÷ 人数（取整）', after.perPerson.calories, expectedCalories);
      const expectedProtein = Math.round((after.total.protein / after.peopleCount) * 10) / 10;
      checkEqual('切换后人均蛋白质 = 总量 ÷ 人数（1 位小数）', after.perPerson.protein, expectedProtein);
    }

    /* ---------- 6. 产物 ---------- */
    section('截图');
    console.log('  食材页  : ' + shotIngredients);
    console.log('  营养页  : ' + shotNutrition);
  } finally {
    await miniProgram.close();
    session.child.kill();
    console.log('\n  已关闭自动化会话');
  }
}

main()
  .then(() => {
    console.log('\n=== 汇总 ===');
    console.log('  通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
    if (failures.length) {
      console.log('  失败项：');
      failures.forEach((name) => console.log('    - ' + name));
      process.exitCode = 1;
    } else {
      console.log('  E2E_OK');
    }
  })
  .catch((error) => {
    console.log('\n=== 汇总 ===');
    console.log('  通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
    failures.forEach((name) => console.log('    - ' + name));
    console.log('  [中断] ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
