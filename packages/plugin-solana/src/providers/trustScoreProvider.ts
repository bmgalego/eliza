import {
    ProcessedTokenData,
    RecommenderData,
    SellDetails,
    TokenRecommendationSummary,
    TokenSecurityData,
    TradeData,
} from "../types.ts";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { TokenProvider } from "./token.ts";
import { SimulationSellingService } from "./simulationSellingService.ts";
import {
    TrustScoreDatabase,
    RecommenderMetrics,
    TokenPerformance,
    TradePerformance,
    TokenRecommendation,
    Recommender,
} from "@ai16z/plugin-trustdb";
import { IAgentRuntime, Memory, Provider, State } from "@ai16z/eliza";
import { v4 as uuidv4 } from "uuid";
import {
    CodexClient,
    CoingeckoClient,
    Sonar,
    TrustScoreBeClient,
} from "../clients.ts";
import { SOL_ADDRESS, SOLANA_NETWORK_ID } from "../constants.ts";

export class TrustScoreManager {
    private readonly runtime: IAgentRuntime;

    private readonly trustScoreDb: TrustScoreDatabase;
    private readonly simulationSellingService: SimulationSellingService;

    private readonly connection: Connection;

    private readonly backend?: TrustScoreBeClient;
    private readonly sonar?: Sonar;

    private DECAY_RATE = 0.95;
    private MAX_DECAY_DAYS = 30;

    constructor(runtime: IAgentRuntime, trustScoreDb: TrustScoreDatabase) {
        this.runtime = runtime;
        this.trustScoreDb = trustScoreDb;
        this.connection = new Connection(runtime.getSetting("RPC_URL")!);

        try {
            this.backend = TrustScoreBeClient.createFromRuntime(this.runtime);
        } catch (error) {}

        try {
            this.sonar = Sonar.createFromRuntime(this.runtime);
        } catch (error) {}

        this.simulationSellingService = new SimulationSellingService(
            runtime,
            this,
            trustScoreDb,
            this.backend,
            this.sonar
        );
    }

    getTokenProvider(tokenAddress: string) {
        // TODO: cache it
        return new TokenProvider(this.runtime, tokenAddress);
    }

    async getOrCreateRecommender(
        recommender: Recommender
    ): Promise<Recommender> {
        recommender =
            await this.trustScoreDb.getOrCreateRecommender(recommender);

        try {
            await this.backend?.getOrCreateRecommender(recommender);
        } catch (error) {}

        return recommender;
    }

    //getRecommenderBalance
    async getRecommenderBalance(recommenderWallet: string): Promise<number> {
        try {
            const tokenAta = await getAssociatedTokenAddress(
                new PublicKey(recommenderWallet),
                new PublicKey(SOL_ADDRESS)
            );

            const tokenBalInfo =
                await this.connection.getTokenAccountBalance(tokenAta);

            const tokenBalance = tokenBalInfo.value.amount;
            const balance = parseFloat(tokenBalance);

            return balance;
        } catch (error) {
            console.error("Error fetching balance", error);
            return 0;
        }
    }

