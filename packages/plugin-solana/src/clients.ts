import BigNumber from "bignumber.js";
import {
    DexScreenerData,
    DexScreenerPair,
    HolderData,
    Prices,
    TokenCodex,
    TokenOverview,
    TokenSecurityData,
    TokenTradeData,
    TradeData,
    WalletPortfolio,
    WalletPortfolioItem,
} from "./types";
import { toBN } from "./bignumber";
import { CacheOptions, IAgentRuntime, ICacheManager } from "@ai16z/eliza";
import {
    ETH_ADDRESS,
    SOL_ADDRESS,
    SOLANA_NETWORK_ID,
    BTC_ADDRESS,
} from "./constants";
import { Recommender } from "@ai16z/plugin-trustdb";

let nextRpcRequestId = 1;

type QueryParams =
    | Record<string, string | number | boolean | null | undefined>
    | URLSearchParams;

interface RetryOptions {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
    retryableStatuses?: number[];
}

interface RequestOptions extends RequestInit {
    retryOptions?: RetryOptions;
    params?: QueryParams;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffFactor: 2,
    retryableStatuses: [408, 429, 500, 502, 503, 504],
};

class RequestError extends Error {
    constructor(
        message: string,
        public response?: Response
    ) {
        super(message);
        this.name = "RequestError";
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const calculateDelay = (
    attempt: number,
    options: Required<RetryOptions>
): number => {
    const delay =
        options.initialDelay * Math.pow(options.backoffFactor, attempt - 1);
    return Math.min(delay, options.maxDelay);
};

const isRetryableError = (error: any): boolean =>
    error.name === "TypeError" ||
    error.name === "AbortError" ||
    error instanceof RequestError;

const buildUrl = (url: string, params?: QueryParams): string => {
    if (!params) return url;

    const searchParams =
        params instanceof URLSearchParams
            ? params
            : new URLSearchParams(
                  Object.entries(params)
                      .filter(([_, value]) => value != null)
                      .map(([key, value]) => [key, String(value)])
              );

    const separator = url.includes("?") ? "&" : "?";
    const queryString = searchParams.toString();

    return queryString ? `${url}${separator}${queryString}` : url;
};

export const http = {
    async request(url: string, options?: RequestOptions): Promise<Response> {
        const { params, ...fetchOptions } = options || {};
        const fullUrl = buildUrl(url, params);

        const retryOptions: Required<RetryOptions> = {
            ...DEFAULT_RETRY_OPTIONS,
            ...options?.retryOptions,
        };

        let attempt = 1;

        while (true) {
            try {
                const res = await fetch(fullUrl, fetchOptions);

                if (!res.ok) {
                    const errorText = await res.text();
                    throw new RequestError(
                        `Request failed with status ${res.status}: ${errorText}`,
                        res
                    );
                }

                return res;
            } catch (error: any) {
                if (
                    isRetryableError(error) &&
                    attempt < retryOptions.maxRetries
                ) {
                    const delay = calculateDelay(attempt, retryOptions);
                    console.warn(
                        `Request failed with error: ${error.message}. ` +
                            `Retrying in ${delay}ms (attempt ${attempt}/${retryOptions.maxRetries})`
                    );
                    await sleep(delay);
                    attempt++;
                    continue;
                }

                throw error;
            }
        }
    },

    async json<T = any>(url: string, options?: RequestOptions) {
        const res = await this.request(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...options?.headers,
            },
        });
        return (await res.json()) as T;
    },

    get: {
        async request(
            url: string,
            params?: QueryParams,
            options?: RequestInit
        ) {
            return http.request(url, {
                ...options,
                method: "GET",
                params,
            });
        },
        async json<T = any>(
            url: string,
            params?: QueryParams,
            options?: RequestInit
        ) {
            return http.json<T>(url, {
                ...options,
                method: "GET",
                params,
            });
        },
    },

    post: {
        async request(url: string, body: object, options?: RequestOptions) {
            return http.request(url, {
                ...options,
                method: "POST",
                body: JSON.stringify(body),
            });
        },

        async json<ReturnType = any, Body extends object = object>(
            url: string,
            body: Body,
            options?: RequestOptions
        ) {
            return http.json<ReturnType>(url, {
                ...options,
                method: "POST",
                body: JSON.stringify(body),
            });
        },
    },

