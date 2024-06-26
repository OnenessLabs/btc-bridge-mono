import * as BN from 'bn.js';
import {
  SwapData,
  ChainSwapType,
  TokenAddress,
} from '@onenesslabs/crosslightning-base';
import { BigNumber, utils } from 'ethers';

export class EVMSwapData extends SwapData {
  offerer: string;
  claimer: string;
  token: string;
  amount: BigNumber;
  paymentHash: string; //0x prefixed
  data: BigNumber;
  securityDeposit: BigNumber;
  claimerBounty: BigNumber;

  txoHash: string; //0x prefixed

  constructor(
    offerer: string,
    claimer: string,
    token: string,
    amount: BigNumber,
    paymentHash: string,

    expiry: BigNumber,

    nonce: BigNumber,
    confirmations: number,
    kind: number,
    payIn: boolean,
    payOut: boolean,
    securityDeposit: BigNumber,
    claimerBounty: BigNumber,
    index: number,
    txoHash: string
  );

  constructor(data: any);

  constructor(
    offererOrData: string | any,
    claimer?: string,
    token?: string,
    amount?: BigNumber,
    paymentHash?: string,
    expiry?: BigNumber,
    nonce?: BigNumber,
    confirmations?: number,
    kind?: number,
    payIn?: boolean,
    payOut?: boolean,
    securityDeposit?: BigNumber,
    claimerBounty?: BigNumber,
    index?: number,
    txoHash?: string
  ) {
    super();
    if (
      claimer != null ||
      token != null ||
      amount != null ||
      paymentHash != null ||
      expiry != null ||
      txoHash != null ||
      nonce != null ||
      confirmations != null ||
      payOut != null ||
      kind != null ||
      payIn != null ||
      index != null
    ) {
      expiry = expiry || BigNumber.from(0);
      nonce = nonce || BigNumber.from(0);
      confirmations = confirmations || 0;

      this.offerer = offererOrData;
      this.claimer = claimer;
      this.token = token;
      this.amount = amount;
      this.paymentHash = paymentHash;
      this.data = expiry
        .and(BigNumber.from('0xFFFFFFFFFFFFFFFF'))
        .or(nonce.and(BigNumber.from('0xFFFFFFFFFFFFFFFF')).shl(64))
        .or(BigNumber.from(confirmations).and(BigNumber.from(0xffff)).shl(128))
        .or(BigNumber.from(kind).and(BigNumber.from(0xff)).shl(144))
        .or(
          BigNumber.from(payIn ? 1 : 0)
            .and(BigNumber.from(0xff))
            .shl(152)
        )
        .or(
          BigNumber.from(payOut ? 1 : 0)
            .and(BigNumber.from(0xff))
            .shl(160)
        )
        .or(BigNumber.from(index).and(BigNumber.from(0xff)).shl(168));
      this.securityDeposit = securityDeposit;
      this.claimerBounty = claimerBounty;
      this.txoHash = txoHash;
    } else {
      this.offerer = offererOrData.offerer;
      this.claimer = offererOrData.claimer;
      this.token = offererOrData.token;
      this.amount =
        offererOrData.amount == null
          ? null
          : BigNumber.from(offererOrData.amount);
      this.paymentHash = offererOrData.paymentHash;
      this.data =
        offererOrData.data == null ? null : BigNumber.from(offererOrData.data);
      this.securityDeposit =
        offererOrData.securityDeposit == null
          ? null
          : BigNumber.from(offererOrData.securityDeposit);
      this.claimerBounty =
        offererOrData.claimerBounty == null
          ? null
          : BigNumber.from(offererOrData.claimerBounty);
      this.txoHash = offererOrData.txoHash;
    }
  }

  getOfferer(): string {
    return this.offerer;
  }

  setOfferer(newOfferer: string) {
    this.offerer = newOfferer;
  }

  getClaimer(): string {
    return this.claimer;
  }

  setClaimer(newClaimer: string) {
    this.claimer = newClaimer;
  }

  serialize(): any {
    return {
      type: 'evm',
      offerer: this.offerer,
      claimer: this.claimer,
      token: this.token,
      amount: this.amount == null ? null : this.amount.toHexString(),
      paymentHash: this.paymentHash,
      data: this.data == null ? null : this.data.toHexString(),
      securityDeposit:
        this.securityDeposit == null
          ? null
          : this.securityDeposit.toHexString(),
      claimerBounty:
        this.claimerBounty == null ? null : this.claimerBounty.toHexString(),
      txoHash: this.txoHash,
    };
  }

