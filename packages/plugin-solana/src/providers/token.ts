import { IAgentRuntime, Memory, Provider, State } from "@ai16z/eliza";
import {
    HolderData,
    ProcessedTokenData,
    TokenSecurityData,
    TokenTradeData,
    CalculatedBuyAmounts,
} from "../types.ts";
import { toBN } from "../bignumber.ts";
import {
    BirdeyeClient,
    CoingeckoClient,
    DexscreenerClient,
    HeliusClient,
} from "../clients.ts";

export class TokenProvider {
    constructor(
        private runtime: IAgentRuntime,
        private tokenAddress: string
    ) {}

    async calculateBuyAmounts(): Promise<CalculatedBuyAmounts> {
        const dexScreenerData = await DexscreenerClient.search(
            this.tokenAddress
        );

        const prices = await CoingeckoClient.createFromRuntime(
            this.runtime
        ).fetchPrices();

        const solPrice = toBN(prices.solana.usd);

        if (!dexScreenerData || dexScreenerData.pairs.length === 0) {
            return { none: 0, low: 0, medium: 0, high: 0 };
        }

        // Get the first pair
        const pair = dexScreenerData.pairs[0];
        const { liquidity, marketCap } = pair;

        if (!liquidity || !marketCap) {
            return { none: 0, low: 0, medium: 0, high: 0 };
        }

        if (liquidity.usd === 0) {
            return { none: 0, low: 0, medium: 0, high: 0 };
        }
        if (marketCap < 100000) {
            return { none: 0, low: 0, medium: 0, high: 0 };
        }

        // impact percentages based on liquidity
        const impactPercentages = {
            LOW: 0.01, // 1% of liquidity
            MEDIUM: 0.05, // 5% of liquidity
            HIGH: 0.1, // 10% of liquidity
        };

        // Calculate buy amounts in USD
        const lowBuyAmountUSD = liquidity.usd * impactPercentages.LOW;
        const mediumBuyAmountUSD = liquidity.usd * impactPercentages.MEDIUM;
        const highBuyAmountUSD = liquidity.usd * impactPercentages.HIGH;

        // Convert each buy amount to SOL
        const lowBuyAmountSOL = toBN(lowBuyAmountUSD).div(solPrice).toNumber();
        const mediumBuyAmountSOL = toBN(mediumBuyAmountUSD)
            .div(solPrice)
            .toNumber();
        const highBuyAmountSOL = toBN(highBuyAmountUSD)
            .div(solPrice)
            .toNumber();

        return {
            none: 0,
            low: lowBuyAmountSOL,
            medium: mediumBuyAmountSOL,
            high: highBuyAmountSOL,
        };
    }

    async fetchTokenSecurity(): Promise<TokenSecurityData> {
        return BirdeyeClient.createFromRuntime(this.runtime).fetchTokenSecurity(
            this.tokenAddress,
            {
                chain: "solana",
                expires: "5m", // TODO: configure this
            }
        );
    }

    async fetchTokenTradeData(): Promise<TokenTradeData> {
        return BirdeyeClient.createFromRuntime(
            this.runtime
        ).fetchTokenTradeData(this.tokenAddress, {
            chain: "solana",
            expires: "1m", // TODO: configure this
        });
    }
    async analyzeHolderDistribution(
        tradeData: TokenTradeData
    ): Promise<string> {
        // Define the time intervals to consider (e.g., 30m, 1h, 2h)
        const intervals = [
            {
                period: "30m",
                change: tradeData.unique_wallet_30m_change_percent,
            },
            { period: "1h", change: tradeData.unique_wallet_1h_change_percent },
            { period: "2h", change: tradeData.unique_wallet_2h_change_percent },
            { period: "4h", change: tradeData.unique_wallet_4h_change_percent },
            { period: "8h", change: tradeData.unique_wallet_8h_change_percent },
            {
                period: "24h",
                change: tradeData.unique_wallet_24h_change_percent,
            },
        ];

        // Calculate the average change percentage
        const validChanges = intervals
            .map((interval) => interval.change)
            .filter(
                (change) => change !== null && change !== undefined
            ) as number[];

        if (validChanges.length === 0) {
            return "stable";
        }

        const averageChange =
            validChanges.reduce((acc, curr) => acc + curr, 0) /
            validChanges.length;

        const increaseThreshold = 10; // e.g., average change > 10%
        const decreaseThreshold = -10; // e.g., average change < -10%

        if (averageChange > increaseThreshold) {
            return "increasing";
        } else if (averageChange < decreaseThreshold) {
            return "decreasing";
        } else {
            return "stable";
        }
    }

    async fetchHolderList(): Promise<HolderData[]> {
        return HeliusClient.createFromRuntime(this.runtime).fetchHolderList(
            this.tokenAddress
        );
    }

