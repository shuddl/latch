// Zod schema mirroring edi-core's ElementAddress, so MapArtifacts validate at the
// boundary (CLAUDE.md §5: no `any`, Zod at boundaries). Kept here to avoid making
// edi-core depend on Zod (it is a zero-dep hot-path package).

import { z } from 'zod';
import type { ElementAddress } from '@latch/edi-core';

export const elementAddressSchema: z.ZodType<ElementAddress> = z.object({
  tag: z.string(),
  occurrence: z.number().int().nonnegative(),
  element: z.number().int().positive(),
});
