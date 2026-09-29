import { customType } from 'drizzle-orm/pg-core';

/** Case-insensitive text (requires the `citext` extension, created by migration 0000). */
export const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});
