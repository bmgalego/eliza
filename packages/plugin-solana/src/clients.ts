import BigNumber from "bignumber.js";
import {
    DexScreenerData,
    DexScreenerPair,
    HolderData,
    Prices,
    TokenCodex,
    TokenSecurityData,
    TokenTradeData,
    TradeData,
    WalletPortfolio,
    WalletPortfolioItem,
} from "./types";
import { toBN } from "./bignumber";
import { IAgentRuntime } from "@ai16z/eliza";
import { SOL_ADDRESS, SOLANA_NETWORK_ID } from "./constants";
import { Recommender } from "@ai16z/plugin-trustdb";

let nextRpcRequestId = 1;

export class HttpClient {
    static async request(url: string, options?: RequestInit) {
        try {
            const res = await fetch(url, options);
            if (!res.ok) {
                console.log(res.statusText, await res.text());
                throw new Error("request failed");
            }
            return res;
        } catch (error) {
            throw error;
        }
    }

    static async json<T = any>(url: string, options?: RequestInit) {
        const res = await this.request(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                ...options?.headers,
            },
        });
        return (await res.json()) as T;
    }

    static post = {
        async request(url: string, body: object, options?: RequestInit) {
            return HttpClient.request(url, {
                ...options,
                method: "POST",
                body: JSON.stringify(body),
            });
        },
        async json<T = any>(url: string, body: object, options?: RequestInit) {
            return HttpClient.json<T>(url, {
                ...options,
                method: "POST",
                body: JSON.stringify(body),
            });
        },
    };

    static async jsonrpc<T = any>(
        url: string,
        method: string,
        params: object,
        headers?: HeadersInit
    ) {
        return this.post.json<T>(
            url,
            {
                jsonrpc: "2.0",
                id: nextRpcRequestId++,
                method,
                params,
            },
            {
                headers,
            }
        );
    }

    static async graphql<T = any>(
        url: string,
        query: string,
        variables: object,
        headers?: HeadersInit
    ) {
        return this.post.json<T>(
            url,
            {
                query,
                variables,
            },
            {
                headers,
            }
        );
    }
}

// async function fetchWithRetry(
//     url: string,
//     options: RequestInit = {},
//     maxRetries: number,
//     retryDelay: number
// ): Promise<any> {
//     let lastError: any;

//     for (let i = 0; i < maxRetries; i++) {
//         try {
//             const response = await fetch(url, {
//                 ...options,
//             });

//             if (!response.ok) {
//                 const errorText = await response.text();
//                 throw new Error(
//                     `HTTP error! status: ${response.status}, message: ${errorText}`
//                 );
//             }

//             const data = await response.json();
//             return data;
//         } catch (error) {
//             console.error(`Attempt ${i + 1} failed:`, error);
//             lastError = error as Error;
//             if (i < maxRetries - 1) {
//                 const delay = retryDelay * Math.pow(2, i);
//                 console.log(`Waiting ${delay}ms before retrying...`);
//                 await new Promise((resolve) => setTimeout(resolve, delay));
//                 continue;
//             }
//         }
//     }

//     console.error("All attempts failed. Throwing the last error:", lastError);
//     throw lastError;
// }

export class JupiterClient {
    static baseUrl = "https://price.jup.ag/v6";

    static async getTokenPriceInSol(tokenSymbol: string): Promise<number> {
        const data = await HttpClient.json(
            `${this.baseUrl}/price?ids=${tokenSymbol}`
        );

        return data.data[tokenSymbol].price;
    }

