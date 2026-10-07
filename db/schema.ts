import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const cargoSessions = sqliteTable('cargo_sessions', { id: text('id').primaryKey(), revision: integer('revision').notNull(), body: text('body').notNull() });