  getAmount(): BN {
    if (this.amount == null) return null;
    return new BN(this.amount.toString());
  }

  getToken(): TokenAddress {
    return this.token;
  }

  isToken(token: string): boolean {
    return this.token.toLowerCase() === token.toLowerCase();
  }

  getKind(): number {
    return this.data.shr(144).and(BigNumber.from(0xff)).toNumber();
  }

  getType(): ChainSwapType {
    switch (this.getKind()) {
      case 0:
        return ChainSwapType.HTLC;
      case 1:
        return ChainSwapType.CHAIN;
      case 2:
        return ChainSwapType.CHAIN_NONCED;
      case 3:
        return ChainSwapType.CHAIN_TXID;
    }
    return null;
  }

  getExpiry(): BN {
    const expiryBigNum = this.data.and(BigNumber.from('0xFFFFFFFFFFFFFFFF'));
    return new BN(expiryBigNum.toString());
  }

  getConfirmations(): number {
    return this.data.shr(128).and(BigNumber.from(0xffff)).toNumber();
  }

  getEscrowNonce(): BN {
    return new BN(
      this.data.shr(64).and(BigNumber.from('0xFFFFFFFFFFFFFFFF')).toString()
    );
  }

  isPayIn(): boolean {
    return this.data.shr(152).and(BigNumber.from('0xFF')).gt(BigNumber.from(0));
  }

  setPayIn(payIn: boolean) {
    this.data = this.data
      .and(
        BigNumber.from(
          '0x00000000000000000000FFFF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
        )
      )
      .or(BigNumber.from(payIn ? 1 : 0).shl(152));
  }

  isPayOut(): boolean {
    return this.data.shr(160).and(BigNumber.from('0xFF')).gt(BigNumber.from(0));
  }

  setPayOut(payOut: boolean) {
    this.data = this.data
      .and(
        BigNumber.from(
          '0x00000000000000000000FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
        )
      )
      .or(BigNumber.from(payOut ? 1 : 0).shl(160));
  }

  getIndex(): number {
    return this.data.shr(168).and(BigNumber.from('0xFF')).toNumber();
  }

  getHash(): string {
    return this.paymentHash == null ? null : this.paymentHash.substring(2);
  }

  getTxoHash(): string {
    return this.txoHash == null ? null : this.txoHash.substring(2);
  }

  setTxoHash(txoHash: string): void {
    if (txoHash == null) {
      this.txoHash = null;
    } else {
      this.txoHash = '0x' + txoHash;
    }
  }

  getBytes(): string {
    return utils.defaultAbiCoder.encode(
      [
        'tuple(address offerer,address claimer,address token,uint256 amount,bytes32 paymentHash,uint256 data,uint256 securityDeposit,uint256 claimerBounty)',
      ],
      [
        {
          offerer: this.offerer,
          claimer: this.claimer,
          token: this.token,
          amount: this.amount,
          paymentHash: this.paymentHash,
          data: this.data,
          securityDeposit: this.securityDeposit,
          claimerBounty: this.claimerBounty,
        },
      ]
    );
  }

  getCommitHash(): string {
    const encoded = this.getBytes();
    return utils.solidityKeccak256(['bytes'], [encoded]);
  }

  getSecurityDeposit(): BN {
    return new BN(this.securityDeposit.toString());
  }

  getClaimerBounty(): BN {
    return new BN(this.claimerBounty.toString());
  }

  getTotalDepositBigNumber(): BigNumber {
    return this.securityDeposit.gt(this.claimerBounty)
      ? this.securityDeposit
      : this.claimerBounty;
  }

  getTotalDeposit(): BN {
    return new BN(this.getTotalDepositBigNumber().toString());
  }

  // --------------
  equals(other: SwapData): boolean {
    // return false;
    throw new Error('api Unsupported');
  }

  getSequence?(): BN {
    // return new BN(0);
    throw new Error('api Unsupported');
  }
}

SwapData.deserializers['evm'] = EVMSwapData;
