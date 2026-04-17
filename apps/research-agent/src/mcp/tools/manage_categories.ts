import { z } from "zod";
import type { Env } from "../../types";
import { categoryQueries } from "../../lib/db";
import type { CategoryRow } from "../../lib/db";

export const ManageCategoriesInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name:        z.string().min(1).max(100).describe("Category name"),
    description: z.string().max(500).optional().describe("What this category covers"),
    color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Hex color, e.g. #3B82F6"),
    parent_id:   z.string().uuid().optional().describe("Parent category ID for hierarchy"),
  }),
  z.object({
    action: z.literal("list"),
    parent_id:   z.string().uuid().optional().describe("Filter to children of this parent"),
    include_counts: z.boolean().default(false).describe("Include article counts per category"),
  }),
  z.object({
    action: z.literal("get"),
    category_id: z.string().uuid().describe("Category to retrieve"),
  }),
  z.object({
    action: z.literal("update"),
    category_id: z.string().uuid().describe("Category to update"),
    name:        z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    parent_id:   z.string().uuid().nullable().optional().describe("New parent, or null to make top-level"),
  }),
  z.object({
    action: z.literal("delete"),
    category_id: z.string().uuid().describe("Category to delete — tagged articles are NOT deleted"),
  }),
]);

export type ManageCategoriesInput = z.infer<typeof ManageCategoriesInput>;

interface TreeNode extends CategoryRow {
  children: TreeNode[];
  article_count?: number;
}

function buildTree(categories: Array<CategoryRow & { article_count?: number }>): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  for (const cat of categories) {
    nodeMap.set(cat.id, { ...cat, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export interface ManageCategoriesOutput {
  action:      string;
  category?:   CategoryRow;
  categories?: TreeNode[];
  message?:    string;
}

export async function manageCategories(
  input: ManageCategoriesInput,
  env: Env,
): Promise<ManageCategoriesOutput> {
  const db = env.CONTENT_DB;

  if (input.action === "create") {
    if (input.parent_id) {
      const parent = await categoryQueries.findById(db, input.parent_id);
      if (!parent) throw new Error(`Parent category not found: ${input.parent_id}`);
    }
    const category = await categoryQueries.create(db, {
      name: input.name,
      description: input.description,
      color: input.color,
      parent_id: input.parent_id,
    });
    return { action: "create", category, message: `Category "${input.name}" created` };
  }

  if (input.action === "list") {
    if (input.include_counts) {
      const cats = await categoryQueries.listWithCounts(db);
      const filtered = input.parent_id
        ? cats.filter((c) => c.parent_id === input.parent_id)
        : cats;
      return { action: "list", categories: buildTree(filtered) };
    }
    const cats = await categoryQueries.list(db, input.parent_id);
    return { action: "list", categories: buildTree(cats) };
  }

  if (input.action === "get") {
    const category = await categoryQueries.findById(db, input.category_id);
    if (!category) throw new Error(`Category not found: ${input.category_id}`);
    const children = await categoryQueries.list(db, input.category_id);
    return {
      action: "get",
      category,
      categories: children.map((c) => ({ ...c, children: [] })),
    };
  }

  if (input.action === "update") {
    const updated = await categoryQueries.update(db, input.category_id, {
      name:        input.name,
      description: input.description,
      color:       input.color,
      parent_id:   input.parent_id,
    });
    if (!updated) throw new Error(`Category not found: ${input.category_id}`);
    return { action: "update", category: updated, message: "Category updated" };
  }

  // action === "delete"
  const existing = await categoryQueries.findById(db, input.category_id);
  if (!existing) throw new Error(`Category not found: ${input.category_id}`);
  await categoryQueries.delete(db, input.category_id);
  return { action: "delete", category: existing, message: `Category "${existing.name}" deleted` };
}
