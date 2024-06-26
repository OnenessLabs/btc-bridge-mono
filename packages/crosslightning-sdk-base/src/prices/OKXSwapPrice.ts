import { ISwapPrice } from '../swaps/ISwapPrice';
import * as BN from 'bn.js';
import { Response } from 'cross-fetch';
import { TokenAddress } from '@onenesslabs/crosslightning-base';
import { fetchWithTimeout, tryWithRetries } from '../utils/RetryUtils';
import { CoinAddresses } from './PricesTypes';
import { HttpResponseError } from '../errors/HttpResponseError';

export type OKXCoinsMapType = {
  [address: string]: {
    pair: string;
    decimals: number;
    invert: boolean;
  };
};

const CACHE_DURATION = 10000;

export class OKXSwapPrice extends ISwapPrice {
  static createCoinsMap(
    wbtcAdress?: string,
    usdcAddress?: string,
    usdtAddress?: string
  ): OKXCoinsMapType {
    const coinMap = {
      So11111111111111111111111111111111111111112: {
        pair: 'SOL-BTC',
        decimals: 9,
        invert: false,
      },
    };

    if (wbtcAdress != null) {
      coinMap[wbtcAdress] = {
        pair: '$fixed-1',
        decimals: 8,
        invert: false,
      };
    }
    if (usdcAddress != null) {
      coinMap[usdcAddress] = {
        pair: 'BTC-USDC',
        decimals: 6,
        invert: true,
      };
    }
    if (usdtAddress != null) {
      coinMap[usdtAddress] = {
        pair: 'BTC-USDT',
        decimals: 6,
        invert: true,
      };
    }

    return coinMap;
  }

  static createCoinsMapFromTokens(
    tokens: CoinAddresses,
    nativeTokenTicker?: string
  ): OKXCoinsMapType {
    const coinMap: OKXCoinsMapType = {};

    if (tokens.WBTC != null) {
      coinMap[tokens.WBTC] = {
        pair: '$fixed-1',
        decimals: 8,
        invert: false,
      };
    }
    if (tokens.USDC != null) {
      coinMap[tokens.USDC] = {
        pair: 'BTC-USDC',
        decimals: 6,
        invert: true,
      };
    }
    if (tokens.USDT != null) {
      coinMap[tokens.USDT] = {
        pair: 'BTC-USDT',
        decimals: 6,
        invert: true,
      };
    }
    if (tokens.ETH != null || nativeTokenTicker != null) {
      coinMap[tokens.ETH] = {
        pair: nativeTokenTicker + '-BTC',
        decimals: 18,
        invert: false,
      };
    }

    return coinMap;
  }

  url: string;
  COINS_MAP: OKXCoinsMapType = {
    '6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75': {
      pair: 'BTC-USDC',
      decimals: 6,
      invert: true,
    },
    Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT: {
      pair: 'BTC-USDT',
      decimals: 6,
      invert: true,
    },
    So11111111111111111111111111111111111111112: {
      pair: 'SOL-BTC',
      decimals: 9,
      invert: false,
    },
    Ag6gw668H9PLQFyP482whvGDoAseBWfgs5AfXCAK3aMj: {
      pair: '$fixed-1',
      decimals: 8,
      invert: false,
    },
  };

  httpRequestTimeout?: number;

  cache: {
    [pair: string]: {
      price: Promise<number>;
      expiry: number;
    };
  } = {};
  cacheTimeout: number;

  constructor(
    maxAllowedFeeDiffPPM: BN,
    coinsMap?: OKXCoinsMapType,
    url?: string,
    httpRequestTimeout?: number,
    cacheTimeout?: number
  ) {
    super(maxAllowedFeeDiffPPM);
    this.url = url || 'https://www.okx.com/api/v5';
    if (coinsMap != null) {
      this.COINS_MAP = coinsMap;
    }
    this.httpRequestTimeout = httpRequestTimeout;
    this.cacheTimeout = cacheTimeout || CACHE_DURATION;
  }

  async fetchPrice(pair: string, abortSignal?: AbortSignal): Promise<number> {
    const response: Response = await tryWithRetries(
      () =>
        fetchWithTimeout(this.url + '/market/index-tickers?instId=' + pair, {
          method: 'GET',
          timeout: this.httpRequestTimeout,
          signal: abortSignal,
        }),
      null,
      null,
      abortSignal
    );

    if (response.status !== 200) {
      let resp: string;
      try {
        resp = await response.text();
      } catch (e) {
        throw new HttpResponseError(response.statusText);
      }
      throw new HttpResponseError(resp);
    }

    let jsonBody: any = await response.json();

    return parseFloat(jsonBody.data[0].idxPx);
  }

  /**
   * Returns coin price in mSat
   *
   * @param pair
   * @param invert
   */
  async getPrice(
    pair: string,
    invert: boolean,
    abortSignal?: AbortSignal
  ): Promise<BN> {
    if (pair.startsWith('$fixed-')) {
      const amt: number = parseFloat(pair.substring(7));
      return new BN(Math.floor(amt * 1000));
    }

    let thisFetch: Promise<number>;
    const cachedValue = this.cache[pair];
    if (cachedValue == null || cachedValue.expiry < Date.now()) {
      thisFetch = this.fetchPrice(pair, abortSignal);
      this.cache[pair] = {
        price: thisFetch,
        expiry: Date.now() + this.cacheTimeout,
      };
    }

    let price: number;
    if (thisFetch != null) {
      price = await thisFetch;
    } else {
      price = await this.cache[pair].price.catch((e) =>
        this.fetchPrice(pair, abortSignal)
      );
    }

    let result: BN;
    if (invert) {
      result = new BN(Math.floor((1 / price) * 100000000000));
    } else {
      result = new BN(Math.floor(price * 100000000000));
    }

    return result;
  }

  preFetchPrice(token: TokenAddress, abortSignal?: AbortSignal): Promise<BN> {
    let tokenAddress: string = token.toString();

    const coin = this.COINS_MAP[tokenAddress];

    if (coin == null) throw new Error('Token not found');
    return this.getPrice(coin.pair, coin.invert, abortSignal);
  }

  async getFromBtcSwapAmount(
    fromAmount: BN,
    toToken: TokenAddress,
    abortSignal?: AbortSignal,
    preFetchedPrice?: BN
  ): Promise<BN> {
    let tokenAddress: string = toToken.toString();

    const coin = this.COINS_MAP[tokenAddress];

    if (coin == null) throw new Error('Token not found');

    const price =
      preFetchedPrice ||
      (await this.getPrice(coin.pair, coin.invert, abortSignal));

    console.log('Swap price: ', price.toString(10));

    return fromAmount
      .mul(new BN(10).pow(new BN(coin.decimals)))
      .mul(new BN(1000)) //To msat
      .div(price);
  }

  async getToBtcSwapAmount(
    fromAmount: BN,
    fromToken: TokenAddress,
    abortSignal?: AbortSignal,
    preFetchedPrice?: BN
  ): Promise<BN> {
    let tokenAddress: string = fromToken.toString();

    const coin = this.COINS_MAP[tokenAddress];

    if (coin == null) throw new Error('Token not found');

    const price =
      preFetchedPrice ||
      (await this.getPrice(coin.pair, coin.invert, abortSignal));

    return fromAmount
      .mul(price)
      .div(new BN(1000))
      .div(new BN(10).pow(new BN(coin.decimals)));
  }

  shouldIgnore(tokenAddress: TokenAddress): boolean {
    const coin = this.COINS_MAP[tokenAddress];

    if (coin == null) throw new Error('Token not found');

    return coin.pair === '$ignore';
  }
}