    async jsonrpc<ReturnType = any, Params extends object = object>(
        url: string,
        method: string,
        params: Params,
        headers?: HeadersInit
    ) {
        return this.post.json<ReturnType>(
            url,
            {
                jsonrpc: "2.0",
                id: nextRpcRequestId++,
                method,
                params,
            },
            { headers }
        );
    },

    async graphql<ReturnType = any, Variables extends object = object>(
        url: string,
        query: string,
        variables: Variables,
        headers?: HeadersInit
    ) {
        return this.post.json<ReturnType>(
            url,
            {
                query,
                variables,
            },
            { headers }
        );
    },
};

export class JupiterClient {
    static baseUrl = "https://price.jup.ag/v6";

    static async getPrice(tokenSymbol: string): Promise<number> {
        const data = await http.get.json(`${this.baseUrl}/price`, {
            ids: tokenSymbol,
        });

        return data.data[tokenSymbol].price;
    }

    static async getQuote(
        inputMint: string,
        outputMint: string,
        amount: string,
        slippageBps: number = 50
    ) {
        const quote = await http.get.json(`${this.baseUrl}/quote`, {
            inputMint,
            outputMint,
            amount,
            slippageBps: slippageBps.toString(),
        });

        if (!quote || quote.error) {
            console.error("Quote error:", quote);
            throw new Error(
                `Failed to get quote: ${quote?.error || "Unknown error"}`
            );
        }

        return quote;
    }

    static async swap(quoteData: any, walletPublicKey: string) {
        const swapRequestBody = {
            quoteResponse: quoteData,
            userPublicKey: walletPublicKey,
            wrapAndUnwrapSol: true,
            computeUnitPriceMicroLamports: 2000000,
            dynamicComputeUnitLimit: true,
        };

        const swapData = await http.post.json(
            `${this.baseUrl}/swap`,
            swapRequestBody
        );

        if (!swapData || !swapData.swapTransaction) {
            console.error("Swap error:", swapData);
            throw new Error(
                `Failed to get swap transaction: ${swapData?.error || "No swap transaction returned"}`
            );
        }

        return swapData;
    }
}

type DexscreenerOptions = {
    expires?: string | CacheOptions["expires"];
};

export class DexscreenerClient {
    constructor(private cache: ICacheManager) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        return new this(runtime.cacheManager);
    }

    async request<T = any>(
        path: string,
        params?: QueryParams,
        options?: DexscreenerOptions
    ) {
        const cacheKey = [
            "dexscreener",
            buildUrl(path, params), // remove first "/"
        ]
            .filter(Boolean)
            .join("/");

        if (options?.expires) {
            const cached = await this.cache.get<T>(cacheKey);
            if (cached) return cached;
        }

        const res = await http.get.json<T>(
            `https://api.dexscreener.com/${path}`,
            params
        );

        if (options?.expires) {
            await this.cache.set(cacheKey, res, {
                expires: Date.now() + parseExpires(options.expires),
            });
        }

        return res;
    }

    async search(
        address: string,
        options?: DexscreenerOptions
    ): Promise<DexScreenerData> {
        try {
            const data = await this.request<DexScreenerData>(
                `latest/dex/search`,
                {
                    q: address,
                },
                options
            );

            if (!data || !data.pairs) {
                throw new Error("No DexScreener data available");
            }

            return data;
        } catch (error) {
            console.error(`Error fetching DexScreener data:`, error);
            return {
                schemaVersion: "1.0.0",
                pairs: [],
            };
        }
    }

    async searchForHighestLiquidityPair(
        address: string,
        options?: DexscreenerOptions
    ): Promise<DexScreenerPair | null> {
        const data = await this.search(address, options);

        if (data.pairs.length === 0) {
            return null;
        }

        // Sort pairs by both liquidity and market cap to get the highest one
        return data.pairs.sort((a, b) => {
            const liquidityDiff = b.liquidity.usd - a.liquidity.usd;
            if (liquidityDiff !== 0) {
                return liquidityDiff; // Higher liquidity comes first
            }
            return b.marketCap - a.marketCap; // If liquidity is equal, higher market cap comes first
        })[0];
    }
}

export class HeliusClient {
    constructor(
        private readonly apiKey: string,
        private cache: ICacheManager
    ) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("HELIUS_API_KEY");

