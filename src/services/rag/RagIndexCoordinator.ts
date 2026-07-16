/**
 * Cooperative read/write coordinator for persisted vector mutations.
 *
 * Normal indexing operations take a writer lease before resolving an embedding
 * route and keep it through persistence. Profile migration takes an exclusive
 * lease, waits for existing writers, and blocks new writers until every Agent
 * transaction has finished or the migration has failed safely.
 */

export interface RagIndexWriterLease {
  release(): void;
}

export type RagIndexMigrationLease = RagIndexWriterLease;

class Lease implements RagIndexWriterLease {
  private released = false;

  constructor(private readonly onRelease: () => void) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease();
  }

  isReleased(): boolean {
    return this.released;
  }
}

export class RagIndexCoordinator {
  private activeWriterCount = 0;
  private activeMigrationLease: Lease | null = null;
  private readonly writerWaiters: Array<(lease: RagIndexWriterLease) => void> = [];
  private readonly migrationWaiters: Array<(lease: RagIndexMigrationLease) => void> = [];

  acquireWriter(): Promise<RagIndexWriterLease> {
    if (!this.activeMigrationLease && this.migrationWaiters.length === 0) {
      this.activeWriterCount++;
      return Promise.resolve(this.createWriterLease());
    }

    return new Promise((resolve) => {
      this.writerWaiters.push(resolve);
    });
  }

  acquireMigration(): Promise<RagIndexMigrationLease> {
    if (!this.activeMigrationLease && this.activeWriterCount === 0) {
      const lease = this.createMigrationLease();
      this.activeMigrationLease = lease;
      return Promise.resolve(lease);
    }

    return new Promise((resolve) => {
      this.migrationWaiters.push(resolve);
    });
  }

  ownsActiveMigrationLease(lease: RagIndexMigrationLease | undefined): boolean {
    return Boolean(
      lease && lease === this.activeMigrationLease && !this.activeMigrationLease.isReleased()
    );
  }

  private createWriterLease(): Lease {
    return new Lease(() => {
      this.activeWriterCount = Math.max(0, this.activeWriterCount - 1);
      this.drainWaiters();
    });
  }

  private createMigrationLease(): Lease {
    const lease = new Lease(() => {
      if (this.activeMigrationLease === lease) this.activeMigrationLease = null;
      this.drainWaiters();
    });
    return lease;
  }

  private drainWaiters(): void {
    if (this.activeMigrationLease) return;

    if (this.activeWriterCount === 0 && this.migrationWaiters.length > 0) {
      const resolve = this.migrationWaiters.shift();
      if (!resolve) return;
      const lease = this.createMigrationLease();
      this.activeMigrationLease = lease;
      resolve(lease);
      return;
    }

    if (this.migrationWaiters.length === 0 && this.writerWaiters.length > 0) {
      const waiters = this.writerWaiters.splice(0);
      this.activeWriterCount += waiters.length;
      for (const resolve of waiters) resolve(this.createWriterLease());
    }
  }
}

export const ragIndexCoordinator = new RagIndexCoordinator();
