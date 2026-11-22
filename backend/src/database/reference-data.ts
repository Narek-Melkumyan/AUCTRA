import type {
  AttributeType,
  PrismaClient,
} from '../generated/prisma/client.js';
import { DEFAULT_ROLES, Permission } from '../roles/permissions.js';

type AttrDef = {
  key: string;
  label: string;
  type: AttributeType;
  required?: boolean;
  options?: string[];
  unit?: string;
};
type CategoryDef = {
  slug: string;
  name: string;
  description: string;
  attributes?: AttrDef[];
  children?: Omit<CategoryDef, 'children'>[];
};

/** Primary AUCTRA categories. Typed vehicle/watch facts live in vehicle_details / watch_details. */
export const CATEGORIES: CategoryDef[] = [
  {
    slug: 'cars',
    name: 'Cars',
    description: 'Collector, classic and modern performance cars.',
    attributes: [
      {
        key: 'title_status',
        label: 'Title status',
        type: 'ENUM',
        options: ['Clean', 'Salvage', 'Rebuilt', 'No title'],
        required: true,
      },
      { key: 'service_history', label: 'Service history', type: 'BOOLEAN' },
      { key: 'engine', label: 'Engine', type: 'TEXT' },
    ],
    children: [
      {
        slug: 'cars-classic',
        name: 'Classic cars',
        description: 'Pre-1990 collector vehicles.',
      },
      {
        slug: 'cars-supercars',
        name: 'Supercars & GT',
        description: 'High-performance and grand touring cars.',
      },
      {
        slug: 'cars-modern',
        name: 'Modern classics',
        description: 'Collectible vehicles from 1990 onwards.',
      },
    ],
  },
  {
    slug: 'watches',
    name: 'Watches',
    description: 'Luxury, vintage and independent timepieces.',
    attributes: [
      {
        key: 'water_resistance_m',
        label: 'Water resistance',
        type: 'NUMBER',
        unit: 'm',
      },
    ],
    children: [
      { slug: 'watches-sport', name: 'Sport & dive watches', description: '' },
      { slug: 'watches-dress', name: 'Dress watches', description: '' },
      { slug: 'watches-vintage', name: 'Vintage watches', description: '' },
    ],
  },
  {
    slug: 'jewelry',
    name: 'Jewelry',
    description: 'Fine jewelry, diamonds and gemstones.',
    attributes: [
      { key: 'metal', label: 'Metal', type: 'TEXT' },
      {
        key: 'total_carat',
        label: 'Total carat weight',
        type: 'NUMBER',
        unit: 'ct',
      },
      { key: 'certificate', label: 'Grading certificate', type: 'TEXT' },
    ],
    children: [
      { slug: 'jewelry-necklaces', name: 'Necklaces', description: '' },
      { slug: 'jewelry-rings', name: 'Rings', description: '' },
      { slug: 'jewelry-loose-stones', name: 'Loose stones', description: '' },
    ],
  },
  {
    slug: 'art',
    name: 'Art',
    description: 'Paintings, works on paper, prints and sculpture.',
    attributes: [
      { key: 'artist', label: 'Artist', type: 'TEXT', required: true },
      { key: 'medium', label: 'Medium', type: 'TEXT' },
      { key: 'year_created', label: 'Year created', type: 'NUMBER' },
      { key: 'dimensions', label: 'Dimensions', type: 'TEXT' },
    ],
    children: [
      { slug: 'art-paintings', name: 'Paintings', description: '' },
      { slug: 'art-sculpture', name: 'Sculpture', description: '' },
      { slug: 'art-prints', name: 'Prints & multiples', description: '' },
    ],
  },
  {
    slug: 'real-estate',
    name: 'Real estate',
    description: 'Residential and investment property.',
    attributes: [
      {
        key: 'property_type',
        label: 'Property type',
        type: 'ENUM',
        options: ['Villa', 'Apartment', 'Penthouse', 'House', 'Land'],
        required: true,
      },
      { key: 'bedrooms', label: 'Bedrooms', type: 'NUMBER' },
      { key: 'floor_area_m2', label: 'Floor area', type: 'NUMBER', unit: 'm²' },
      {
        key: 'tenure',
        label: 'Tenure',
        type: 'ENUM',
        options: ['Freehold', 'Leasehold'],
      },
    ],
    children: [
      { slug: 'real-estate-residential', name: 'Residential', description: '' },
      { slug: 'real-estate-commercial', name: 'Commercial', description: '' },
    ],
  },
  {
    slug: 'collectibles',
    name: 'Collectibles',
    description: 'Antiques, design, memorabilia and rare objects.',
    attributes: [
      { key: 'era', label: 'Era / period', type: 'TEXT' },
      { key: 'provenance', label: 'Provenance', type: 'TEXT' },
    ],
    children: [
      { slug: 'collectibles-antiques', name: 'Antiques', description: '' },
      {
        slug: 'collectibles-design',
        name: 'Design & fashion',
        description: '',
      },
      {
        slug: 'collectibles-memorabilia',
        name: 'Memorabilia',
        description: '',
      },
    ],
  },
];