        if (!apiKey) {
            throw new Error("missing HELIUS_API_KEY");
        }

        return new this(apiKey, runtime.cacheManager);
    }

    async fetchHolderList(
        address: string,
        options?: { expires?: string | CacheOptions["expires"] }
    ): Promise<HolderData[]> {
        if (options?.expires) {
            const cached = await this.cache.get<HolderData[]>(
                `helius/token-holders/${address}`
            );

            if (cached) return cached;
        }

        const allHoldersMap = new Map<string, number>();
        let page = 1;
        const limit = 1000;
        let cursor;
        //HELIOUS_API_KEY needs to be added
        const url = `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;

        try {
            while (true) {
                const params = {
                    limit: limit,
                    displayOptions: {},
                    mint: address,
                    cursor: cursor,
                };

                if (cursor != undefined) {
                    params.cursor = cursor;
                }

                console.log(`Fetching holders - Page ${page}`);

                if (page > 2) {
                    break;
                }

                const data = await http.jsonrpc(
                    url,
                    "getTokenAccounts",
                    params
                );

                if (
                    !data ||
                    !data.result ||
                    !data.result.token_accounts ||
                    data.result.token_accounts.length === 0
                ) {
                    console.log(
                        `No more holders found. Total pages fetched: ${page - 1}`
                    );
                    break;
                }

                console.log(
                    `Processing ${data.result.token_accounts.length} holders from page ${page}`
                );

                data.result.token_accounts.forEach((account: any) => {
                    const owner = account.owner;
                    const balance = parseFloat(account.amount);

                    if (allHoldersMap.has(owner)) {
                        allHoldersMap.set(
                            owner,
                            allHoldersMap.get(owner)! + balance
                        );
                    } else {
                        allHoldersMap.set(owner, balance);
                    }
                });
                cursor = data.result.cursor;
                page++;
            }

            const holders: HolderData[] = Array.from(
                allHoldersMap.entries()
            ).map(([address, balance]) => ({
                address,
                balance: balance.toString(),
            }));

            console.log(`Total unique holders fetched: ${holders.length}`);

            if (options?.expires)
                await this.cache.set(
                    `helius/token-holders/${address}`,
                    holders,
                    {
                        expires: Date.now() + parseExpires(options.expires),
                    }
                );

            return holders;
        } catch (error) {
            console.error("Error fetching holder list from Helius:", error);
            throw new Error("Failed to fetch holder list from Helius.");
        }
    }
}

type CoingeckoOptions = {
    expires?: string | CacheOptions["expires"];
};

export class CoingeckoClient {
    constructor(
        private readonly apiKey: string,
        private readonly cache: ICacheManager
    ) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("COINGECKO_API_KEY");

        if (!apiKey) {
            throw new Error("missing COINGECKO_API_KEY");
        }

        return new this(apiKey, runtime.cacheManager);
    }

    async request<T = any>(
        path: string,
        params?: QueryParams,
        options?: CoingeckoOptions
    ) {
        const cacheKey = ["coingecko", buildUrl(path, params)]
            .filter(Boolean)
            .join("/");

        if (options?.expires) {
            const cached = await this.cache.get<T>(cacheKey);
            if (cached) return cached;
        }

        const res = await http.get.json<T>(
            `https://api.coingecko.com/api/v3/${path}`,
            params,
            {
                headers: {
                    "x-cg-demo-api-key": this.apiKey,
                },
            }
        );

        if (options?.expires) {
            await this.cache.set(cacheKey, res);
        }

        return res;
    }

    async fetchPrices(options?: CoingeckoOptions): Promise<Prices> {
        const prices = await this.request<Prices>(
            "simple/price",
            {
                ids: "solana,bitcoin,ethereum",
                vs_currencies: "usd",
            },
            options
        );

        return prices;
    }
}

type WalletTokenListItem = {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    balance: number;
    uiAmount: number;
    chainId: string;
    logoUri: string;
    priceUsd: number;
    valueUsd: number;
};

type WalletTokenList = {
    wallet: string;
    totalUsd: number;
    items: WalletTokenListItem[];
};

type BirdeyeXChain = "solana" | "ethereum";

type BirdeyeClientHeaders = {
    "x-chain"?: BirdeyeXChain;
};

type BirdeyeRequestOptions = {
    chain?: BirdeyeXChain;
    expires?: string | CacheOptions["expires"];
};

