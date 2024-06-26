import * as BN from 'bn.js';
import { createHash } from 'crypto';
import {
  IStorageManager,
  SwapContract,
  ChainSwapType,
  TokenAddress,
  IntermediaryReputationType,
  SwapCommitStatus,
  SignatureVerificationError,
  CannotInitializeATAError,
  SwapDataVerificationError,
  RelaySynchronizer,
} from '@onenesslabs/crosslightning-base';
import { BigNumber, Contract, Signer, UnsignedTransaction } from 'ethers';
import { EVMBtcRelay } from '../btcrelay/EVMBtcRelay';
import { Interface } from 'ethers/lib/utils';
import { swapContract } from './contract/swapContract';
import { EVMSwapData } from './EVMSwapData';
import { erc20Abi } from './erc20/erc20Abi';
import * as utils from 'ethers/lib/utils';
import { Buffer } from 'buffer';
import { EVMBtcStoredHeader } from '../btcrelay/headers/EVMBtcStoredHeader';

const STATE_SEED = 'state';
const VAULT_SEED = 'vault';
const USER_VAULT_SEED = 'uservault';
const AUTHORITY_SEED = 'authority';
const TX_DATA_SEED = 'data';

const WETH_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'; //Matic WMATIC

const LOG_FETCH_LIMIT = 2500;

const GAS_CLAIM_WITH_TX_DATA_BASE = 200000;
const GAS_CLAIM_WITH_TX_DATA_PER_TX_BYTE = 100;

const GAS_CLAIM_WITH_SECRET = 150000;
const GAS_CLAIM_INIT = 150000;
const GAS_INIT = 100000;
const GAS_REFUND = 100000;
const GAS_REFUND_WITH_AUTH = 120000;