    async filterHighValueHolders(
        tradeData: TokenTradeData
    ): Promise<Array<{ holderAddress: string; balanceUsd: string }>> {
        const holdersData = await this.fetchHolderList();

        const tokenPriceUsd = toBN(tradeData.price);

        const highValueHolders = holdersData
            .filter((holder) => {
                const balanceUsd = toBN(holder.balance).multipliedBy(
                    tokenPriceUsd
                );

                return balanceUsd.isGreaterThan(5);
            })
            .map((holder) => ({
                holderAddress: holder.address,
                balanceUsd: toBN(holder.balance)
                    .multipliedBy(tokenPriceUsd)
                    .toFixed(2),
            }));

        return highValueHolders;
    }

    async countHighSupplyHolders(
        securityData: TokenSecurityData
    ): Promise<number> {
        try {
            const ownerBalance = toBN(securityData.ownerBalance);
            const totalSupply = ownerBalance.plus(securityData.creatorBalance);

            const highSupplyHolders = await this.fetchHolderList();
            const highSupplyHoldersCount = highSupplyHolders.filter(
                (holder) => {
                    const balance = toBN(holder.balance);
                    return balance.dividedBy(totalSupply).isGreaterThan(0.02);
                }
            ).length;

            return highSupplyHoldersCount;
        } catch (error) {
            console.error("Error counting high supply holders:", error);
            return 0;
        }
    }

    async getProcessedTokenData(): Promise<ProcessedTokenData> {
        try {
            console.log(
                `Fetching security data for token: ${this.tokenAddress}`
            );
            const security = await this.fetchTokenSecurity();
            console.log({ security });

            const token = await BirdeyeClient.createFromRuntime(
                this.runtime
            ).fetchTokenOverview(this.tokenAddress, {
                chain: "solana",
                expires: "1h", // TODO: configure this
            });

            // TODO: include codex?
            // const tokenCodex = await CodexClient.createFromRuntime(
            //     this.runtime
            // ).fetchToken(this.tokenAddress, SOLANA_NETWORK_ID);

            console.log(`Fetching trade data for token: ${this.tokenAddress}`);
            const tradeData = await this.fetchTokenTradeData();

            console.log({ tradeData });

            console.log(
                `Fetching DexScreener data for token: ${this.tokenAddress}`
            );

            const dexData = await DexscreenerClient.search(this.tokenAddress);

            console.log(
                `Analyzing holder distribution for token: ${this.tokenAddress}`
            );

            const holderDistributionTrend =
                await this.analyzeHolderDistribution(tradeData);

            console.log(
                `Filtering high-value holders for token: ${this.tokenAddress}`
            );

            const highValueHolders =
                await this.filterHighValueHolders(tradeData);

            console.log(
                `Checking recent trades for token: ${this.tokenAddress}`
            );

            const recentTrades = toBN(tradeData.volume_24h_usd).isGreaterThan(
                0
            );

            console.log(
                `Counting high-supply holders for token: ${this.tokenAddress}`
            );

            const highSupplyHoldersCount =
                await this.countHighSupplyHolders(security);

            console.log(
                `Determining DexScreener listing status for token: ${this.tokenAddress}`
            );

            const isDexScreenerListed = dexData.pairs.length > 0;
            const isDexScreenerPaid = dexData.pairs.some(
                (pair) => pair.boosts && pair.boosts.active > 0
            );

            const processedData: ProcessedTokenData = {
                token,
                security,
                tradeData,
                holderDistributionTrend,
                highValueHolders,
                recentTrades,
                highSupplyHoldersCount,
                dexScreenerData: dexData,
                isDexScreenerListed,
                isDexScreenerPaid,
                // tokenCodex,
            };

            // console.log("Processed token data:", processedData);
            return processedData;
        } catch (error) {
            console.error("Error processing token data:", error);
            throw error;
        }
    }

    async shouldTradeToken(): Promise<boolean> {
        const volume24hUsdThreshold = 1000;
        const priceChange24hPercentThreshold = 10;
        const priceChange12hPercentThreshold = 5;
        const top10HolderPercentThreshold = 0.05;
        const uniqueWallet24hThreshold = 100;

        try {
            const tokenData = await this.getProcessedTokenData();
            const { tradeData, security, dexScreenerData } = tokenData;
            const { ownerBalance, creatorBalance } = security;
            const { liquidity, marketCap } = dexScreenerData.pairs[0];
            const liquidityUsd = toBN(liquidity.usd);
            const marketCapUsd = toBN(marketCap);
            const totalSupply = toBN(ownerBalance).plus(creatorBalance);
            const _ownerPercentage = toBN(ownerBalance).dividedBy(totalSupply);
            const _creatorPercentage =
                toBN(creatorBalance).dividedBy(totalSupply);
            const top10HolderPercent = toBN(tradeData.volume_24h_usd).dividedBy(
                totalSupply
            );
            const priceChange24hPercent = toBN(
                tradeData.price_change_24h_percent
            );
            const priceChange12hPercent = toBN(
                tradeData.price_change_12h_percent
            );
            const uniqueWallet24h = tradeData.unique_wallet_24h;
            const volume24hUsd = toBN(tradeData.volume_24h_usd);

            const isTop10Holder = top10HolderPercent.gte(
                top10HolderPercentThreshold
            );
            const isVolume24h = volume24hUsd.gte(volume24hUsdThreshold);
            const isPriceChange24h = priceChange24hPercent.gte(
                priceChange24hPercentThreshold
            );
            const isPriceChange12h = priceChange12hPercent.gte(
                priceChange12hPercentThreshold
            );
            const isUniqueWallet24h =
                uniqueWallet24h >= uniqueWallet24hThreshold;
            const isLiquidityTooLow = liquidityUsd.lt(1000);
            const isMarketCapTooLow = marketCapUsd.lt(100000);

            // TODO: check this
            return (
                isTop10Holder ||
                isVolume24h ||
                isPriceChange24h ||
                isPriceChange12h ||
                isUniqueWallet24h ||
                isLiquidityTooLow ||
                isMarketCapTooLow
            );
        } catch (error) {
            console.error("Error processing token data:", error);
            throw error;
        }
    }