export class BirdeyeClient {
    static readonly url = "https://public-api.birdeye.so/";

    static async request<T = any>(
        apiKey: string,
        path: string,
        params?: QueryParams,
        headers?: BirdeyeClientHeaders
    ): Promise<T> {
        const res = await http.get.json<{ success: boolean; data?: T }>(
            this.url + path,
            params,
            {
                headers: {
                    ...headers,
                    "X-API-KEY": apiKey,
                },
            }
        );

        if (!res.success || !res.data) {
            console.error({ res });
            throw new Error("Birdeye request failed:" + path);
        }

        return res.data;
    }

    constructor(
        private readonly apiKey: string,
        private readonly cache: ICacheManager
    ) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");

        if (!apiKey) {
            throw new Error("missing BIRDEYE_API_KEY");
        }

        return new this(apiKey, runtime.cacheManager);
    }

    async request<T = any>(
        path: string,
        params: QueryParams,
        options?: BirdeyeRequestOptions
    ) {
        const cacheKey = ["birdeye", options?.chain, buildUrl(path, params)]
            .filter(Boolean)
            .join("/");

        if (options?.expires) {
            const cached = await this.cache.get<T>(cacheKey);
            if (cached) return cached;
        }

        const response = await BirdeyeClient.request<T>(
            this.apiKey,
            path,
            params,
            options?.chain
                ? {
                      "x-chain": options.chain,
                  }
                : undefined
        );

        if (options?.expires) {
            await this.cache.set(cacheKey, response, {
                expires: Date.now() + parseExpires(options.expires),
            });
        }

        return response;
    }

    async fetchPrice(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<number> {
        const price = await this.request<{ value: number }>(
            "defi/price",
            { address },
            options
        );

        return price.value;
    }

    async fetchPrices(): Promise<Prices> {
        const prices = await this.request<Record<string, { value: number }>>(
            "defi/multi_price",
            { list_address: [SOL_ADDRESS, ETH_ADDRESS, BTC_ADDRESS].join(",") },
            {
                chain: "solana",
                expires: "5m",
            }
        );

        return {
            bitcoin: { usd: prices[BTC_ADDRESS].value.toString() },
            ethereum: { usd: prices[ETH_ADDRESS].value.toString() },
            solana: { usd: prices[SOL_ADDRESS].value.toString() },
        };
    }

    async fetchTokenOverview(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<TokenOverview> {
        const token = await this.request<TokenOverview>(
            "defi/token_overview",
            { address },
            options
        );

        return token;
    }

    async fetchTokenSecurity(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<TokenSecurityData> {
        const security = await this.request<TokenSecurityData>(
            "defi/token_security",
            { address },
            options
        );

        return security;
    }

    async fetchTokenTradeData(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<TokenTradeData> {
        const tradeData = await this.request<TokenTradeData>(
            "defi/v3/token/trade-data/single",
            { address },
            options
        );

        return tradeData;
    }

    async fetchWalletTokenList(
        address: string,
        options?: BirdeyeRequestOptions
    ) {
        const tokenList = await this.request<WalletTokenList>(
            "v1/wallet/token_list",
            { wallet: address },
            options
        );

        return tokenList;
    }

    async fetchPortfolioValue(
        address: string,
        options?: BirdeyeRequestOptions
    ): Promise<WalletPortfolio> {
        try {
            const portfolio: WalletPortfolio = {
                totalUsd: "0",
                totalSol: "0",
                items: [],
            };

            const tokenList = await this.fetchWalletTokenList(address, options);

            const totalUsd = new BigNumber(tokenList.totalUsd.toString());

            const solPriceInUSD = new BigNumber(
                await this.fetchPrice(SOL_ADDRESS)
            );

            const items: WalletPortfolioItem[] = tokenList.items.map(
                (item) => ({
                    ...item,
                    valueSol: new BigNumber(item.valueUsd || 0)
                        .div(solPriceInUSD)
                        .toFixed(6),
                    name: item.name || "Unknown",
                    symbol: item.symbol || "Unknown",
                    priceUsd: item.priceUsd.toString() || "0",
                    valueUsd: item.valueUsd.toString() || "0",
                    uiAmount: item.uiAmount.toString(),
                    balance: item.balance.toString(),
                })
            );

            const totalSol = totalUsd.div(solPriceInUSD);
            portfolio.totalUsd = totalUsd.toString();
            portfolio.totalSol = totalSol.toFixed(6);
            portfolio.items = items.sort((a, b) =>
                new BigNumber(b.valueUsd)
                    .minus(new BigNumber(a.valueUsd))
                    .toNumber()
            );

            return portfolio;
        } catch (error) {
            console.error("Error fetching portfolio:", error);
            throw error;
        }
    }
}

type CodexPrice = {
    address: string;
    networkId: number;
    priceUsd: string;
    poolAddress: string;
};

type CodexBalance = {
    walletId: string;
    tokenId: string;
    balance: string;
    shiftedBalance: number;
};

//TODO: add caching
export class CodexClient {
    static readonly url = "https://graph.codex.io/graphql";

    static async request<T = any>(
        apiKey: string,
        query: string,
        variables?: any
    ): Promise<T> {
        const res = await http.graphql<{ data: T }>(
            this.url,
            query,
            variables,
            apiKey
                ? {
                      Authorization: apiKey,
                  }
                : undefined
        );

        if (!res.data) {
            throw new Error("Failed");
        }

        return res.data;
    }

    constructor(private readonly apiKey: string) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("CODEX_API_KEY");

        if (!apiKey) {
            throw new Error("missing CODEX_API_KEY");
        }

        return new this(apiKey);
    }

    request<T = any>(query: string, variables?: any) {
        return CodexClient.request<T>(this.apiKey, query, variables);
    }

    async fetchToken(address: string, networkId: number): Promise<TokenCodex> {
        try {
            const query = `
                query Token($address: String!, $networkId: Int!) {
                    token(input: { address: $address, networkId: $networkId }) {
                        id
                        address
                        cmcId
                        decimals
                        name
                        symbol
                        totalSupply
                        isScam
                        info {
                            circulatingSupply
                            imageThumbUrl
                        }
                        explorerData {
                            blueCheckmark
                        }
                    }
                }
          `;

            const variables = {
                address,
                networkId, // Replace with your network ID
            };

            const { token } = await this.request<{
                token?: TokenCodex;
            }>(query, variables);

            if (!token) {
                throw new Error(`No data returned for token ${address}`);
            }

            return token;
        } catch (error: any) {
            console.error(
                "Error fetching token data from Codex:",
                error.message
            );
            throw error;
        }
    }

    async fetchPrices(inputs: { address: string; networkId: number }[]) {
        const query = `
            query($inputs:[GetPriceInput]){
                getTokenPrices(
                    inputs: inputs
                ) {
                    address
                    priceUsd
                }
            }
        `;

        const { getTokenPrices: prices } = await this.request<{
            getTokenPrices: CodexPrice[];
        }>(query, {
            inputs,
        });

        return prices;
    }

    async fetchPortfolioValue(
        address: string,
        chainId: number
    ): Promise<WalletPortfolio> {
        try {
            // TODO: get token data
            const query = `
              query Balances($walletId: String!, $cursor: String) {
                balances(input: { walletId: $walletId, cursor: $cursor }) {
                  cursor
                  items {
                    walletId
                    tokenId
                    balance
                    shiftedBalance
                  }
                }
              }
            `;

            const variables = {
                walletId: `${address}:${chainId}`,
                cursor: null,
            };

            const { balances } = await this.request<{
                balances?: {
                    items: CodexBalance[];
                };
            }>(query, variables);

            const data = balances?.items;

            if (!data || data.length === 0) {
                console.error("No portfolio data available", data);
                return {
                    totalUsd: "0",
                    totalSol: "0",
                    items: [],
                };
            }

            // Fetch token prices
            const prices = await this.fetchPrices([
                {
                    address: SOL_ADDRESS,
                    networkId: SOLANA_NETWORK_ID,
                },
                ...data.map((item) => {
                    const [address, networkId] = item.tokenId.split(":");
                    return {
                        address,
                        networkId: Number(networkId),
                    };
                }),
            ]);

            const solPrice =
                prices.find((price) => price.address === SOL_ADDRESS)
                    ?.priceUsd ?? "0";

            // Reformat items
            const items: WalletPortfolioItem[] = data.map((item) => {
                const priceUsd =
                    prices.find(
                        (price) => price.address === item.tokenId.split(":")[0]
                    )?.priceUsd ?? "0";

                const valueUsd = toBN(item.balance).multipliedBy(priceUsd);
                return {
                    name: "Unknown",
                    address: item.tokenId.split(":")[0],
                    symbol: item.tokenId.split(":")[0],
                    decimals: 6, // TODO
                    balance: item.balance,
                    uiAmount: item.shiftedBalance.toString(),
                    priceUsd,
                    valueUsd: valueUsd.toFixed(2),
                    valueSol: valueUsd.div(solPrice).toFixed(2),
                };
            });

            // Calculate total portfolio value
            const totalUsd = items.reduce(
                (sum, item) => sum.plus(new BigNumber(item.valueUsd)),
                new BigNumber(0)
            );

            const totalSol = totalUsd.div(solPrice);

            const portfolio: WalletPortfolio = {
                totalUsd: totalUsd.toFixed(6),
                totalSol: totalSol.toFixed(6),
                items: items.sort((a, b) =>
                    new BigNumber(b.valueUsd)
                        .minus(new BigNumber(a.valueUsd))
                        .toNumber()
                ),
            };

            return portfolio;
        } catch (error) {
            console.error("Error fetching portfolio:", error);
            throw error;
        }
    }
}

export class TrustScoreBeClient {
    static createFromRuntime(runtime: IAgentRuntime) {
        const url = runtime.getSetting("BACKEND_URL");

        if (!url) {
            throw new Error("Missing key BACKEND_URL");
        }

        const apiKey = runtime.getSetting("BACKEND_TOKEN");

        if (!apiKey) {
            throw new Error("Missing key BACKEND_TOKEN");
        }

        return new this(url, apiKey);
    }

    constructor(
        private readonly url: string,
        private readonly apiKey: string
    ) {}

    async request(path: string, body: any) {
        return http.post.json(`${this.url}${path}`, body, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
            },
        });
    }

    async createTradePerformance(data: TradeData) {
        return this.request("/updaters/createTradePerformance", {
            tokenAddress: data.tokenAddress,
            buy_amount: data.buyAmount,
            recommenderId: data.recommender.id,
            is_simulation: data.isSimulation,
        });
    }

    async getOrCreateRecommender(recommender: Recommender) {
        return this.request("/updaters/getOrCreateRecommender", {
            recommenderId: recommender.id,
            username: recommender.address,
        });
    }
}