    /**
     * Generates and saves trust score based on processed token data and user recommendations.
     * @param tokenAddress The address of the token to analyze.
     * @param recommenderId The UUID of the recommender.
     * @returns An object containing TokenPerformance and RecommenderMetrics.
     */
    async generateTrustScore(
        tokenAddress: string,
        recommenderId: string,
        recommenderWallet: string
    ): Promise<{
        tokenPerformance: TokenPerformance;
        recommenderMetrics: RecommenderMetrics;
    }> {
        const tokenProvider = this.getTokenProvider(tokenAddress);

        const processedData: ProcessedTokenData =
            await tokenProvider.getProcessedTokenData();
        console.log(`Fetched processed token data for token: ${tokenAddress}`);

        let recommenderMetrics =
            await this.trustScoreDb.getRecommenderMetrics(recommenderId);

        if (!recommenderMetrics) throw new Error("No recommeder metrics");

        const isRapidDump = this.isRapidDump(processedData);
        const sustainedGrowth = this.isSustainedGrowth(processedData);
        const suspiciousVolume = this.isSuspiciousVolume(processedData);
        const balance = await this.getRecommenderBalance(recommenderWallet);
        const virtualConfidence = balance / 1000000; // TODO: create formula to calculate virtual confidence based on user balance
        const lastActive = recommenderMetrics.lastActiveDate;
        const now = new Date();
        const inactiveDays = Math.floor(
            (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24)
        );
        const decayFactor = Math.pow(
            this.DECAY_RATE,
            Math.min(inactiveDays, this.MAX_DECAY_DAYS)
        );
        const decayedScore = recommenderMetrics.trustScore * decayFactor;
        const validationTrustScore =
            await this.trustScoreDb.calculateValidationTrust(tokenAddress);

        return {
            tokenPerformance: {
                tokenAddress,
                priceChange24h:
                    processedData.tradeData.price_change_24h_percent,
                volumeChange24h: processedData.tradeData.volume_24h,
                trade_24h_change:
                    processedData.tradeData.trade_24h_change_percent ?? 0,
                liquidity:
                    processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
                liquidityChange24h: 0,
                holderChange24h:
                    processedData.tradeData.unique_wallet_24h_change_percent ??
                    0,
                rugPull: false,
                // isScam: processedData.tokenCodex.isScam,
                isScam: false,
                marketCapChange24h: 0,
                sustainedGrowth: sustainedGrowth,
                rapidDump: isRapidDump,
                suspiciousVolume: suspiciousVolume,
                validationTrust: validationTrustScore,
                balance: balance,
                initialMarketCap:
                    processedData.dexScreenerData.pairs[0]?.marketCap || 0,
                lastUpdated: new Date(),
                symbol: processedData.token.symbol,
            },
            recommenderMetrics: {
                recommenderId: recommenderId,
                trustScore: recommenderMetrics.trustScore,
                totalRecommendations: recommenderMetrics.totalRecommendations,
                successfulRecs: recommenderMetrics.successfulRecs,
                avgTokenPerformance: recommenderMetrics.avgTokenPerformance,
                riskScore: recommenderMetrics.riskScore,
                consistencyScore: recommenderMetrics.consistencyScore,
                virtualConfidence: virtualConfidence,
                lastActiveDate: now,
                trustDecay: decayedScore,
                lastUpdated: new Date(),
            },
        };
    }

    async updateRecommenderMetrics(
        recommenderId: string,
        tokenPerformance: TokenPerformance,
        recommenderWallet: string
    ): Promise<void> {
        const recommenderMetrics =
            await this.trustScoreDb.getRecommenderMetrics(recommenderId);

        if (!recommenderMetrics) throw new Error("No recommeder metrics");

        const totalRecommendations =
            recommenderMetrics.totalRecommendations + 1;
        const successfulRecs = tokenPerformance.rugPull
            ? recommenderMetrics.successfulRecs
            : recommenderMetrics.successfulRecs + 1;
        const avgTokenPerformance =
            (recommenderMetrics.avgTokenPerformance *
                recommenderMetrics.totalRecommendations +
                tokenPerformance.priceChange24h) /
            totalRecommendations;

        const overallTrustScore = this.calculateTrustScore(
            tokenPerformance,
            recommenderMetrics
        );
        const riskScore = this.calculateOverallRiskScore(
            tokenPerformance,
            recommenderMetrics
        );
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        const balance = await this.getRecommenderBalance(recommenderWallet);
        const virtualConfidence = balance / 1000000; // TODO: create formula to calculate virtual confidence based on user balance
        const lastActive = recommenderMetrics.lastActiveDate;
        const now = new Date();
        const inactiveDays = Math.floor(
            (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24)
        );
        const decayFactor = Math.pow(
            this.DECAY_RATE,
            Math.min(inactiveDays, this.MAX_DECAY_DAYS)
        );
        const decayedScore = recommenderMetrics.trustScore * decayFactor;

        const newRecommenderMetrics: RecommenderMetrics = {
            recommenderId: recommenderId,
            trustScore: overallTrustScore,
            totalRecommendations: totalRecommendations,
            successfulRecs: successfulRecs,
            avgTokenPerformance: avgTokenPerformance,
            riskScore: riskScore,
            consistencyScore: consistencyScore,
            virtualConfidence: virtualConfidence,
            lastActiveDate: new Date(),
            trustDecay: decayedScore,
            lastUpdated: new Date(),
        };

        await this.trustScoreDb.updateRecommenderMetrics(newRecommenderMetrics);
    }

    calculateTrustScore(
        tokenPerformance: TokenPerformance,
        recommenderMetrics: RecommenderMetrics
    ): number {
        const riskScore = this.calculateRiskScore(tokenPerformance);
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        return (riskScore + consistencyScore) / 2;
    }

    calculateOverallRiskScore(
        tokenPerformance: TokenPerformance,
        recommenderMetrics: RecommenderMetrics
    ) {
        const riskScore = this.calculateRiskScore(tokenPerformance);
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        return (riskScore + consistencyScore) / 2;
    }

