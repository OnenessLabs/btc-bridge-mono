import {
  ChainEvents,
  ClaimEvent,
  EventListener,
  InitializeEvent,
  RefundEvent,
  SwapEvent,
} from '@onenesslabs/crosslightning-base';
import { EVMSwapData } from '../swaps/EVMSwapData';
import { providers } from 'ethers';
import { EVMSwapProgram } from '../swaps/EVMSwapProgram';
import { BN } from 'bn.js';

export class EVMChainEventsBrowser implements ChainEvents<EVMSwapData> {
  private readonly listeners: EventListener<EVMSwapData>[] = [];

  private readonly provider: providers.Provider;
  private readonly evmSwapContract: EVMSwapProgram;

  private eventType: { address: string };
  private eventListener: (log: any) => Promise<void>;

  constructor(provider: providers.Provider, evmSwapContract: EVMSwapProgram) {
    this.provider = provider;
    this.evmSwapContract = evmSwapContract;
  }

  init(): Promise<void> {
    this.eventListener = async (log: any) => {
      const event = this.evmSwapContract.contractInterface.parseLog(log);
      let parsedEvent: SwapEvent<EVMSwapData>;
      if (event.name === 'Initialize') {
        const swapData = new EVMSwapData(event.args.data);
        swapData.txoHash = event.args.txoHash;
        // TODO, check sequence
        parsedEvent = new InitializeEvent<EVMSwapData>(
          swapData.getHash(),
          swapData.getSequence(),
          swapData.getTxoHash(),
          swapData.getIndex(),

          async () => {
            return swapData;
          }
        );
      }
      if (event.name === 'Claim') {
        parsedEvent = new ClaimEvent<EVMSwapData>(
          event.args.paymentHash.substring(2),
          // TODO, check sequence
          new BN(0),
          event.args.secret.substring(2)
        );
      }
      if (event.name === 'Refund') {
        parsedEvent = new RefundEvent<EVMSwapData>(
          event.args.paymentHash.substring(2),
          // TODO, check sequence
          new BN(0)
        );
      }

      for (let listener of this.listeners) {
        await listener([parsedEvent]);
      }
    };

    this.eventType = {
      address: this.evmSwapContract.contract.address,
    };

    this.provider.on(this.eventType, this.eventListener);

    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.provider.off(this.eventType, this.eventListener);
  }

  registerListener(cbk: EventListener<EVMSwapData>): void {
    this.listeners.push(cbk);
  }

  unregisterListener(cbk: EventListener<EVMSwapData>): boolean {
    const index = this.listeners.indexOf(cbk);
    if (index >= 0) {
      this.listeners.splice(index, 1);
      return true;
    }
    return false;
  }
}
