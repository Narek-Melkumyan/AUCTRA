import { Controller, Get, Injectable, Module, Param } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { Public } from '../common/decorators.js';
import { Errors } from '../common/errors.js';

/** Lots a visitor can bid on now or soon. */
const OPEN_PUBLIC: Prisma.AuctionWhereInput = {
  status: { in: ['SCHEDULED', 'LIVE'] },
  visibility: 'PUBLIC',
};

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async tree() {
    const all = await this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        attributes: { orderBy: { sortOrder: 'asc' } },
        _count: {
          select: {
            // Lots reference their top-level category in categoryId and an optional
            // subcategory in subcategoryId, so each level counts its own relation.
            auctions: { where: OPEN_PUBLIC },
            auctionsInSubcat: { where: OPEN_PUBLIC },
          },
        },
      },
    });
    const toDto = (c: (typeof all)[number]) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
      activeAuctionCount: c.parentId
        ? c._count.auctionsInSubcat
        : c._count.auctions,
      attributes: c.attributes.map((a) => ({
        key: a.key,
        label: a.label,
        type: a.type,
        required: a.isRequired,
        options: a.options,
        unit: a.unit,
      })),
    });
    return all
      .filter((c) => !c.parentId)
      .map((root) => ({
        ...toDto(root),
        subcategories: all.filter((c) => c.parentId === root.id).map(toDto),
      }));
  }

  async bySlug(slug: string) {
    const tree = await this.tree();
    const found =
      tree.find((c) => c.slug === slug) ??
      tree.flatMap((c) => c.subcategories).find((c) => c.slug === slug);
    if (!found) throw Errors.notFound('Category');
    return found;
  }

  /** Resolves (category, subcategory) slugs, checking the subcategory belongs to the category. */
  async resolve(tx: Tx, categorySlug: string, subcategorySlug?: string | null) {
    const category = await tx.category.findUnique({
      where: { slug: categorySlug },
    });
    if (!category || !category.isActive || category.parentId) {
      throw Errors.unprocessable(
        'INVALID_CATEGORY',
        'Choose a valid top-level category.',
      );
    }
    let subcategory = null;
    if (subcategorySlug) {
      subcategory = await tx.category.findUnique({
        where: { slug: subcategorySlug },
      });
      if (
        !subcategory ||
        subcategory.parentId !== category.id ||
        !subcategory.isActive
      ) {
        throw Errors.unprocessable(
          'INVALID_SUBCATEGORY',
          'Subcategory does not belong to the chosen category.',
        );
      }
    }
    const attributes = await tx.categoryAttribute.findMany({
      where: {
        categoryId: {
          in: [category.id, ...(subcategory ? [subcategory.id] : [])],
        },
      },
    });
    return { category, subcategory, attributes };
  }
}

@Controller('categories')
@Public()
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list() {
    return this.categories.tree();
  }

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.categories.bySlug(slug);
  }
}

@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
