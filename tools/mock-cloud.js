/**
 * 内存版 wx-server-sdk
 *
 * 用途：在不依赖真实云环境的前提下，直接驱动 cloudfunctions/<name>/index.js 的
 * 业务逻辑，让权限、隔离、校验、补偿等行为可以在本地 / CI 中重复验证。
 *
 * 用法：
 *   const { createMockCloud } = require('./mock-cloud');
 *   const mock = createMockCloud();
 *   mock.install();                       // 拦截 require('wx-server-sdk')
 *   const fn = require('../cloudfunctions/family/index.js');
 *   mock.setOpenid('openid-a');
 *   await fn.main({ action: 'createFamily' });
 *
 * 已支持：where / orderBy / limit / get / count / remove / update / doc().get|update|remove / add
 * 未支持：聚合、事务、正则查询、分页 skip —— 第一阶段的云函数用不到。
 */
const Module = require('module');

/** 内部使用的「in」命令标记，避免与真实字段名冲突 */
const IN_CMD = '__in__';

/** 规范第 12.13 节列出的全部集合 */
const KNOWN_COLLECTIONS = [
  'users',
  'families',
  'family_members',
  'ingredients',
  'recipes',
  'menus',
  'family_orders',
  'family_order_items',
  'nutrition_facts',
  'ingredient_aliases',
  'ai_logs',
];

function createMockCloud() {
  /** 内存数据库：集合名 → 文档数组 */
  const store = {};

  /**
   * 预先建好的集合，与规范第 12.13 节的数据清单一致。
   * 测试可以直接向 store.xxx push 造数据；清单之外的集合由 ensureCollection 按需创建。
   */
  KNOWN_COLLECTIONS.forEach((name) => {
    store[name] = [];
  });

  const state = {
    currentOpenid: '',
    /** 集合缺失开关：用于验证 DB_NOT_READY */
    missingCollections: [],
    /** 注入「写入某集合失败」，用于验证失败补偿逻辑 */
    failAddFor: '',
  };

  let autoId = 0;

  function ensureCollection(name) {
    if (!store[name]) {
      store[name] = [];
    }
    return store[name];
  }

  function resetStore() {
    Object.keys(store).forEach((key) => {
      store[key].length = 0;
    });
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function nextId(prefix) {
    autoId += 1;
    return prefix + '_' + autoId;
  }

  const command = {
    in(values) {
      return { [IN_CMD]: Array.isArray(values) ? values.slice() : [] };
    },
  };

  function matches(doc, condition) {
    return Object.keys(condition).every((key) => {
      const expected = condition[key];
      const actual = doc[key];
      if (expected && typeof expected === 'object' && expected[IN_CMD]) {
        return expected[IN_CMD].indexOf(actual) !== -1;
      }
      return actual === expected;
    });
  }

  function assertCollection(name) {
    if (state.missingCollections.indexOf(name) !== -1) {
      const error = new Error('collection ' + name + ' not exists');
      error.errCode = -502005;
      throw error;
    }
  }

  function makeQuery(name, queryState) {
    const current = queryState || { condition: {}, order: null, take: 0 };

    return {
      where(next) {
        return makeQuery(name, Object.assign({}, current, {
          condition: Object.assign({}, current.condition, next),
        }));
      },
      orderBy(field, direction) {
        return makeQuery(name, Object.assign({}, current, { order: { field, direction } }));
      },
      limit(count) {
        return makeQuery(name, Object.assign({}, current, { take: count }));
      },
      async get() {
        assertCollection(name);
        let rows = ensureCollection(name).filter((doc) => matches(doc, current.condition));
        if (current.order) {
          const { field, direction } = current.order;
          const factor = direction === 'desc' ? -1 : 1;
          rows = rows.slice().sort((a, b) => {
            const left = a[field] instanceof Date ? a[field].getTime() : a[field];
            const right = b[field] instanceof Date ? b[field].getTime() : b[field];
            if (left === right) return 0;
            return left > right ? factor : -factor;
          });
        }
        if (current.take > 0) {
          rows = rows.slice(0, current.take);
        }
        return { data: rows.map(clone) };
      },
      async count() {
        assertCollection(name);
        return {
          total: ensureCollection(name).filter((doc) => matches(doc, current.condition)).length,
        };
      },
      async remove() {
        assertCollection(name);
        const keep = [];
        let removed = 0;
        for (const doc of ensureCollection(name)) {
          if (matches(doc, current.condition)) {
            removed += 1;
          } else {
            keep.push(doc);
          }
        }
        store[name] = keep;
        return { stats: { removed } };
      },
      async update(payload) {
        assertCollection(name);
        let updated = 0;
        for (const doc of ensureCollection(name)) {
          if (matches(doc, current.condition)) {
            Object.assign(doc, payload.data);
            updated += 1;
          }
        }
        return { stats: { updated } };
      },
    };
  }

  function makeCollection(name) {
    return {
      where(condition) {
        return makeQuery(name, { condition: condition, order: null, take: 0 });
      },
      orderBy(field, direction) {
        return makeQuery(name, { condition: {}, order: { field, direction }, take: 0 });
      },
      limit(count) {
        return makeQuery(name, { condition: {}, order: null, take: count });
      },
      doc(id) {
        return {
          async get() {
            assertCollection(name);
            const found = ensureCollection(name).filter((doc) => doc._id === id)[0];
            if (!found) {
              const error = new Error('document not exists');
              error.errCode = -502002;
              throw error;
            }
            return { data: clone(found) };
          },
          async update(payload) {
            assertCollection(name);
            const found = ensureCollection(name).filter((doc) => doc._id === id)[0];
            if (!found) {
              const error = new Error('document not exists');
              error.errCode = -502002;
              throw error;
            }
            Object.assign(found, payload.data);
            return { stats: { updated: 1 } };
          },
          async remove() {
            assertCollection(name);
            store[name] = ensureCollection(name).filter((doc) => doc._id !== id);
            return { stats: { removed: 1 } };
          },
        };
      },
      async add(payload) {
        assertCollection(name);

        if (state.failAddFor === name) {
          throw new Error('mock: ' + name + ' add failed');
        }

        const doc = Object.assign({ _id: nextId(name) }, payload.data);
        ensureCollection(name).push(doc);
        return { _id: doc._id };
      },
    };
  }

  const mockCloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init() {},
    getWXContext() {
      return { OPENID: state.currentOpenid };
    },
    database() {
      return { collection: makeCollection, command };
    },
    __setOpenid(value) {
      state.currentOpenid = value;
    },
  };

  /** 把 require('wx-server-sdk') 指向本替身 */
  function install() {
    const originalLoad = Module._load;
    Module._load = function (request) {
      if (request === 'wx-server-sdk') {
        return mockCloud;
      }
      return originalLoad.apply(this, arguments);
    };
  }

  return {
    store,
    resetStore,
    install,
    mockCloud,
    setOpenid(value) {
      state.currentOpenid = value;
    },
    setMissingCollections(list) {
      state.missingCollections = list || [];
    },
    setFailAddFor(name) {
      state.failAddFor = name || '';
    },
  };
}

module.exports = { createMockCloud };
