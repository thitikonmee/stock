import { Queue, type ConnectionOptions } from 'bullmq';
import type { EventEnvelope, EventPublisher } from './envelope';

/** Which queues receive each event type. Unrouted events are dropped (logged by caller if needed). */
export type EventRoutes = Readonly<Record<string, readonly string[]>>;

/**
 * Publishes outbox events to BullMQ. The envelope id is used as the job id so a re-published
 * batch does not create duplicate jobs while the original job still exists.
 * Note: BullMQ custom job ids must not contain ':' — UUIDs are safe.
 */
export class BullMqPublisher implements EventPublisher {
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly routes: EventRoutes,
    private readonly prefix = 'stockos',
  ) {}

  async publish(events: readonly EventEnvelope[]): Promise<void> {
    const byQueue = new Map<string, EventEnvelope[]>();
    for (const event of events) {
      for (const queueName of this.routes[event.type] ?? []) {
        const list = byQueue.get(queueName) ?? [];
        list.push(event);
        byQueue.set(queueName, list);
      }
    }
    await Promise.all(
      [...byQueue].map(([queueName, list]) =>
        this.queue(queueName).addBulk(
          list.map((e) => ({
            name: e.type,
            data: e,
            opts: { jobId: e.id, removeOnComplete: 1000, removeOnFail: false },
          })),
        ),
      ),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }

  private queue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
      this.queues.set(name, queue);
    }
    return queue;
  }
}