    formatTokenData(data: ProcessedTokenData): string {
        let output = `**Token Security and Trade Report**\n`;
        output += `Token Address: ${this.tokenAddress}\n\n`;

        // Security Data
        output += `**Ownership Distribution:**\n`;
        output += `- Owner Balance: ${data.security.ownerBalance}\n`;
        output += `- Creator Balance: ${data.security.creatorBalance}\n`;
        output += `- Owner Percentage: ${data.security.ownerPercentage}%\n`;
        output += `- Creator Percentage: ${data.security.creatorPercentage}%\n`;
        output += `- Top 10 Holders Balance: ${data.security.top10HolderBalance}\n`;
        output += `- Top 10 Holders Percentage: ${data.security.top10HolderPercent}%\n\n`;

        // Trade Data
        output += `**Trade Data:**\n`;
        output += `- Holders: ${data.tradeData.holder}\n`;
        output += `- Unique Wallets (24h): ${data.tradeData.unique_wallet_24h}\n`;
        output += `- Price Change (24h): ${data.tradeData.price_change_24h_percent}%\n`;
        output += `- Price Change (12h): ${data.tradeData.price_change_12h_percent}%\n`;
        output += `- Volume (24h USD): $${toBN(data.tradeData.volume_24h_usd).toFixed(2)}\n`;
        output += `- Current Price: $${toBN(data.tradeData.price).toFixed(2)}\n\n`;

        // Holder Distribution Trend
        output += `**Holder Distribution Trend:** ${data.holderDistributionTrend}\n\n`;

        // High-Value Holders
        output += `**High-Value Holders (>$5 USD):**\n`;
        if (data.highValueHolders.length === 0) {
            output += `- No high-value holders found or data not available.\n`;
        } else {
            data.highValueHolders.forEach((holder) => {
                output += `- ${holder.holderAddress}: $${holder.balanceUsd}\n`;
            });
        }
        output += `\n`;

        // Recent Trades
        output += `**Recent Trades (Last 24h):** ${data.recentTrades ? "Yes" : "No"}\n\n`;

        // High-Supply Holders
        output += `**Holders with >2% Supply:** ${data.highSupplyHoldersCount}\n\n`;

        // DexScreener Status
        output += `**DexScreener Listing:** ${data.isDexScreenerListed ? "Yes" : "No"}\n`;
        if (data.isDexScreenerListed) {
            output += `- Listing Type: ${data.isDexScreenerPaid ? "Paid" : "Free"}\n`;
            output += `- Number of DexPairs: ${data.dexScreenerData.pairs.length}\n\n`;
            output += `**DexScreener Pairs:**\n`;
            data.dexScreenerData.pairs.forEach((pair, index) => {
                output += `\n**Pair ${index + 1}:**\n`;
                output += `- DEX: ${pair.dexId}\n`;
                output += `- URL: ${pair.url}\n`;
                output += `- Price USD: $${toBN(pair.priceUsd).toFixed(6)}\n`;
                output += `- Volume (24h USD): $${toBN(pair.volume.h24).toFixed(2)}\n`;
                output += `- Boosts Active: ${pair.boosts && pair.boosts.active}\n`;
                output += `- Liquidity USD: $${toBN(pair.liquidity.usd).toFixed(2)}\n`;
            });
        }
        output += `\n`;

        console.log("Formatted token data:", output);
        return output;
    }

    async getFormattedTokenReport(): Promise<string> {
        try {
            console.log("Generating formatted token report...");
            const processedData = await this.getProcessedTokenData();
            return this.formatTokenData(processedData);
        } catch (error) {
            console.error("Error generating token report:", error);
            return "Unable to fetch token information. Please try again later.";
        }
    }
}

const tokenProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string> => {
        try {
            const tokenAddress = "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC"; // ai16z
            const provider = new TokenProvider(runtime, tokenAddress);

            const report = await provider.getFormattedTokenReport();

            return report;
        } catch (error) {
            console.error("Error fetching token data:", error);
            return "Unable to fetch token information. Please try again later.";
        }
    },
};

export { tokenProvider };