    static async getQuote(
        inputMint: string,
        outputMint: string,
        amount: string,
        slippageBps: number = 50
    ) {
        const params = new URLSearchParams({
            inputMint,
            outputMint,
            amount,
            slippageBps: slippageBps.toString(),
        });

        const quote = await HttpClient.json(
            `${this.baseUrl}/quote?${params.toString()}`
        );

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

        const swapData = await HttpClient.post.json(
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

export class DexscreenerClient {
    static async search(address: string): Promise<DexScreenerData> {
        // const cacheKey = `dexScreenerData_${address}`;
        // const cachedData = await this.getCachedData<DexScreenerData>(cacheKey);
        // if (cachedData) {
        //     console.log("Returning cached DexScreener data.");
        //     return cachedData;
        // }
        try {
            const data = await HttpClient.json<DexScreenerData>(
                `https://api.dexscreener.com/latest/dex/search?q=${address}`
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

    static async searchForHighestLiquidityPair(
        address: string
    ): Promise<DexScreenerPair | null> {
        const data = await this.search(address);

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
    constructor(private readonly apiKey: string) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("HELIUS_API_KEY");

        if (!apiKey) {
            throw new Error("missing HELIUS_API_KEY");
        }

        return new this(apiKey);
    }

    async fetchHolderList(address: string): Promise<HolderData[]> {
        // const cacheKey = `holderList_${address}`;
        // const cachedData = await this.getCachedData<HolderData[]>(cacheKey);
        // if (cachedData) {
        //     console.log("Returning cached holder list.");
        //     return cachedData;
        // }

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

                const data = await HttpClient.jsonrpc(
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

            // Cache the result
            // await this.setCachedData(cacheKey, holders);

            return holders;
        } catch (error) {
            console.error("Error fetching holder list from Helius:", error);
            throw new Error("Failed to fetch holder list from Helius.");
        }
    }
}

export class CoingeckoClient {
    constructor(private readonly apiKey: string) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("COINGECKO_API_KEY") ?? "";

        // if (!apiKey) {
        //     throw new Error("missing COINGECKO_API_KEY");
        // }

        return new this(apiKey);
    }

    async fetchPrices(): Promise<Prices> {
        const prices: Prices = {
            solana: { usd: "250" },
            bitcoin: { usd: "100000" },
            ethereum: { usd: "4000" },
        };

        return prices;
        // try {
        //     const cacheKey = "prices";
        //     const cachedValue = this.cache.get<Prices>(cacheKey);
        //     if (cachedValue) {
        //         console.log("Cache hit for fetchPrices");
        //         return cachedValue;
        //     }
        //     console.log("Cache miss for fetchPrices");
        //     const { SOL, BTC, ETH } = PROVIDER_CONFIG.TOKEN_ADDRESSES;
        //     const tokens = [SOL, BTC, ETH];

        //     for (const token of tokens) {
        //         const response = await this.fetchWithRetry(
        //             runtime,
        //             `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${token}`,
        //             {
        //                 headers: {
        //                     "x-chain": "solana",
        //                 },
        //             }
        //         );
        //         if (response?.data?.value) {
        //             const price = response.data.value.toString();
        //             prices[
        //                 token === SOL
        //                     ? "solana"
        //                     : token === BTC
        //                       ? "bitcoin"
        //                       : "ethereum"
        //             ].usd = price;
        //         } else {
        //             console.warn(`No price data available for token: ${token}`);
        //         }
        //     }
        //     this.cache.set(cacheKey, prices);
        //     return prices;
        // } catch (error) {
        //     console.error("Error fetching prices:", error);
        //     throw error;
        // }
    }
}

export type TokenOverview = {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    logoUri: string;
};

type TokenListItem = {
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

type TokenListResponse = {
    wallet: string;
    totalUsd: number;
    items: TokenListItem[];
};

type BirdeyeXChain = "solana" | "ethereum";

type BirdeyeClientHeaders = {
    "x-chain"?: BirdeyeXChain;
};

export class BirdeyeClient {
    static readonly url = "https://public-api.birdeye.so";

    static async request<T = any>(
        apiKey: string,
        path: string,
        headers?: BirdeyeClientHeaders
    ): Promise<T> {
        const res = await HttpClient.json<{ success: boolean; data?: T }>(
            this.url + path,
            {
                headers: {
                    ...headers,
                    "X-API-KEY": apiKey,
                },
            }
        );

        if (!res.success || !res.data) {
            throw new Error("Failed");
        }

        return res.data;
    }

    constructor(private readonly apiKey: string) {}

    static createFromRuntime(runtime: IAgentRuntime) {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");

        if (!apiKey) {
            throw new Error("missing BIRDEYE_API_KEY");
        }

        return new this(apiKey);
    }

    request<T = any>(path: string, headers?: BirdeyeClientHeaders) {
        return BirdeyeClient.request<T>(this.apiKey, path, headers);
    }

    async fetchPrice(
        address: string,
        chain: BirdeyeXChain = "solana"
    ): Promise<string> {
        const price = await this.request<{ value: number }>(
            `/defi/price?address=${address}`,
            {
                "x-chain": chain,
            }
        );

        return price.value.toString();
    }

    async fetchTokenOverview(
        address: string,
        chain: BirdeyeXChain = "solana"
    ): Promise<TokenOverview> {
        const token = await this.request<TokenOverview>(
            `/defi/token_overview?address=${address}`,
            {
                "x-chain": chain,
            }
        );

        return token;
    }

    async fetchTokenSecurity(
        address: string,
        chain: BirdeyeXChain = "solana"
    ): Promise<TokenSecurityData> {
        // const cacheKey = `tokenSecurity_${address}`;
        // const cachedData =
        //     await this.getCachedData<TokenSecurityData>(cacheKey);
        // if (cachedData) {
        //     console.log(
        //         `Returning cached token security data for ${address}.`
        //     );
        //     return cachedData;
        // }

        try {
            const security = await this.request<TokenSecurityData>(
                `/defi/token_security?address=${address}`,
                {
                    "x-chain": chain,
                }
            );

            return security;
        } catch (error) {
            throw new Error("No token security data available");
        }
    }

    async fetchTokenTradeData(
        address: string,
        chain: BirdeyeXChain = "solana"
    ): Promise<TokenTradeData> {
        // const cacheKey = `tokenTradeData_${address}`;
        // const cachedData = await this.getCachedData<TokenTradeData>(cacheKey);
        // if (cachedData) {
        //     console.log(
        //         `Returning cached token trade data for ${address}.`
        //     );
        //     return cachedData;
        // }
        try {
            const tradeData = await this.request<TokenTradeData>(
                `/defi/v3/token/trade-data/single?address=${address}`,
                {
                    "x-chain": chain,
                }
            );

            return tradeData;
        } catch (error) {
            throw new Error("No token security data available");
        }
    }

    async fetchWalletTokenList(
        address: string,
        chain: BirdeyeXChain = "solana"
    ) {
        const tokenList = await this.request<TokenListResponse>(
            `/v1/wallet/token_list?wallet=${address}`,
            {
                "x-chain": chain,
            }
        );

        return tokenList;
    }

    async fetchPortfolioValue(
        address: string,
        chain: BirdeyeXChain = "solana"
    ): Promise<WalletPortfolio> {
        try {
            // const cacheKey = `portfolio-${wallet}`;
            // const cachedValue = this.cache.get<WalletPortfolio>(cacheKey);

            // if (cachedValue) {
            //     console.log("Cache hit for fetchPortfolioValue");
            //     return cachedValue;
            // }

            console.log("Cache miss for fetchPortfolioValue", address);

            const portfolio: WalletPortfolio = {
                totalUsd: "0",
                totalSol: "0",
                items: [],
            };

            const tokenList = await this.fetchWalletTokenList(address, chain);

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

            // this.cache.set(cacheKey, portfolio);
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

export class CodexClient {
    static readonly url = "https://graph.codex.io/graphql";

    static async request<T = any>(
        apiKey: string,
        query: string,
        variables?: any
    ): Promise<T> {
        const res = await HttpClient.graphql<{ data: T }>(
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
        const apiKey = runtime.getSetting("CODEX_API_KEY") ?? "";

        // if (!apiKey) {
        //     throw new Error("missing CODEX_API_KEY");
        // }

        return new this(apiKey);
    }

    request<T = any>(query: string, variables?: any) {
        return CodexClient.request<T>(this.apiKey, query, variables);
    }

    async fetchToken(address: string, networkId: number): Promise<TokenCodex> {
        try {
            // const cacheKey = `token_${address}`;
            // const cachedData = await this.getCachedData<TokenCodex>(cacheKey);
            // if (cachedData) {
            //     console.log(`Returning cached token data for ${address}.`);
            //     return cachedData;
            // }
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

            // await this.setCachedData(cacheKey, token);

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
            // const cacheKey = `portfolio-${address}`;
            // const cachedValue = this.cache.get<WalletPortfolio>(cacheKey);

            // if (cachedValue) {
            //     console.log("Cache hit for fetchPortfolioValue");
            //     return cachedValue;
            // }
            // console.log("Cache miss for fetchPortfolioValue");

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

            // Cache the portfolio for future requests
            // this.cache.set(cacheKey, portfolio, 60 * 1000); // Cache for 1 minute

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
        return HttpClient.post.json(`${this.url}${path}`, body, {
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
        return HttpClient.post.json(`${this.url}${path}`, body, {
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
        initial_mc: number
    ) {
        try {
            const result = await this.request(`/ai16z-sol/startProcess`, {
                address,
                balance,
                isSimulation,
                initial_mc,
                sell_recommender_id,
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