    calculateRiskScore(tokenPerformance: TokenPerformance): number {
        let riskScore = 0;
        if (tokenPerformance.rugPull) {
            riskScore += 10;
        }
        if (tokenPerformance.isScam) {
            riskScore += 10;
        }
        if (tokenPerformance.rapidDump) {
            riskScore += 5;
        }
        if (tokenPerformance.suspiciousVolume) {
            riskScore += 5;
        }
        return riskScore;
    }

    calculateConsistencyScore(
        tokenPerformance: TokenPerformance,
        recommenderMetrics: RecommenderMetrics
    ): number {
        const avgTokenPerformance = recommenderMetrics.avgTokenPerformance;
        const priceChange24h = tokenPerformance.priceChange24h;

        return Math.abs(priceChange24h - avgTokenPerformance);
    }

    isSuspiciousVolume(processedData: ProcessedTokenData): boolean {
        const unique_wallet_24h = processedData.tradeData.unique_wallet_24h;
        const volume_24h = processedData.tradeData.volume_24h;
        const suspiciousVolume = unique_wallet_24h / volume_24h > 0.5;
        return suspiciousVolume;
    }

    isSustainedGrowth(processedData: ProcessedTokenData): boolean {
        const volume24Change =
            processedData.tradeData.volume_24h_change_percent ?? 0;
        return volume24Change > 50;
    }

    isRapidDump(processedData: ProcessedTokenData): boolean {
        const trade_24h_change_percent =
            processedData.tradeData.trade_24h_change_percent ?? 0;
        return trade_24h_change_percent < -50;
    }

    calculateCheckTrustScore(
        processedData: ProcessedTokenData
    ): TokenSecurityData {
        return {
            ownerBalance: processedData.security.ownerBalance,
            creatorBalance: processedData.security.creatorBalance,
            ownerPercentage: processedData.security.ownerPercentage,
            creatorPercentage: processedData.security.creatorPercentage,
            top10HolderBalance: processedData.security.top10HolderBalance,
            top10HolderPercent: processedData.security.top10HolderPercent,
        };
    }

    /**
     * Creates a TradePerformance object based on token data and recommender.
     * @param tokenAddress The address of the token.
     * @param recommenderId The UUID of the recommender.
     * @param data ProcessedTokenData.
     * @returns TradePerformance object.
     */
    async createTradePerformance(data: TradeData): Promise<TradePerformance> {
        const { tokenAddress } = data;

        const recommender = await this.getOrCreateRecommender(data.recommender);

        const tokenProvider = this.getTokenProvider(data.tokenAddress);

        const processedData: ProcessedTokenData =
            await tokenProvider.getProcessedTokenData();

        let tokensBalance = 0;

        const prices = await CoingeckoClient.createFromRuntime(
            this.runtime
        ).fetchPrices();

        const solPrice = prices.solana.usd;
        const buySol = data.buyAmount / parseFloat(solPrice);
        const buy_value_usd = data.buyAmount * processedData.tradeData.price;
        const token = await tokenProvider.fetchTokenTradeData();

        const tokenPrice = token.price;

        tokensBalance = buy_value_usd / tokenPrice;

        const isRapidDump = this.isRapidDump(processedData);
        const sustainedGrowth = this.isSustainedGrowth(processedData);
        const suspiciousVolume = this.isSuspiciousVolume(processedData);

        await this.trustScoreDb.upsertTokenPerformance({
            tokenAddress: tokenAddress,
            symbol: processedData.token.symbol,
            priceChange24h: processedData.tradeData.price_change_24h_percent,
            volumeChange24h: processedData.tradeData.volume_24h,
            trade_24h_change:
                processedData.tradeData.trade_24h_change_percent ?? 0,
            liquidity:
                processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
            liquidityChange24h: 0,
            holderChange24h:
                processedData.tradeData.unique_wallet_24h_change_percent ?? 0,
            rugPull: false,
            isScam: false, // TODO: implement scam detection, codex?
            marketCapChange24h: 0,
            sustainedGrowth: sustainedGrowth,
            rapidDump: isRapidDump,
            suspiciousVolume: suspiciousVolume,
            validationTrust: 0,
            balance: tokensBalance,
            initialMarketCap:
                processedData.dexScreenerData.pairs[0]?.marketCap || 0,
            lastUpdated: new Date(),
        });

        const tradePerformance: TradePerformance = {
            token_address: tokenAddress,
            recommender_id: recommender.id,
            buy_price: processedData.tradeData.price,
            sell_price: 0,
            buy_timeStamp: data.timestamp,
            sell_timeStamp: "",
            buy_amount: data.buyAmount,
            sell_amount: 0,
            buy_sol: buySol,
            received_sol: 0,
            buy_value_usd,
            sell_value_usd: 0,
            profit_usd: 0,
            profit_percent: 0,
            buy_market_cap:
                processedData.dexScreenerData.pairs[0]?.marketCap || 0,
            sell_market_cap: 0,
            market_cap_change: 0,
            buy_liquidity:
                processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
            sell_liquidity: 0,
            liquidity_change: 0,
            last_updated: new Date().toISOString(),
            rapidDump: false,
        };

        await this.trustScoreDb.addTradePerformance(
            tradePerformance,
            data.isSimulation
        );
        // generate unique uuid for each TokenRecommendation

        const tokenRecommendation: TokenRecommendation = {
            id: uuidv4(),
            recommenderId: recommender.id,
            tokenAddress: tokenAddress,
            timestamp: new Date(),
            initialMarketCap:
                processedData.dexScreenerData.pairs[0]?.marketCap || 0,
            initialLiquidity:
                processedData.dexScreenerData.pairs[0]?.liquidity?.usd || 0,
            initialPrice: processedData.tradeData.price || 0,
        };

        await this.trustScoreDb.addTokenRecommendation(tokenRecommendation);

        if (data.isSimulation) {
            // If the trade is a simulation update the balance
            await this.trustScoreDb.updateTokenBalance(
                tokenAddress,
                tokensBalance
            );
            // generate some random hash for simulations
            const hash = Math.random().toString(36).substring(7);
            const transaction = {
                tokenAddress: tokenAddress,
                type: "buy" as "buy" | "sell",
                transactionHash: hash,
                amount: data.buyAmount,
                price: processedData.tradeData.price,
                isSimulation: true,
                timestamp: data.timestamp,
            };

            await this.trustScoreDb.addTransaction(transaction);
        }

        await this.simulationSellingService.processTokenPerformance(
            tokenAddress,
            recommender.id
        );

        // api call to update trade performance
        await this.backend?.createTradePerformance(data);

        return tradePerformance;
    }