const MAX_ALLOWANCE = BigNumber.from(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

class EVMPreFetchData { }
class EVMPreFetchVerification { }

export class EVMSwapProgram
  implements
  SwapContract<
    EVMSwapData,
    UnsignedTransaction,
    EVMPreFetchData,
    EVMPreFetchVerification
  > {
  private static getSignatureStruct(
    signature: string,
    timeout: string
  ): {
    r: string;
    s: string;
    vAndTimeout: BigNumber;
  } {
    const sig = utils.splitSignature(signature);
    return {
      r: sig.r,
      s: sig.s,
      vAndTimeout: BigNumber.from(timeout)
        .shl(8)
        .or(BigNumber.from(sig.v).and(BigNumber.from(0xff))),
    };
  }

  readonly claimWithSecretTimeout: number = 45;
  readonly claimWithTxDataTimeout: number = 120;
  readonly refundTimeout: number = 45;

  readonly claimGracePeriod: number = 10 * 60;
  readonly refundGracePeriod: number = 10 * 60;
  readonly authGracePeriod: number = 5 * 60;

  private readonly signer: Signer;
  private address: string;
  readonly contract: Contract;
  readonly contractInterface: Interface;

  readonly btcRelay: EVMBtcRelay<any>;

  private readonly logBlocksLimit: number;

  constructor(
    signer: Signer,
    btcRelay: EVMBtcRelay<any>,
    swapContractAddress: string,
    logBlocksLimit?: number
  ) {
    this.signer = signer;
    this.btcRelay = btcRelay;

    this.contract = new Contract(swapContractAddress, swapContract.abi, signer);
    this.contractInterface = new Interface(swapContract.abi);

    this.logBlocksLimit = logBlocksLimit || LOG_FETCH_LIMIT;
  }

  getNativeCurrencyAddress() {
    return ZERO_ADDRESS;
  }

  getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer {
    const amountBuffer = Buffer.from(
      (amount.toString(16) as string).padStart(16, '0'),
      'hex'
    ).reverse();
    const txoHash = utils.solidityKeccak256(
      ['bytes'],
      ['0x' + Buffer.concat([amountBuffer, outputScript]).toString('hex')]
    );

    const nonceHexString = (nonce.toString(16) as string).padStart(16, '0');

    const hash = utils.solidityKeccak256(
      ['bytes'],
      ['0x' + nonceHexString + txoHash.substring(2)]
    );

    return Buffer.from(hash.substring(2), 'hex');
  }

  async start(): Promise<void> {
    this.address = await this.signer.getAddress();
  }

  areWeClaimer(swapData: EVMSwapData): boolean {
    return swapData.claimer === this.address;
  }

  areWeOfferer(swapData: EVMSwapData): boolean {
    return swapData.offerer === this.address;
  }

  async getBalance(token: string, inContract: boolean): Promise<BN> {
    if (inContract) {
      const balance: BigNumber = await this.contract.balanceOf(
        this.address,
        token
      );
      return new BN(balance.toString());
    } else {
      let balance: BigNumber;
      if (token === ZERO_ADDRESS) {
        balance = await this.signer.provider.getBalance(this.address);
      } else {
        const contract: Contract = new Contract(
          token,
          erc20Abi,
          this.signer.provider
        );
        balance = await contract.balanceOf(this.address);
      }
      return new BN(balance.toString());
    }
  }

  async getCommitStatus(data: EVMSwapData): Promise<SwapCommitStatus> {
    const commitedHash: string = await this.contract.getCommitment(
      data.paymentHash
    );

    const commitNum: BigNumber = BigNumber.from(commitedHash);
    if (commitNum.eq(BigNumber.from(0x100))) {
      //Success
      return SwapCommitStatus.PAID;
    }
    if (commitNum.lt(BigNumber.from(0x100))) {
      //Success
      if (this.isExpired(data)) {
        return SwapCommitStatus.EXPIRED;
      }
      return SwapCommitStatus.NOT_COMMITED;
    }

    if (commitedHash === data.getCommitHash()) {
      if (this.areWeOfferer(data)) {
        if (this.isExpired(data)) {
          return SwapCommitStatus.REFUNDABLE;
        }
      }

      return SwapCommitStatus.COMMITED;
    } else {
      if (this.areWeOfferer(data)) {
        if (this.isExpired(data)) {
          return SwapCommitStatus.EXPIRED;
        }
      }

      return SwapCommitStatus.NOT_COMMITED;
    }
  }

  async getPaymentHashStatus(paymentHash: string): Promise<SwapCommitStatus> {
    const commitedHash: string = await this.contract.getCommitment(
      '0x' + paymentHash
    );

    const commitNum: BigNumber = BigNumber.from(commitedHash);
    if (commitNum.eq(BigNumber.from(0x100))) {
      return SwapCommitStatus.PAID;
    } else if (commitNum.lt(BigNumber.from(0x100))) {
      return SwapCommitStatus.NOT_COMMITED;
    } else {
      return SwapCommitStatus.COMMITED;
    }
  }

  getMessage(swapData: EVMSwapData, prefix: string, timeout: string): Buffer {
    const encoded = utils.solidityPack(
      ['bytes', 'bytes32', 'uint64'],
      [
        '0x' + Buffer.from(prefix).toString('hex'),
        swapData.getCommitHash(),
        BigNumber.from(timeout),
      ]
    );

    const messageBuffer = utils.solidityKeccak256(['bytes'], [encoded]);

    return Buffer.from(messageBuffer.substring(2), 'hex');
  }

  private getClaimInitMessage(
    swapData: EVMSwapData,
    nonce: number,
    prefix: string,
    timeout: string
  ): Buffer {
    return this.getMessage(swapData, prefix, timeout);
  }

  async getClaimInitSignature(
    swapData: EVMSwapData,
    authorizationTimeout: number
  ): Promise<{
    nonce: number;
    prefix: string;
    timeout: string;
    signature: string;
  }> {
    const authPrefix = 'claim_initialize';
    const authTimeout = Math.floor(Date.now() / 1000) + authorizationTimeout;

    const messageBuffer = this.getClaimInitMessage(
      swapData,
      swapData.getIndex(),
      authPrefix,
      authTimeout.toString()
    );
    const signature = await this.signer.signMessage(messageBuffer);

    return {
      nonce: swapData.getIndex(),
      prefix: authPrefix,
      timeout: authTimeout.toString(10),
      signature: signature,
    };
  }

  async isValidClaimInitAuthorization(
    data: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    nonce: number
  ): Promise<Buffer> {
    if (prefix !== 'claim_initialize') {
      throw new SignatureVerificationError('Invalid prefix');
    }

    const expiryTimestamp: BN = new BN(timeout);
    const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

    const isExpired = expiryTimestamp
      .sub(currentTimestamp)
      .lt(new BN(this.authGracePeriod));

    if (isExpired) {
      throw new SignatureVerificationError('Authorization expired!');
    }

    //Check correctness of nonce
    const commitment: string = await this.contract.getCommitment(
      data.paymentHash
    );
    const commitNum: BigNumber = BigNumber.from(commitment);

    if (!commitNum.eq(BigNumber.from(data.getIndex()))) {
      throw new SignatureVerificationError('Invalid nonce!');
    }

    const messageBuffer = this.getClaimInitMessage(
      data,
      nonce,
      prefix,
      timeout
    );

    const recoveredAddress: string = utils.verifyMessage(
      messageBuffer,
      signature
    );

    const invalidSignature =
      recoveredAddress.toLowerCase() !== data.claimer.toLowerCase();
    if (invalidSignature) {
      throw new SignatureVerificationError('Invalid signature!');
    }

    return messageBuffer;
  }

  async getClaimInitAuthorizationExpiry(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string
    // nonce: number
  ): Promise<number> {
    const now = Date.now();

    const expiry = (parseInt(timeout) - this.authGracePeriod) * 1000;

    if (expiry < now) {
      return 0;
    }

    return expiry;
  }

  async isClaimInitAuthorizationExpired(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string
    // nonce: number
  ): Promise<boolean> {
    if ((parseInt(timeout) + this.authGracePeriod) * 1000 < Date.now())
      return true;
    return false;
  }

  private getInitMessage(
    swapData: EVMSwapData,
    nonce: number,
    prefix: string,
    timeout: string
  ): Buffer {
    return this.getMessage(swapData, prefix, timeout);
  }

  async getInitSignature(
    swapData: EVMSwapData,
    authorizationTimeout: number
  ): Promise<{
    nonce: number;
    prefix: string;
    timeout: string;
    signature: string;
  }> {
    const authPrefix = 'initialize';
    const authTimeout = Math.floor(Date.now() / 1000) + authorizationTimeout;

    const messageBuffer = this.getInitMessage(
      swapData,
      swapData.getIndex(),
      authPrefix,
      authTimeout.toString(10)
    );
    const signature = await this.signer.signMessage(messageBuffer);

    return {
      nonce: swapData.getIndex(),
      prefix: authPrefix,
      timeout: authTimeout.toString(10),
      signature: signature,
    };
  }

  async isValidInitAuthorization(
    data: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    nonce: number
  ): Promise<Buffer> {
    if (prefix !== 'initialize') {
      throw new SignatureVerificationError('Invalid prefix');
    }

    const expiryTimestamp: BN = new BN(timeout);
    const currentTimestamp: BN = new BN(Math.floor(Date.now() / 1000));

    const isExpired = expiryTimestamp
      .sub(currentTimestamp)
      .lt(new BN(this.authGracePeriod));

    if (isExpired) {
      throw new SignatureVerificationError('Authorization expired!');
    }

    const swapWillExpireTooSoon = data
      .getExpiry()
      .sub(currentTimestamp)
      .lt(new BN(this.authGracePeriod).add(new BN(this.claimGracePeriod)));

    if (swapWillExpireTooSoon) {
      throw new SignatureVerificationError('Swap will expire too soon!');
    }

    //Check correctness of nonce
    const commitment: string = await this.contract.getCommitment(
      data.paymentHash
    );
    const commitNum: BigNumber = BigNumber.from(commitment);

    if (!commitNum.eq(BigNumber.from(data.getIndex()))) {
      throw new SignatureVerificationError('Invalid nonce!');
    }

    const messageBuffer = this.getInitMessage(data, nonce, prefix, timeout);

    const recoveredAddress: string = utils.verifyMessage(
      messageBuffer,
      signature
    );

    const invalidSignature =
      recoveredAddress.toLowerCase() !== data.offerer.toLowerCase();
    if (invalidSignature) {
      throw new SignatureVerificationError('Invalid signature!');
    }

    return messageBuffer;
  }

  async getInitAuthorizationExpiry(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string
    // nonce: number
  ): Promise<number> {
    const now = Date.now();

    const expiry = (parseInt(timeout) - this.authGracePeriod) * 1000;

    if (expiry < now) {
      return 0;
    }

    return expiry;
  }

  async isInitAuthorizationExpired(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string
    // nonce: number
  ): Promise<boolean> {
    if ((parseInt(timeout) + this.authGracePeriod) * 1000 < Date.now())
      return true;
    return false;
  }

  private getRefundMessage(
    swapData: EVMSwapData,
    prefix: string,
    timeout: string
  ): Buffer {
    return this.getMessage(swapData, prefix, timeout);
  }

  async getRefundSignature(
    swapData: EVMSwapData,
    authorizationTimeout: number
  ): Promise<{ prefix: string; timeout: string; signature: string }> {
    const authPrefix = 'refund';
    const authTimeout = Math.floor(Date.now() / 1000) + authorizationTimeout;

    const messageBuffer = this.getRefundMessage(
      swapData,
      authPrefix,
      authTimeout.toString(10)
    );
    const signature = await this.signer.signMessage(messageBuffer);

    return {
      prefix: authPrefix,
      timeout: authTimeout.toString(10),
      signature: signature,
    };
  }

  isValidRefundAuthorization(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string
  ): Promise<Buffer> {
    if (prefix !== 'refund') {
      throw new SignatureVerificationError('Invalid prefix');
    }

    const expiryTimestamp = new BN(timeout);
    const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

    const isExpired = expiryTimestamp
      .sub(currentTimestamp)
      .lt(new BN(this.authGracePeriod));

    if (isExpired) {
      throw new SignatureVerificationError('Authorization expired!');
    }

    const messageBuffer = this.getRefundMessage(swapData, prefix, timeout);

    const recoveredAddress: string = utils.verifyMessage(
      messageBuffer,
      signature
    );

    const invalidSignature =
      recoveredAddress.toLowerCase() !== swapData.claimer.toLowerCase();
    if (invalidSignature) {
      throw new SignatureVerificationError('Invalid signature!');
    }
    return Promise.resolve(messageBuffer);
  }

  getDataSignature(data: Buffer): Promise<string> {
    const buff = createHash('sha256').update(data).digest();
    return this.signer.signMessage(buff);
  }

  isValidDataSignature(
    data: Buffer,
    signature: string,
    publicKey: string
  ): Promise<boolean> {
    const hash = createHash('sha256').update(data).digest();
    const recoveredAddress = utils.verifyMessage(hash, signature);

    return Promise.resolve(
      recoveredAddress.toLowerCase() === publicKey.toLowerCase()
    );
  }

  isClaimable(data: EVMSwapData): Promise<boolean> {
    if (!this.areWeClaimer(data)) {
      return Promise.resolve(false);
    }

    if (this.isExpired(data)) {
      return Promise.resolve(false);
    }

    return this.isCommited(data);
  }

  async isCommited(swapData: EVMSwapData): Promise<boolean> {
    const commitment: string = await this.contract.getCommitment(
      swapData.paymentHash
    );
    return commitment === swapData.getCommitHash();
  }

  isExpired(data: EVMSwapData): boolean {
    let currentTimestamp: BN = new BN(0);
    if (this.areWeOfferer(data)) {
      currentTimestamp = new BN(
        Math.floor(Date.now() / 1000) - this.refundGracePeriod
      );
    }
    if (this.areWeClaimer(data)) {
      currentTimestamp = new BN(
        Math.floor(Date.now() / 1000) + this.claimGracePeriod
      );
    }
    return data.getExpiry().lt(currentTimestamp);
  }

  isRequestRefundable(data: EVMSwapData): Promise<boolean> {
    if (!this.areWeOfferer(data)) {
      return Promise.resolve(false);
    }

    const currentTimestamp = new BN(
      Math.floor(Date.now() / 1000) - this.refundGracePeriod
    );

    const isExpired = data.getExpiry().lt(currentTimestamp);

    if (!isExpired) return Promise.resolve(false);

    return this.isCommited(data);
  }

  //TODO: Should not be used unless necessary, might take a long time time to retrieve the data
  async getCommitedData(paymentHashHex: string): Promise<EVMSwapData> {
    const commitment: string = await this.contract.getCommitment(
      '0x' + paymentHashHex
    );
    const commitNum: BigNumber = BigNumber.from(commitment);

    if (commitNum.lte(BigNumber.from(0x100))) {
      return null;
    }

    const topicFilter = [
      utils.id(
        'Initialize(address,address,bytes32,(address,address,address,uint256,bytes32,uint256,uint256,uint256),bytes32)'
      ),
      null,
      null,
      '0x' + paymentHashHex,
    ];

    console.log('Topic filter: ', topicFilter);

    let currentBlock = (await this.signer.provider.getBlockNumber()) - 1;
    let swapData: EVMSwapData = null;
    while (swapData == null) {
      const params = {
        address: this.contract.address,
        topics: topicFilter,
        fromBlock: currentBlock - this.logBlocksLimit,
        toBlock: currentBlock,
      };
      const logs = await this.signer.provider.getLogs(params);
      for (let log of logs) {
        const event = this.contractInterface.parseLog(log);
        const data = event.args.data;
        const _swapData = new EVMSwapData(data);
        _swapData.txoHash = event.args.txoHash;
        if (_swapData.getCommitHash() === commitment) swapData = _swapData;
      }
      currentBlock -= this.logBlocksLimit;
      if (swapData == null) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      }
    }

    return swapData;
  }

  static typeToKind(type: ChainSwapType): number {
    switch (type) {
      case ChainSwapType.HTLC:
        return 0;
      case ChainSwapType.CHAIN:
        return 1;
      case ChainSwapType.CHAIN_NONCED:
        return 2;
      case ChainSwapType.CHAIN_TXID:
        return 3;
    }

    return null;
  }

  async createSwapData(
    type: ChainSwapType,
    offerer: string,
    claimer: string,
    token: string,
    amount: BN,
    paymentHash: string,
    sequence: BN,
    expiry: BN,
    escrowNonce: BN,
    confirmations: number,
    payIn: boolean,
    payOut: boolean,
    securityDeposit: BN,
    claimerBounty: BN
  ): Promise<EVMSwapData> {
    const commitment: string = await this.contract.getCommitment(
      '0x' + paymentHash
    );
    const commitNum: BigNumber = BigNumber.from(commitment);
    if (commitNum.gte(BigNumber.from(0x100))) {
      throw new Error('Already committed or already paid');
    }
    return new EVMSwapData(
      offerer,
      claimer,
      token,
      amount == null ? null : BigNumber.from(amount.toString(10)),
      paymentHash == null ? null : '0x' + paymentHash,
      expiry == null ? null : BigNumber.from(expiry.toString(10)),
      escrowNonce == null ? null : BigNumber.from(escrowNonce.toString(10)),
      confirmations,
      EVMSwapProgram.typeToKind(type),
      payIn,
      payOut,
      securityDeposit == null
        ? null
        : BigNumber.from(securityDeposit.toString(10)),
      claimerBounty == null ? null : BigNumber.from(claimerBounty.toString(10)),
      commitNum.toNumber(),
      null
    );
  }

  //TODO: Implement abortSignal
  async sendAndConfirm(
    txs: UnsignedTransaction[],
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal,
    parallel?: boolean,
    onBeforePublish?: (txId: string, rawTx: string) => Promise<void>
  ): Promise<string[]> {
    const txIds = [];
    let resp = null;

    if (!parallel) {
      for (let tx of txs) {
        if (resp != null) {
          const receipt = await this.signer.provider.waitForTransaction(
            resp.hash
          );
          if (!receipt.status) {
            throw new Error(
              'Transaction reverted, txId: ' + receipt.transactionHash
            );
          }
        }
        const anySigner: any = this.signer;
        if (anySigner.type === 'crosslightning-evm-signer') {
          resp = await anySigner.sendTransaction(tx, onBeforePublish);
        } else {
          resp = await this.signer.sendTransaction(tx);
        }
        txIds.push(resp.hash);
      }
    } else {
      for (let tx of txs) {
        const anySigner: any = this.signer;
        if (anySigner.type === 'crosslightning-evm-signer') {
          resp = await anySigner.sendTransaction(tx, onBeforePublish);
        } else {
          resp = await this.signer.sendTransaction(tx);
        }
        txIds.push(resp.hash);
      }
    }

    if (waitForConfirmation) {
      const receipt = await this.signer.provider.waitForTransaction(resp.hash);
      if (!receipt.status) {
        throw new Error(
          'Transaction reverted, txId: ' + receipt.transactionHash
        );
      }
    }

    return txIds;
  }

  async claimWithSecret(
    swapData: EVMSwapData,
    secret: string,
    checkExpiry?: boolean,
    initAta?: boolean,
    waitForConfirmation?,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const result = await this.txsClaimWithSecret(
      swapData,
      secret,
      checkExpiry,
      initAta
    );

    const [signature] = await this.sendAndConfirm(
      result,
      waitForConfirmation,
      abortSignal
    );

    console.log(
      '[To BTCLN: Solana.PaymentResult] Transaction sent: ',
      signature
    );
    return signature;
  }

  async txsClaimWithSecret(
    swapData: EVMSwapData,
    secret: string,
    checkExpiry?: boolean,
    initAta?: boolean
  ): Promise<UnsignedTransaction[]> {
    if (checkExpiry) {
      const expiryTimestamp = swapData.getExpiry();
      const currentTimestamp = Math.floor(Date.now() / 1000);

      console.log(
        '[EVM.PaymentRequest] Expiry time: ',
        expiryTimestamp.toString()
      );

      if (
        expiryTimestamp
          .sub(new BN(currentTimestamp))
          .lt(new BN(this.claimGracePeriod))
      ) {
        console.error(
          '[EVM.PaymentRequest] Not enough time to reliably pay the invoice'
        );
        throw new SwapDataVerificationError(
          'Not enough time to reliably pay the invoice'
        );
      }
    }

    const tx: UnsignedTransaction =
      await this.contract.populateTransaction.claimer_claim(
        swapData,
        '0x' + secret
      );

    tx.gasLimit = GAS_CLAIM_WITH_SECRET;

    return [tx];
  }

  async claimWithTxData(
    swapData: EVMSwapData,
    blockheight: number,
    tx: { blockhash: string; confirmations: number; txid: string; hex: string },
    vout: number,
    commitedHeader?: EVMBtcStoredHeader,
    synchronizer?: RelaySynchronizer<any, UnsignedTransaction, any>,
    initAta?: boolean,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const txs = await this.txsClaimWithTxData(
      swapData,
      blockheight,
      tx,
      vout,
      commitedHeader,
      synchronizer,
      initAta
    );

    if (txs == null)
      throw new Error('Cannot claim due to BTC Relay not being synchronized');

    const [signature] = await this.sendAndConfirm(
      txs,
      waitForConfirmation,
      abortSignal,
      true
    );

    return signature;
  }

  //TODO: Check if tx really claims paymentHash
  async txsClaimWithTxData(
    swapData: EVMSwapData,
    blockheight: number,
    tx: { blockhash: string; confirmations: number; txid: string; hex: string },
    vout: number,
    commitedHeader?: EVMBtcStoredHeader,
    synchronizer?: RelaySynchronizer<any, UnsignedTransaction, any>,
    initAta?: boolean
  ): Promise<UnsignedTransaction[] | null> {
    const merkleProof = await this.btcRelay.bitcoinRpc.getMerkleProof(
      tx.txid,
      tx.blockhash
    );

    const txs: UnsignedTransaction[] = [];

    if (synchronizer == null) {
      if (commitedHeader == null)
        try {
          const result = await this.btcRelay.retrieveLogAndBlockheight(
            { blockhash: tx.blockhash, height: merkleProof.blockheight },
            blockheight + swapData.getConfirmations() - 1
          );
          if (result == null) return null;
          commitedHeader = result.header;
        } catch (e) {
          console.error(e);
        }

      console.log('[Solana.Claim] Commited header retrieved: ', commitedHeader);

      if (commitedHeader == null) return null;
    } else {
      if (commitedHeader == null) {
        const requiredBlockheight =
          merkleProof.blockheight + swapData.getConfirmations() - 1;

        const result = await this.btcRelay.retrieveLogAndBlockheight({
          blockhash: tx.blockhash,
          height: merkleProof.blockheight,
        });

        commitedHeader = result.header;
        if (result.height < requiredBlockheight) {
          //Need to synchronize
          //TODO: We don't have to synchronize to tip, only to our required blockheight
          const resp = await synchronizer.syncToLatestTxs();
          console.log(
            'BTC Relay not synchronized to required blockheight, synchronizing ourselves in ' +
            resp.txs.length +
            ' txs'
          );
          console.log(
            'BTC Relay computed header map: ',
            resp.computedHeaderMap
          );
          if (commitedHeader == null) {
            //Retrieve computed header
            commitedHeader = resp.computedHeaderMap[merkleProof.blockheight];
          }
          resp.txs.forEach((tx) => txs.push(tx));
        }
      }
    }

    console.log('[To BTC: Solana.Claim] Merkle proof computed: ', merkleProof);

    console.log('[To BTC: Solana.Claim] Writing transaction data: ', tx.hex);

    const evmTx: UnsignedTransaction =
      await this.contract.populateTransaction.claimer_claimWithTxData(
        swapData,
        BigNumber.from(vout),
        '0x' + tx.hex,
        {
          blockheight: BigNumber.from(merkleProof.blockheight),
          txPos: BigNumber.from(merkleProof.pos),
          merkleProof: '0x' + Buffer.concat(merkleProof.merkle).toString('hex'),
          committedHeader: commitedHeader,
        }
      );

    evmTx.gasLimit = BigNumber.from(
      GAS_CLAIM_WITH_TX_DATA_BASE +
      (GAS_CLAIM_WITH_TX_DATA_PER_TX_BYTE * tx.hex.length) / 2
    );

    txs.push(evmTx);

    return txs;
  }

  async refund(
    swapData: EVMSwapData,
    check?: boolean,
    initAta?: boolean,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    let result = await this.txsRefund(swapData);

    const [signature] = await this.sendAndConfirm(
      result,
      waitForConfirmation,
      abortSignal
    );

    return signature;
  }

  async txsRefund(
    swapData: EVMSwapData,
    check?: boolean,
    initAta?: boolean
  ): Promise<UnsignedTransaction[]> {
    if (check) {
      if (!(await this.isRequestRefundable(swapData))) {
        throw new SwapDataVerificationError('Not refundable yet!');
      }
    }

    const tx = await this.contract.populateTransaction.offerer_refund(swapData);

    tx.gasLimit = BigNumber.from(GAS_REFUND);

    return [tx];
  }

  async refundWithAuthorization(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    check?: boolean,
    initAta?: boolean,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    let result = await this.txsRefundWithAuthorization(
      swapData,
      timeout,
      prefix,
      signature,
      check,
      initAta
    );

    const [txSignature] = await this.sendAndConfirm(
      result,
      waitForConfirmation,
      abortSignal
    );

    return txSignature;
  }

  async txsRefundWithAuthorization(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    check?: boolean,
    initAta?: boolean
  ): Promise<UnsignedTransaction[]> {
    if (check) {
      if (!(await this.isCommited(swapData))) {
        throw new SwapDataVerificationError('Not correctly committed');
      }
    }

    const sig = utils.splitSignature(signature);

    const tx = await this.contract.populateTransaction.offerer_refundWithAuth(
      swapData,
      EVMSwapProgram.getSignatureStruct(signature, timeout)
    );

    tx.gasLimit = BigNumber.from(GAS_REFUND_WITH_AUTH);

    return [tx];
  }

  async initPayIn(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    waitForConfirmation?: boolean,
    skipChecks?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    let result = await this.txsInitPayIn(swapData, timeout, prefix, signature);

    const [txSignature] = await this.sendAndConfirm(
      result,
      waitForConfirmation,
      abortSignal,
      true
    );

    return txSignature;
  }

  async txsInitPayIn(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string
  ): Promise<UnsignedTransaction[]> {
    const payStatus = await this.getPaymentHashStatus(swapData.getHash());

    if (payStatus !== SwapCommitStatus.NOT_COMMITED) {
      throw new SwapDataVerificationError(
        'Invoice already being paid for or paid'
      );
    }

    const txs: UnsignedTransaction[] = [];

    if (swapData.token !== ZERO_ADDRESS) {
      const tokenContract: Contract = new Contract(
        swapData.token,
        erc20Abi,
        this.signer
      );
      const allowance: BigNumber = await tokenContract.allowance(
        swapData.offerer,
        this.contract.address
      );

      if (allowance.lt(swapData.amount)) {
        //Increase allowance
        const allowanceTx = await tokenContract.populateTransaction.approve(
          this.contract.address,
          MAX_ALLOWANCE
        );
        allowanceTx.gasLimit = BigNumber.from(80000);
        txs.push(allowanceTx);
      }
    }

    const tx = await this.contract.populateTransaction.offerer_claimInit(
      swapData,
      EVMSwapProgram.getSignatureStruct(signature, timeout),
      '0x0000000000000000000000000000000000000000000000000000000000000000'
    );
    if (swapData.token === ZERO_ADDRESS) {
      tx.value = swapData.amount;
    }
    tx.gasLimit = BigNumber.from(GAS_CLAIM_INIT);
    txs.push(tx);

    return txs;
  }

  async init(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    txoHash?: Buffer,
    waitForConfirmation?: boolean,
    skipChecks?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    let result = await this.txsInit(
      swapData,
      timeout,
      prefix,
      signature,
      txoHash
    );

    const [txSignature] = await this.sendAndConfirm(
      result,
      waitForConfirmation,
      abortSignal
    );

    return txSignature;
  }

  async txsInit(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    txoHash?: Buffer
  ): Promise<UnsignedTransaction[]> {
    const tx = await this.contract.populateTransaction.offerer_init(
      swapData,
      EVMSwapProgram.getSignatureStruct(signature, timeout),
      txoHash != null
        ? '0x' + txoHash.toString('hex')
        : '0x0000000000000000000000000000000000000000000000000000000000000000'
    );

    tx.value = swapData.getTotalDepositBigNumber();
    tx.gasLimit = BigNumber.from(GAS_INIT);

    return [tx];
  }

  async initAndClaimWithSecret(
    swapData: EVMSwapData,
    timeout: string,
    prefix: string,
    signature: string,
    secret: string,
    skipChecks?: boolean,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string[]> {
    const [txCommit] = await this.txsInit(swapData, timeout, prefix, signature);
    const [txClaim] = await this.txsClaimWithSecret(
      swapData,
      secret,
      true,
      true
    );

    return await this.sendAndConfirm(
      [txCommit, txClaim],
      waitForConfirmation,
      abortSignal,
      false
    );
  }

  getAddress(): string {
    return this.address;
  }

  isValidAddress(address: string): boolean {
    try {
      return utils.isAddress(address);
    } catch (e) {
      return false;
    }
  }

  async getIntermediaryReputation(
    address: string,
    token: string
  ): Promise<IntermediaryReputationType> {
    const reputationResponse: any[] = await this.contract.getReputation(
      address,
      token
    );

    const response: any = [];
    for (let i = 0; i < 3; i++) {
      const success: BigNumber = reputationResponse[i].success;
      const coopClose: BigNumber = reputationResponse[i].coopClose;
      const failed: BigNumber = reputationResponse[i].failed;
      response[i] = {
        successVolume: new BN(
          success
            .and(
              BigNumber.from(
                '0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
              )
            )
            .toString()
        ),
        successCount: new BN(success.shr(224).toString()),
        failVolume: new BN(
          failed
            .and(
              BigNumber.from(
                '0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
              )
            )
            .toString()
        ),
        failCount: new BN(failed.shr(224).toString()),
        coopCloseVolume: new BN(
          coopClose
            .and(
              BigNumber.from(
                '0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
              )
            )
            .toString()
        ),
        coopCloseCount: new BN(coopClose.shr(224).toString()),
      };
    }

    return response;
  }

  async getIntermediaryBalance(address: string, token: string): Promise<BN> {
    const balance: BigNumber = await this.contract.balanceOf(address, token);
    return new BN(balance.toString());
  }

  toTokenAddress(address: string): string {
    return address;
  }

  async getClaimFee(): Promise<BN> {
    const gasPrice: BigNumber = await this.signer.provider.getGasPrice();
    const gasLimit: BigNumber = BigNumber.from(GAS_CLAIM_WITH_SECRET);
    const gasFee: BigNumber = gasPrice.mul(gasLimit);
    return new BN(gasFee.toString());
  }

  /**
   * Get the estimated solana fee of the commit transaction
   */
  async getCommitFee(): Promise<BN> {
    const gasPrice: BigNumber = await this.signer.provider.getGasPrice();
    const gasLimit: BigNumber = BigNumber.from(GAS_CLAIM_INIT);
    const gasFee: BigNumber = gasPrice.mul(gasLimit);
    return new BN(gasFee.toString());
  }

  /**
   * Get the estimated solana transaction fee of the refund transaction
   */
  async getRefundFee(): Promise<BN> {
    const gasPrice: BigNumber = await this.signer.provider.getGasPrice();
    const gasLimit: BigNumber = BigNumber.from(GAS_REFUND_WITH_AUTH);
    const gasFee: BigNumber = gasPrice.mul(gasLimit);
    return new BN(gasFee.toString());
  }

  setUsAsClaimer(swapData: EVMSwapData) {
    swapData.claimer = this.address;
    swapData.setPayIn(false);
    swapData.setPayOut(true);
  }

  setUsAsOfferer(swapData: EVMSwapData) {
    swapData.offerer = this.address;
    swapData.setPayIn(true);
  }

  _getAllowance(src: string, token: TokenAddress): Promise<BigNumber> {
    if (ZERO_ADDRESS === token) return Promise.resolve(MAX_ALLOWANCE);
    const tokenContract: Contract = new Contract(token, erc20Abi, this.signer);
    return tokenContract.allowance(src, this.contract.address);
  }

  getAllowance(swapData: EVMSwapData): Promise<BigNumber> {
    return this._getAllowance(swapData.offerer, swapData.token);
  }

  async approveSpend(
    swapData: EVMSwapData,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    if (ZERO_ADDRESS === swapData.token)
      return Promise.resolve(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      );
    const tokenContract: Contract = new Contract(
      swapData.token,
      erc20Abi,
      this.signer
    );
    const allowanceTx = await tokenContract.populateTransaction.approve(
      this.contract.address,
      MAX_ALLOWANCE
    );
    allowanceTx.gasLimit = BigNumber.from(80000);
    const [txId] = await this.sendAndConfirm(
      [allowanceTx],
      waitForConfirmation,
      abortSignal,
      false
    );
    return txId;
  }

  txDeposit(token: any, amount: BN): Promise<UnsignedTransaction> {
    throw new Error('Method not implemented.');
  }

  txTransfer(
    token: any,
    amount: BN,
    dstAddress: string
  ): Promise<UnsignedTransaction> {
    throw new Error('Method not implemented.');
  }

  async withdraw(
    token: TokenAddress,
    amount: BN,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const [txId] = await this.sendAndConfirm(
      await this.txsWithdraw(token, amount),
      waitForConfirmation,
      abortSignal,
      false
    );
    return txId;
  }

  txsWithdraw(token: string, amount: BN): Promise<UnsignedTransaction[]> {
    return this.contract.populateTransaction
      .withdraw(token, BigNumber.from(amount.toString(10)))
      .then((withdrawTx) => {
        withdrawTx.gasLimit = BigNumber.from(100000);
        return [withdrawTx];
      });
  }

  async deposit(
    token: TokenAddress,
    amount: BN,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const txIds = await this.sendAndConfirm(
      await this.txsDeposit(token, amount),
      waitForConfirmation,
      abortSignal,
      true
    );

    return txIds[txIds.length - 1];
  }

  async txsDeposit(token: string, amount: BN): Promise<UnsignedTransaction[]> {
    const depositAmountBN = BigNumber.from(amount.toString(10));
    const allowance = await this._getAllowance(this.getAddress(), token);

    const txs = [];

    if (allowance.lt(depositAmountBN)) {
      const tokenContract: Contract = new Contract(
        token,
        erc20Abi,
        this.signer
      );
      const allowanceTx = await tokenContract.populateTransaction.approve(
        this.contract.address,
        MAX_ALLOWANCE
      );
      allowanceTx.gasLimit = BigNumber.from(80000);
      txs.push(allowanceTx);
    }

    const depositTx = await this.contract.populateTransaction.deposit(
      token,
      depositAmountBN
    );
    depositTx.gasLimit = BigNumber.from(100000);
    txs.push(depositTx);

    return txs;
  }

  async transfer(
    token: TokenAddress,
    amount: BN,
    dstAddress: string,
    waitForConfirmation?: boolean,
    abortSignal?: AbortSignal
  ): Promise<string> {
    const [txId] = await this.sendAndConfirm(
      await this.txsTransfer(token, amount, dstAddress),
      waitForConfirmation,
      abortSignal,
      false
    );

    return txId;
  }

  async txsTransfer(
    token: any,
    amount: BN,
    dstAddress: string
  ): Promise<UnsignedTransaction[]> {
    let transferTx;
    if (ZERO_ADDRESS === token) {
      transferTx = {
        from: this.getAddress(),
        to: dstAddress,
        value: BigNumber.from(amount.toString(10)),
        gasLimit: BigNumber.from(21000),
      };
    } else {
      const tokenContract: Contract = new Contract(
        token,
        erc20Abi,
        this.signer
      );
      transferTx = await tokenContract.populateTransaction.transfer(
        dstAddress,
        BigNumber.from(amount.toString(10))
      );
      transferTx.gasLimit = BigNumber.from(80000);
    }
    return [transferTx];
  }

  serializeTx(tx: UnsignedTransaction): Promise<string> {
    return Promise.resolve(utils.serializeTransaction(tx));
  }

  deserializeTx(txData: string): Promise<UnsignedTransaction> {
    return Promise.resolve(utils.parseTransaction(txData));
  }

  getTxStatus(
    txData: string
  ): Promise<'success' | 'not_found' | 'pending' | 'reverted'> {
    const parsedTx = utils.parseTransaction(txData);
    const txId = parsedTx.hash;
    return this.getTxIdStatus(txId);
  }

  async getTxIdStatus(
    txId: string
  ): Promise<'not_found' | 'pending' | 'success' | 'reverted'> {
    const anySigner: any = this.signer;
    if (anySigner.type === 'crosslightning-evm-signer') {
      if (anySigner.isTxPending(txId)) return 'pending';
    }
    const receipt = await this.signer.provider.getTransactionReceipt(txId);
    if (receipt == null) {
      return 'not_found';
    }
    if (!receipt.status) return 'reverted';
    return 'success';
  }

  onBeforeTxReplace(
    callback: (
      oldTx: string,
      oldTxId: string,
      newTx: string,
      newTxId: string
    ) => Promise<void>
  ): void {
    const anySigner: any = this.signer;
    if (anySigner.type === 'crosslightning-evm-signer') {
      anySigner.onBeforeTxReplace(callback);
      return;
    }
    throw new Error('Unsupported environment');
  }

  offBeforeTxReplace(
    callback: (
      oldTx: string,
      oldTxId: string,
      newTx: string,
      newTxId: string
    ) => Promise<void>
  ): boolean {
    const anySigner: any = this.signer;
    if (anySigner.type === 'crosslightning-evm-signer') {
      return anySigner.offBeforeTxReplace(callback);
    }
    throw new Error('Unsupported environment');
  }
}