/** System settings. Fee rates are business decisions: they ship as 0 and must be set deliberately. */
const SYSTEM_CONFIG: {
  key: string;
  value: number | string | boolean;
  description: string;
}[] = [
  {
    key: 'fees.seller_commission_bps',
    value: 0,
    description:
      'Seller commission in basis points (100 = 1%). Applied at settlement.',
  },
  {
    key: 'fees.buyer_premium_bps',
    value: 0,
    description:
      "Buyer's premium in basis points added to the hammer price at settlement.",
  },
];

/**
 * Idempotent sync of reference data (safe in every environment, including production):
 * permissions, roles and their grants, categories with attributes, and default config.
 * Existing system-config values are never overwritten.
 */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const key of Object.values(Permission)) {
    await prisma.permission.upsert({
      where: { key },
      create: { key },
      update: {},
    });
  }
  const perms = await prisma.permission.findMany();
  for (const [key, def] of Object.entries(DEFAULT_ROLES)) {
    const role = await prisma.role.upsert({
      where: { key },
      create: {
        key,
        name: def.name,
        description: def.description,
        isSystem: true,
      },
      update: { name: def.name, description: def.description, isSystem: true },
    });
    const wanted = perms.filter((p) =>
      (def.permissions as string[]).includes(p.key),
    );
    await prisma.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        permissionId: { notIn: wanted.map((p) => p.id) },
      },
    });
    await prisma.rolePermission.createMany({
      data: wanted.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  let order = 0;
  for (const c of CATEGORIES) {
    const parent = await prisma.category.upsert({
      where: { slug: c.slug },
      create: {
        slug: c.slug,
        name: c.name,
        description: c.description,
        sortOrder: order,
      },
      update: {
        name: c.name,
        description: c.description,
        sortOrder: order,
        parentId: null,
      },
    });
    order++;
    await syncAttributes(prisma, parent.id, c.attributes ?? []);
    let childOrder = 0;
    for (const child of c.children ?? []) {
      const sub = await prisma.category.upsert({
        where: { slug: child.slug },
        create: {
          slug: child.slug,
          name: child.name,
          description: child.description || null,
          parentId: parent.id,
          sortOrder: childOrder,
        },
        update: {
          name: child.name,
          parentId: parent.id,
          sortOrder: childOrder,
        },
      });
      childOrder++;
      await syncAttributes(prisma, sub.id, child.attributes ?? []);
    }
  }

  for (const cfg of SYSTEM_CONFIG) {
    await prisma.systemConfig.upsert({
      where: { key: cfg.key },
      create: { key: cfg.key, value: cfg.value, description: cfg.description },
      update: { description: cfg.description },
    });
  }
}

async function syncAttributes(
  prisma: PrismaClient,
  categoryId: string,
  attrs: AttrDef[],
) {
  let i = 0;
  for (const a of attrs) {
    await prisma.categoryAttribute.upsert({
      where: { categoryId_key: { categoryId, key: a.key } },
      create: {
        categoryId,
        key: a.key,
        label: a.label,
        type: a.type,
        isRequired: a.required ?? false,
        options: a.options ?? [],
        unit: a.unit ?? null,
        sortOrder: i,
      },
      update: {
        label: a.label,
        type: a.type,
        isRequired: a.required ?? false,
        options: a.options ?? [],
        unit: a.unit ?? null,
        sortOrder: i,
      },
    });
    i++;
  }
}