    /**
     * Updates a trade with sell details.
     * @param tokenAddress The address of the token.
     * @param recommenderId The UUID of the recommender.
     * @param buyTimeStamp The timestamp when the buy occurred.
     * @param sellDetails An object containing sell-related details.
     * @param isSimulation Whether the trade is a simulation. If true, updates in simulation_trade; otherwise, in trade.
     * @returns boolean indicating success.
     */

    async updateSellDetails(sellDetails: SellDetails) {
        const { tokenAddress, isSimulation } = sellDetails;

        const recommender = await this.getOrCreateRecommender(
            sellDetails.recommender
        );

        const tokenProvider = this.getTokenProvider(tokenAddress);
        const processedData: ProcessedTokenData =
            await tokenProvider.getProcessedTokenData();

        const prices = await CoingeckoClient.createFromRuntime(
            this.runtime
        ).fetchPrices();

        const solPrice = prices.solana.usd;
        const sellSol = sellDetails.amount / parseFloat(solPrice);
        const valueUsd = sellDetails.amount * processedData.tradeData.price;

        const trade = await this.trustScoreDb.getLatestTradePerformance(
            tokenAddress,
            recommender.id,
            isSimulation
        );

        if (!trade) {
            // TODO
            return;
        }

        const marketCap =
            processedData.dexScreenerData.pairs[0]?.marketCap || 0;
        const liquidity =
            processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0;

        const marketCapChange =
            marketCap > 0 ? marketCap - trade.buy_market_cap : 0;
        const liquidityChange =
            liquidity > 0 ? liquidity - trade.buy_liquidity : 0;

        const profitUsd = valueUsd - trade.buy_value_usd;
        const profitPercent = (profitUsd / trade.buy_value_usd) * 100;

        const isRapidDump = this.isRapidDump(processedData);

        const sellDetailsData = {
            price: processedData.tradeData.price,
            timeStamp: sellDetails.timestamp,
            amount: sellDetails.amount,
            receivedSol: sellSol,
            valueUsd: valueUsd,
            profitUsd: profitUsd,
            profitPercent: profitPercent,
            marketCap: marketCap,
            marketCapChange: marketCapChange,
            liquidity: liquidity,
            liquidityChange: liquidityChange,
            rapidDump: isRapidDump,
            recommenderId: sellDetails.recommender.id,
        };

        await this.trustScoreDb.updateTradePerformanceOnSell(
            tokenAddress,
            recommender.id,
            trade.buy_timeStamp,
            sellDetailsData,
            isSimulation
        );

        if (isSimulation) {
            // If the trade is a simulation update the balance
            const oldBalance =
                await this.trustScoreDb.getTokenBalance(tokenAddress);

            const tokenBalance = oldBalance - sellDetails.amount;

            await this.trustScoreDb.updateTokenBalance(
                tokenAddress,
                tokenBalance
            );

            // generate some random hash for simulations
            const hash = Math.random().toString(36).substring(7);
            const transaction = {
                tokenAddress: tokenAddress,
                type: "sell",
                transactionHash: hash,
                amount: sellDetails.amount,
                price: processedData.tradeData.price,
                isSimulation: true,
                timestamp: sellDetails.timestamp,
            } as const;

            await this.trustScoreDb.addTransaction(transaction);
        }

        return sellDetailsData;
    }

