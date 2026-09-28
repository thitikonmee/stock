/** Wire format of a domain event after it leaves the outbox. `id` is the consumer dedupe key. */
export interface EventEnvelope<TPayload = unknown> {
  id: string;
  type: string;
  version: number;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  headers: Record<string, string>;
  payload: TPayload;
}

/** Destination for relayed events (BullMQ today, SQS/Kafka later). */
export interface EventPublisher {
  publish(events: readonly EventEnvelope[]): Promise<void>;
}

/** Test/local publisher that keeps events in memory. */
export class InMemoryPublisher implements EventPublisher {
  readonly published: EventEnvelope[] = [];
  failNext = false;

  async publish(events: readonly EventEnvelope[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('publish failed (simulated)');
    }
    this.published.push(...events);
  }
}
