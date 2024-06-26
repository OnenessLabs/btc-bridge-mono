import { IFromBTCWrapper } from './IFromBTCWrapper';
import { ISwap, PriceInfoType } from '../ISwap';
import * as BN from 'bn.js';
import * as EventEmitter from 'events';
import { SwapType } from '../SwapType';
import { SwapData, TokenAddress } from '@onenesslabs/crosslightning-base';

export abstract class IFromBTCSwap<T extends SwapData> extends ISwap {
  readonly url: string;
  expiry: number;

  //State: PR_PAID
  data: T;
  swapFee: BN;
  prefix: string;
  timeout: string;
  signature: string;
  feeRate: any;

  protected readonly wrapper: IFromBTCWrapper<T>;

  commitTxId: string;
  claimTxId: string;

  /**
   * Swap's event emitter
   *
   * @event IFromBTCSwap<T>#swapState
   * @type {IFromBTCSwap<T>}
   */
  readonly events: EventEmitter;

  protected constructor(
    wrapper: IFromBTCWrapper<T>,
    urlOrObject?: string | any,
    data?: T,
    swapFee?: BN,
    prefix?: string,
    timeout?: string,
    signature?: string,
    feeRate?: any,
    expiry?: number,
    pricing?: PriceInfoType
  ) {
    if (typeof urlOrObject === 'string') {
      super(pricing);
      this.url = urlOrObject;

      this.data = data;
      this.swapFee = swapFee;
      this.prefix = prefix;
      this.timeout = timeout;
      this.signature = signature;
      this.feeRate = feeRate;
      this.expiry = expiry;
    } else {
      super(urlOrObject);
      this.url = urlOrObject.url;

      this.data =
        urlOrObject.data != null
          ? new wrapper.swapDataDeserializer(urlOrObject.data)
          : null;
      this.swapFee =
        urlOrObject.swapFee == null ? null : new BN(urlOrObject.swapFee);
      this.prefix = urlOrObject.prefix;
      this.timeout = urlOrObject.timeout;
      this.signature = urlOrObject.signature;
      this.feeRate = urlOrObject.feeRate;
      this.commitTxId = urlOrObject.commitTxId;
      this.claimTxId = urlOrObject.claimTxId;
      this.expiry = urlOrObject.expiry;
    }
    this.wrapper = wrapper;
    this.events = new EventEmitter();
  }

  /**
   * Returns amount that will be received on Solana
   */
  abstract getOutAmount(): BN;

  /**
   * Returns amount that will be sent on Bitcoin on-chain
   */
  abstract getInAmount(): BN;

  /**
   * Returns calculated fee for the swap
   */
  getFee(): BN {
    return this.swapFee;
  }

  getOutAmountWithoutFee(): BN {
    return this.getOutAmount().add(this.getFee());
  }

  /**
   * A blocking promise resolving when payment was received by the intermediary and client can continue
   * rejecting in case of failure
   *
   * @param abortSignal           Abort signal
   * @param checkIntervalSeconds  How often to poll the intermediary for answer
   * @param updateCallback        Callback called when txId is found, and also called with subsequent confirmations
   */
  abstract waitForPayment(
    abortSignal?: AbortSignal,
    checkIntervalSeconds?: number,
    updateCallback?: (
      txId: string,
      confirmations: number,
      targetConfirmations: number
    ) => void
  ): Promise<void>;

  /**
   * Returns if the swap can be committed
   */
  abstract canCommit(): boolean;

  /**
   * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
   * Important: Make sure this transaction is confirmed and only after it is call claim()
   *
   * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
   * @param abortSignal               Abort signal
   */
  abstract commit(
    noWaitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string>;

  /**
   * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
   * Important: Make sure this transaction is confirmed and only after it is call claim()
   */
  abstract txsCommit(): Promise<any[]>;

  /**
   * Returns a promise that resolves when swap is committed
   *
   * @param abortSignal   AbortSignal
   */
  abstract waitTillCommited(abortSignal?: AbortSignal): Promise<void>;

  /**
   * Returns if the swap can be claimed
   */
  abstract canClaim(): boolean;

  /**
   * Claims and finishes the swap once it was successfully committed on-chain with commit()
   *
   * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
   * @param abortSignal               Abort signal
   */
  abstract claim(
    noWaitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string>;

  /**
   * Claims and finishes the swap once it was successfully committed on-chain with commit()
   */
  abstract txsClaim(): Promise<any[]>;

  /**
   * Returns a promise that resolves when swap is claimed
   *
   * @param abortSignal   AbortSignal
   */
  abstract waitTillClaimed(abortSignal?: AbortSignal): Promise<void>;

  // /**
  //  * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
  //  * If swap is already commited, it just signs and executes the claim transaction
  //  *
  //  * @param signer            Signer to use to send the claim transaction
  //  * @param abortSignal       Abort signal
  //  */
  // commitAndClaim(signer: AnchorProvider, abortSignal?: AbortSignal): Promise<TransactionSignature[]>;

  /**
   * @fires BTCtoSolWrapper#swapState
   * @fires BTCtoSolSwap#swapState
   */
  abstract emitEvent(): void;

  /**
   * Get payment hash
   */
  abstract getPaymentHash(): Buffer;

  /**
   * Returns a string that can be displayed as QR code representation of the address (with bitcoin: or lightning: prefix)
   */
  abstract getQrData(): string;

  /**
   * Returns a bitcoin address/lightning network invoice of the swap.
   */
  abstract getAddress(): string;

  getWrapper(): IFromBTCWrapper<T> {
    return this.wrapper;
  }

  abstract getType(): SwapType;

  save(): Promise<void> {
    return this.wrapper.storage.saveSwapData(this);
  }

  /**
   * Returns the address of the output token
   */
  getToken(): TokenAddress {
    return this.data.getToken();
  }

  serialize(): any {
    const obj = super.serialize();
    return {
      ...obj,

      url: this.url,

      data: this.data != null ? this.data.serialize() : null,
      swapFee: this.swapFee == null ? null : this.swapFee.toString(10),
      prefix: this.prefix,
      timeout: this.timeout,
      signature: this.signature,
      feeRate: this.feeRate == null ? null : this.feeRate,
      commitTxId: this.commitTxId,
      claimTxId: this.claimTxId,
      expiry: this.expiry,
    };
  }

  getCommitFee(): Promise<BN> {
    return this.getWrapper().contract.swapContract.getCommitFee(this.data);
  }

  getClaimFee(): Promise<BN> {
    return this.getWrapper().contract.swapContract.getClaimFee(this.data);
  }

  getSecurityDeposit(): BN {
    return this.data.getSecurityDeposit();
  }

  getTotalDeposit(): BN {
    return this.data.getTotalDeposit();
  }

  getExpiry(): number {
    return this.expiry;
  }

  async refetchPriceData(): Promise<PriceInfoType> {
    if (this.pricingInfo == null) return null;

    const priceData =
      await this.wrapper.contract.swapPrice.isValidAmountReceive(
        this.getInAmount(),
        this.pricingInfo.satsBaseFee,
        this.pricingInfo.feePPM,
        this.data.getAmount(),
        this.data.getToken()
      );

    this.pricingInfo = priceData;

    return priceData;
  }

  abstract isClaimable(): boolean;
}