    // get all recommendations
    async getRecommendations(
        startDate: Date,
        endDate: Date
    ): Promise<TokenRecommendationSummary[]> {
        const recommendations =
            await this.trustScoreDb.getRecommendationsByDateRange(
                startDate,
                endDate
            );

        // Group recommendations by tokenAddress
        const groupedRecommendations = recommendations.reduce(
            (acc, recommendation) => {
                const { tokenAddress } = recommendation;
                if (!acc[tokenAddress]) acc[tokenAddress] = [];
                acc[tokenAddress].push(recommendation);
                return acc;
            },
            {} as Record<string, TokenRecommendation[]>
        );

        const results: TokenRecommendationSummary[] = [];

        for (const tokenAddress of Object.keys(groupedRecommendations)) {
            const tokenRecommendations = groupedRecommendations[tokenAddress];

            // Initialize variables to compute averages
            let totalTrustScore = 0;
            let totalRiskScore = 0;
            let totalConsistencyScore = 0;
            const recommenderData: RecommenderData[] = [];

            for (const recommendation of tokenRecommendations) {
                const tokenPerformance =
                    await this.trustScoreDb.getTokenPerformance(
                        recommendation.tokenAddress
                    );

                const recommenderMetrics =
                    await this.trustScoreDb.getRecommenderMetrics(
                        recommendation.recommenderId
                    );

                if (!tokenPerformance || !recommenderMetrics) continue;

                const trustScore = this.calculateTrustScore(
                    tokenPerformance,
                    recommenderMetrics
                );

                const consistencyScore = this.calculateConsistencyScore(
                    tokenPerformance,
                    recommenderMetrics
                );

                const riskScore = this.calculateRiskScore(tokenPerformance);

                // Accumulate scores for averaging
                totalTrustScore += trustScore;
                totalRiskScore += riskScore;
                totalConsistencyScore += consistencyScore;

                recommenderData.push({
                    recommenderId: recommendation.recommenderId,
                    trustScore,
                    riskScore,
                    consistencyScore,
                    recommenderMetrics,
                });
            }

            // Calculate averages for this token
            const averageTrustScore =
                totalTrustScore / tokenRecommendations.length;

            const averageRiskScore =
                totalRiskScore / tokenRecommendations.length;

            const averageConsistencyScore =
                totalConsistencyScore / tokenRecommendations.length;

            results.push({
                tokenAddress,
                averageTrustScore,
                averageRiskScore,
                averageConsistencyScore,
                recommenders: recommenderData,
            });
        }

        // Sort recommendations by the highest average trust score
        results.sort((a, b) => b.averageTrustScore - a.averageTrustScore);

        return results;
    }
}

export const trustScoreProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string> {
        try {
            const trustScoreDb = new TrustScoreDatabase(
                runtime.databaseAdapter.db
            );

            // Get the user ID from the message
            const userId = message.userId;

            if (!userId) {
                console.error("User ID is missing from the message");
                return "";
            }

            // Get the recommender metrics for the user
            const recommenderMetrics =
                await trustScoreDb.getRecommenderMetrics(userId);

            if (!recommenderMetrics) {
                console.error("No recommender metrics found for user:", userId);
                return "";
            }

            // Compute the trust score
            const trustScore = recommenderMetrics.trustScore;

            const user = await runtime.databaseAdapter.getAccountById(userId);

            if (!user) {
                return "";
            } // Format the trust score string
            const trustScoreString = `${user.name}'s trust score: ${trustScore.toFixed(2)}`;
            return trustScoreString;
        } catch (error) {
            console.error(
                "Error in trust score provider:",
                error instanceof Error ? error.message : "Unknown error"
            );
            return `Failed to fetch trust score: ${error instanceof Error ? error.message : "Unknown error"}`;
        }
    },
};
