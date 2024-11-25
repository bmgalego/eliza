// import { readdir } from 'fs/promises';
// import path from 'path';
// import { DatabaseAdapter } from './adapter';

// export class MigrationManager {
//   private adapter: DatabaseAdapter;
//   private migrationPath: string;

//   constructor(adapter: DatabaseAdapter, migrationPath: string) {
//     this.adapter = adapter;
//     this.migrationPath = migrationPath;
//   }

//   /**
//    * Run all pending migrations
//    */
//   async runAllMigrations(): Promise<void> {
//     // await this.adapter.connect();

//     try {
//       // Ensure migrations table exists
//       await this.createMigrationsTable();

//       // Get list of migration files
//       const migrationFiles = await readdir(this.migrationPath);
//       const sortedMigrations = migrationFiles
//         .filter(file => file.endsWith('.js') || file.endsWith('.ts'))
//         .sort();

//       // Run migrations that haven't been applied
//       for (const migrationFile of sortedMigrations) {
//         const migrationFullPath = path.join(this.migrationPath, migrationFile);
        
//         // Check if migration has been run
//         const migrationApplied = await this.adapter.checkMigrationApplied(migrationFile);
        
//         if (!migrationApplied) {
//           await this.adapter.runMigration(migrationFullPath);
//           await this.recordMigration(migrationFile);
//         }
//       }
//     } finally {
//       await this.adapter.disconnect();
//     }
//   }

//   /**
//    * Create migrations tracking table if not exists
//    */
//   private async createMigrationsTable(): Promise<void> {
//     await this.adapter.executeQuery(`
//       CREATE TABLE IF NOT EXISTS migrations (
//         name VARCHAR(255) PRIMARY KEY,
//         run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//       )
//     `);
//   }

//   /**
//    * Record a migration as applied
//    * @param migrationName Name of the migration to record
//    */
//   private async recordMigration(migrationName: string): Promise<void> {
//     await this.adapter.executeQuery(`
//       INSERT INTO migrations (name) VALUES ('${migrationName}')
//     `);
//   }
// }