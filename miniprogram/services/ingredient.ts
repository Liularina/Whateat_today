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
