import { ValidationError } from '@stockos/shared';
import type { ChannelAdapter, ChannelCode } from '../domain/channel-adapter';

/** Maps a channel code to its adapter. New marketplace = write an adapter + register it here;
 *  nothing else in this module (or `orders`/`inventory`) changes (docs/06 §20). */
export class AdapterRegistry {
  private readonly adapters = new Map<ChannelCode, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.code, adapter);
  }

  get(code: ChannelCode): ChannelAdapter {
    const adapter = this.adapters.get(code);
    if (!adapter) throw new ValidationError(`No adapter registered for channel ${code}`);
    return adapter;
  }

  has(code: ChannelCode): boolean {
    return this.adapters.has(code);
  }
}
