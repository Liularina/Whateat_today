/**
 * 食材库存服务
 */
import type { Ingredient, IngredientInput } from '../types/ingredient';
import { callFunction } from '../utils/cloud';

export const ingredientService = {
  list(familyId: string): Promise<Ingredient[]> {
    return callFunction<Ingredient[], { familyId: string }>('ingredient', 'listIngredients', {
      familyId,
    });
  },

  create(familyId: string, input: IngredientInput): Promise<Ingredient> {
    return callFunction<Ingredient, { familyId: string; input: IngredientInput }>(
      'ingredient',
      'createIngredient',
      { familyId, input },
    );
  },

  /**
   * 批量新增食材（如把「还需采购」的食材一次性加入库存）。
   * 并发发出请求，整体耗时约等于单次请求；单个失败不影响其余，
   * 返回成功写入的条目数与失败明细，由调用方决定如何提示。
   */
  async createMany(
    familyId: string,
    inputs: IngredientInput[],
  ): Promise<{ created: Ingredient[]; failed: string[] }> {
    const results = await Promise.all(
      inputs.map((input) =>
        ingredientService
          .create(familyId, input)
          .then((item) => ({ ok: true as const, item, name: input.name }))
          .catch(() => ({ ok: false as const, item: null, name: input.name })),
      ),
    );

    const created: Ingredient[] = [];
    const failed: string[] = [];
    for (const r of results) {
      if (r.ok && r.item) created.push(r.item);
      else failed.push(r.name);
    }
    return { created, failed };
  },

  update(familyId: string, id: string, input: Partial<IngredientInput>): Promise<Ingredient> {
    return callFunction<Ingredient, { familyId: string; id: string; input: Partial<IngredientInput> }>(
      'ingredient',
      'updateIngredient',
      { familyId, id, input },
    );
  },

  remove(familyId: string, id: string): Promise<null> {
    return callFunction<null, { familyId: string; id: string }>('ingredient', 'deleteIngredient', {
      familyId,
      id,
    });
  },
};