export class Sonar {
    static createFromRuntime(runtime: IAgentRuntime) {
        const url = runtime.getSetting("SONAR_URL");

        if (!url) {
            throw new Error("Missing key SONAR_URL");
        }

        const apiKey = runtime.getSetting("SONAR_TOKEN");

        if (!apiKey) {
            throw new Error("Missing key SONAR_TOKEN");
        }

        return new this(url, apiKey);
    }

    constructor(
        private readonly url: string,
        private readonly apiKey: string
    ) {}

    async request(path: string, body: any) {
        return http.post.json(`${this.url}${path}`, body, {
            headers: {
                "x-api-key": this.apiKey,
            },
        });
    }

    async startProcess(
        address: string,
        balance: number,
        isSimulation: boolean,
        sell_recommender_id: string,
        initial_mc: number,
        Wallet_address: string
    ) {
        try {
            const result = await this.request(`/ai16z-sol/startProcess`, {
                address,
                balance,
                isSimulation,
                initial_mc,
                sell_recommender_id,
                Wallet_address,
            });

            console.log("Received response:", result);
            console.log(`Sent message to process token ${address}`);

            return result;
        } catch (error) {
            console.error(
                `Error sending message to process token ${address}:`,
                error
            );
            return null;
        }
    }

    async stopProcess(address: string) {
        try {
            return this.request(`/ai16z-sol/stopProcess`, {
                address,
            });
        } catch (error) {
            console.error(
                `Error stopping process for token ${address}:`,
                error
            );
        }
    }
}

// todo: maybe move this into the cacheManager
const units = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
};

function parseTimeToMs(timeStr: string) {
    const match = timeStr.match(/^(\d+)([a-z]+)$/i);
    if (!match) return 0;

    const [_, value, unit] = match;
    return units[unit.toLowerCase()] * parseInt(value);
}

function parseExpires(expires: string | number) {
    return typeof expires === "string" ? parseTimeToMs(expires) : expires;
}