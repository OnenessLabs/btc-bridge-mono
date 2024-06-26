import {
  BitcoinRpc,
  BtcBlock,
  BtcRelay,
  StatePredictorUtils,
} from '@onenesslabs/crosslightning-base';
import { btcRelayContract } from './contract/btcRelayContract';
import { BigNumber, Contract, Signer, UnsignedTransaction } from 'ethers';
import { Interface } from 'ethers/lib/utils';
import { EVMBtcStoredHeader } from './headers/EVMBtcStoredHeader';
import { EVMBtcHeader } from './headers/EVMBtcHeader';
import * as BN from 'bn.js';

const limit = 2500;

const GAS_PER_BLOCKHEADER = 35000;

export class EVMBtcRelay<B extends BtcBlock>
  implements BtcRelay<EVMBtcStoredHeader, UnsignedTransaction, B> {
  provider: Signer;
  contract: Contract;
  contractInterface: Interface;

  bitcoinRpc: BitcoinRpc<B>;

  readonly maxHeadersPerTx: number = 100;
  readonly maxForkHeadersPerTx: number = 50;

  private readonly logBlocksLimit: number;

  private readonly useEip1559ForFeeEstimate: boolean;

  constructor(
    provider: Signer,
    bitcoinRpc: BitcoinRpc<B>,
    btcRelayContractAddress: string,
    logBlocksLimit?: number,
    useEip1559ForFeeEstimate?: boolean
  ) {
    this.provider = provider;
    this.contract = new Contract(
      btcRelayContractAddress,
      btcRelayContract.abi,
      provider
    );
    this.contractInterface = new Interface(btcRelayContract.abi);

    this.bitcoinRpc = bitcoinRpc;

    this.logBlocksLimit = logBlocksLimit || limit;

    this.useEip1559ForFeeEstimate =
      useEip1559ForFeeEstimate == null ? true : useEip1559ForFeeEstimate;
  }

  async saveInitialHeader(
    header: B,
    epochStart: number,
    pastBlocksTimestamps: number[]
  ): Promise<UnsignedTransaction> {
    if (pastBlocksTimestamps.length !== 10) {
      throw new Error('Invalid prevBlocksTimestamps');
    }

    const serializedBlock = EVMBtcRelay.serializeBlockHeader(header);

    const unsignedTx = await this.contract.populateTransaction.setInitialParent(
      serializedBlock.serializeToStruct(),
      BigNumber.from(header.getHeight()),
      '0x' + header.getChainWork().toString('hex'),
      BigNumber.from(epochStart),
      pastBlocksTimestamps.map((e) => BigNumber.from(e))
    );
    unsignedTx.gasLimit = BigNumber.from(150000);

    return unsignedTx;
  }

  async retrieveLogAndBlockheight(
    blockData: { blockhash: string; height: number },
    requiredBlockheight?: number
  ): Promise<{
    header: EVMBtcStoredHeader;
    height: number;
  }> {
    let storedHeader: EVMBtcStoredHeader = null;

    const highScoreAndBlockHeight: BigNumber =
      await this.contract._highScoreAndBlockHeight();
    const blockHeight: number = highScoreAndBlockHeight.shr(224).toNumber();

    if (blockHeight < blockData.height) {
      //Btc relay not synchronized to required blockheight
      console.log("not synchronized to block's height");
      return null;
    }

    if (requiredBlockheight != null) {
      if (blockHeight < requiredBlockheight) {
        //Btc relay not synchronized to required blockheight
        console.log('not synchronized to required blockheight');
        return null;
      }
    }

    let currentBlock = (await this.provider.provider.getBlockNumber()) - 1;
    while (storedHeader == null) {
      const params = {
        address: this.contract.address,
        fromBlock: currentBlock - this.logBlocksLimit,
        toBlock: currentBlock,
      };
      const logs = await this.provider.provider.getLogs(params);
      for (let i = logs.length - 1; i >= 0; i--) {
        const log = logs[i];
        const parsedLog = this.contractInterface.parseLog(log);
        if (
          parsedLog.name === 'StoreHeader' ||
          parsedLog.name === 'StoreFork'
        ) {
          const reversedBlockHash: string =
            parsedLog.args.blockHash.substring(2); //Strip 0x
          const commitHash: string = parsedLog.args.commitmentHash;
          const blockHash: string = Buffer.from(reversedBlockHash, 'hex')
            .reverse()
            .toString('hex');
          if (blockHash === blockData.blockhash) {
            storedHeader = new EVMBtcStoredHeader(parsedLog.args.storedHeader);
            //Is it part of the main chain?
            const blockHeight = storedHeader.getBlockheight();
            const committedData = await this.contract.getCommitment(
              BigNumber.from(blockHeight)
            );
            if (committedData !== commitHash) {
              return null;
            }
            break;
          }
        }
      }
      currentBlock -= this.logBlocksLimit;
      if (storedHeader == null) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      }
    }

    return {
      header: storedHeader,
      height: blockHeight,
    };
  }

  async retrieveLogByCommitHash(
    spvCommitmentHashStr: string,
    blockData: { blockhash: string; height: number }
  ): Promise<EVMBtcStoredHeader> {
    //Retrieve the log
    let storedHeader: EVMBtcStoredHeader = null;

    const highScoreAndBlockHeight: BigNumber =
      await this.contract._highScoreAndBlockHeight();
    const blockHeight: number = highScoreAndBlockHeight.shr(224).toNumber();

    if (blockHeight < blockData.height) {
      //Btc relay not synchronized to required blockheight
      console.log("not synchronized to block's height");
      return null;
    }

    const committedData = (
      await this.contract.getCommitment(BigNumber.from(blockHeight))
    ).substring(2);
    if (committedData !== spvCommitmentHashStr) {
      return null;
    }

    let currentBlock = (await this.provider.provider.getBlockNumber()) - 1;
    while (storedHeader == null) {
      const params = {
        address: this.contract.address,
        fromBlock: currentBlock - this.logBlocksLimit,
        toBlock: currentBlock,
      };
      const logs = await this.provider.provider.getLogs(params);
      for (let log of logs) {
        const parsedLog = this.contractInterface.parseLog(log);
        if (
          parsedLog.name === 'StoreHeader' ||
          parsedLog.name === 'StoreFork'
        ) {
          const reversedBlockHash: string =
            parsedLog.args.blockHash.substring(2); //Strip 0x
          const commitHash: string = parsedLog.args.commitmentHash.substring(2);
          const blockHash: string = Buffer.from(reversedBlockHash, 'hex')
            .reverse()
            .toString('hex');
          if (commitHash === spvCommitmentHashStr) {
            if (blockHash !== blockData.blockhash) {
              console.log('Invalid blockhash');
              return null;
            }
            storedHeader = new EVMBtcStoredHeader(parsedLog.args.storedHeader);
            break;
          }
        }
      }
      currentBlock -= this.logBlocksLimit;
      if (storedHeader == null) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      }
    }

    return storedHeader;
  }

  async retrieveLatestKnownBlockLog(): Promise<{
    resultStoredHeader: EVMBtcStoredHeader;
    resultBitcoinHeader: B;
  }> {
    let storedHeader = null;
    let bitcoinHeader: B = null;

    let currentBlock = (await this.provider.provider.getBlockNumber()) - 1;
    while (storedHeader == null) {
      const params = {
        address: this.contract.address,
        fromBlock: currentBlock - this.logBlocksLimit,
        toBlock: currentBlock,
      };
      const logs = await this.provider.provider.getLogs(params);
      for (let i = logs.length - 1; i >= 0; i--) {
        const log = logs[i];
        const parsedLog = this.contractInterface.parseLog(log);
        if (
          parsedLog.name === 'StoreHeader' ||
          parsedLog.name === 'StoreFork'
        ) {
          const reversedBlockHash: string =
            parsedLog.args.blockHash.substring(2); //Strip 0x
          const commitHash: string = parsedLog.args.commitmentHash;
          const blockHash: string = Buffer.from(reversedBlockHash, 'hex')
            .reverse()
            .toString('hex');
          const isInMainChain = await this.bitcoinRpc.isInMainChain(blockHash);
          if (isInMainChain) {
            const _storedHeader = new EVMBtcStoredHeader(
              parsedLog.args.storedHeader
            );
            //Check if this header is part of main chain in btcrelay
            const blockHeight = _storedHeader.getBlockheight();
            const committedData = await this.contract.getCommitment(
              BigNumber.from(blockHeight)
            );
            if (committedData === commitHash) {
              bitcoinHeader = await this.bitcoinRpc.getBlockHeader(blockHash);
              storedHeader = _storedHeader;
              break;
            }
          }
        }
      }
      currentBlock -= this.logBlocksLimit;
      if (storedHeader == null) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
      }
    }

    return {
      resultStoredHeader: storedHeader,
      resultBitcoinHeader: bitcoinHeader,
    };
  }

  static serializeBlockHeader(e: BtcBlock): EVMBtcHeader {
    return new EVMBtcHeader({
      version: e.getVersion(),
      reversedPrevBlockhash: Buffer.from(e.getPrevBlockhash(), 'hex').reverse(),
      merkleRoot: Buffer.from(e.getMerkleRoot(), 'hex').reverse(),
      timestamp: e.getTimestamp(),
      nbits: e.getNbits(),
      nonce: e.getNonce(),
      hash: Buffer.from(e.getHash(), 'hex').reverse(),
    });
  }

  async saveMainHeaders(
    mainHeaders: BtcBlock[],
    storedHeader: EVMBtcStoredHeader
  ) {
    const blockHeaderObj = mainHeaders.map(EVMBtcRelay.serializeBlockHeader);

    //console.log("[EVMBtcRelay: saveMainHeaders] Block headers to submit: ", blockHeaderObj);

    const unsignedTx =
      await this.contract.populateTransaction.submitMainChainHeaders(
        '0x' +
        Buffer.concat(blockHeaderObj.map((e) => e.serialize())).toString(
          'hex'
        ),
        storedHeader
      );
    unsignedTx.gasLimit = BigNumber.from(40000 + 40000 * mainHeaders.length);

    //console.log("[EVMBtcRelay: saveMainHeaders] TX created");

    const computedCommitedHeaders = [storedHeader];
    for (let blockHeader of blockHeaderObj) {
      //console.log("[EVMBtcRelay: saveMainHeaders] StoredHeaders pre-compute height: ", computedCommitedHeaders[computedCommitedHeaders.length-1].getBlockheight());
      computedCommitedHeaders.push(
        computedCommitedHeaders[computedCommitedHeaders.length - 1].computeNext(
          blockHeader
        )
      );
    }

    //console.log("[EVMBtcRelay: saveMainHeaders] StoredHeaders pre-computed");

    return {
      forkId: 0,
      lastStoredHeader:
        computedCommitedHeaders[computedCommitedHeaders.length - 1],
      tx: unsignedTx,
      computedCommitedHeaders,
    };
  }

  async saveNewForkHeaders(
    forkHeaders: BtcBlock[],
    storedHeader: EVMBtcStoredHeader,
    tipWork: Buffer
  ) {
    const blockHeaderObj = forkHeaders.map(EVMBtcRelay.serializeBlockHeader);

    let forkId: BigNumber = await this.contract._forkCounter();

    const unsignedTx =
      await this.contract.populateTransaction.submitNewForkChainHeaders(
        '0x' +
        Buffer.concat(blockHeaderObj.map((e) => e.serialize())).toString(
          'hex'
        ),
        storedHeader
      );
    unsignedTx.gasLimit = BigNumber.from(200000 + 100000 * forkHeaders.length);

    const computedCommitedHeaders = [storedHeader];
    for (let blockHeader of blockHeaderObj) {
      computedCommitedHeaders.push(
        computedCommitedHeaders[computedCommitedHeaders.length - 1].computeNext(
          blockHeader
        )
      );
    }

    const changedCommitedHeader =
      computedCommitedHeaders[computedCommitedHeaders.length - 1];

    if (
      StatePredictorUtils.gtBuffer(
        changedCommitedHeader.getChainWork(),
        tipWork
      )
    ) {
      //Already main chain
      forkId = BigNumber.from(0);
    }

    return {
      forkId: forkId.toNumber(),
      lastStoredHeader: changedCommitedHeader,
      tx: unsignedTx,
      computedCommitedHeaders,
    };
  }

  async saveForkHeaders(
    forkHeaders: BtcBlock[],
    storedHeader: EVMBtcStoredHeader,
    forkId: number,
    tipWork: Buffer
  ): Promise<{
    forkId: number;
    lastStoredHeader: EVMBtcStoredHeader;
    tx: UnsignedTransaction;
    computedCommitedHeaders: EVMBtcStoredHeader[];
  }> {
    const blockHeaderObj = forkHeaders.map(EVMBtcRelay.serializeBlockHeader);

    const unsignedTx =
      await this.contract.populateTransaction.submitForkChainHeaders(
        '0x' +
        Buffer.concat(blockHeaderObj.map((e) => e.serialize())).toString(
          'hex'
        ),
        BigNumber.from(forkId),
        storedHeader
      );
    unsignedTx.gasLimit = BigNumber.from(200000 + 100000 * forkHeaders.length);

    const computedCommitedHeaders = [storedHeader];
    for (let blockHeader of blockHeaderObj) {
      computedCommitedHeaders.push(
        computedCommitedHeaders[computedCommitedHeaders.length - 1].computeNext(
          blockHeader
        )
      );
    }

    const changedCommitedHeader =
      computedCommitedHeaders[computedCommitedHeaders.length - 1];

    if (
      StatePredictorUtils.gtBuffer(
        changedCommitedHeader.getChainWork(),
        tipWork
      )
    ) {
      //Already main chain
      forkId = 0;
    }

    return {
      forkId: forkId,
      lastStoredHeader: changedCommitedHeader,
      tx: unsignedTx,
      computedCommitedHeaders,
    };
  }

  async getTipData(): Promise<{
    commitHash: string;
    chainWork: Buffer;
    blockheight: number;
  }> {
    const highScoreAndBlockHeight: BigNumber =
      await this.contract._highScoreAndBlockHeight();

    const chainWork: Buffer = Buffer.from(
      highScoreAndBlockHeight
        .and(
          BigNumber.from(
            '0x00000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
          )
        )
        .toHexString()
        .substring(2)
        .padStart(64, '0'),
      'hex'
    );
    const blockheight: number = highScoreAndBlockHeight.shr(224).toNumber();

    if (blockheight === 0) return null;

    const spvTipCommitment: string =
      await this.contract.getLatestMainChainCommitmentHash();

    return {
      commitHash: spvTipCommitment.substring(2),
      chainWork,
      blockheight,
    };
  }

  async estimateSynchronizeFee(requiredBlockheight: number): Promise<BN> {
    const highScoreAndBlockHeight: BigNumber =
      await this.contract._highScoreAndBlockHeight();
    const currBlockheight = highScoreAndBlockHeight.shr(224).toNumber();

    const blockheightDelta = requiredBlockheight - currBlockheight;

    if (blockheightDelta <= 0) return new BN(0);

    const totalGas = blockheightDelta * GAS_PER_BLOCKHEADER;

    let gasPrice: BigNumber;
    if (this.useEip1559ForFeeEstimate)
      try {
        const gasPriceData = await this.provider.provider.getFeeData();

        if (gasPriceData.lastBaseFeePerGas != null) {
          gasPrice = gasPriceData.lastBaseFeePerGas;
        } else {
          gasPrice = gasPriceData.gasPrice;
        }
      } catch (e) {
        console.error(e);
      }

    if (gasPrice == null) {
      gasPrice = await this.provider.provider.getGasPrice();
    }

    return new BN(BigNumber.from(totalGas).mul(gasPrice).toString());
  }

  async getFeePerBlock(): Promise<BN> {
    let gasPrice: BigNumber;
    if (this.useEip1559ForFeeEstimate)
      try {
        const gasPriceData = await this.provider.provider.getFeeData();

        if (gasPriceData.lastBaseFeePerGas != null) {
          gasPrice = gasPriceData.lastBaseFeePerGas;
        } else {
          gasPrice = gasPriceData.gasPrice;
        }
      } catch (e) {
        console.error(e);
      }

    if (gasPrice == null) {
      gasPrice = await this.provider.provider.getGasPrice();
    }

    return new BN(BigNumber.from(GAS_PER_BLOCKHEADER).mul(gasPrice).toString());
  }
}
