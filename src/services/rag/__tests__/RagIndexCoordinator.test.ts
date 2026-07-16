import { describe, expect, it } from 'vitest';
import { RagIndexCoordinator } from '../RagIndexCoordinator';

describe('RagIndexCoordinator', () => {
  it('waits for an active writer before granting an exclusive migration lease', async () => {
    const coordinator = new RagIndexCoordinator();
    const writer = await coordinator.acquireWriter();
    let migrationGranted = false;
    const migrationPromise = coordinator.acquireMigration().then((lease) => {
      migrationGranted = true;
      return lease;
    });

    await Promise.resolve();
    expect(migrationGranted).toBe(false);

    writer.release();
    const migration = await migrationPromise;
    expect(migrationGranted).toBe(true);
    expect(coordinator.ownsActiveMigrationLease(migration)).toBe(true);
    migration.release();
  });

  it('blocks new writers for a queued or active migration', async () => {
    const coordinator = new RagIndexCoordinator();
    const firstWriter = await coordinator.acquireWriter();
    const order: string[] = [];
    const migrationPromise = coordinator.acquireMigration().then((lease) => {
      order.push('migration');
      return lease;
    });
    const nextWriterPromise = coordinator.acquireWriter().then((lease) => {
      order.push('writer');
      return lease;
    });

    firstWriter.release();
    const migration = await migrationPromise;
    expect(order).toEqual(['migration']);

    migration.release();
    const nextWriter = await nextWriterPromise;
    expect(order).toEqual(['migration', 'writer']);
    nextWriter.release();
  });

  it('releases a migration lease idempotently so queued writers always resume', async () => {
    const coordinator = new RagIndexCoordinator();
    const migration = await coordinator.acquireMigration();
    let writerGranted = false;
    const writerPromise = coordinator.acquireWriter().then((lease) => {
      writerGranted = true;
      return lease;
    });

    migration.release();
    migration.release();
    const writer = await writerPromise;
    expect(writerGranted).toBe(true);
    writer.release();
  });
});
