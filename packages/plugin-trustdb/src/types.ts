export type Recommender = {
    id: string; // UUID
    address: string;
    solanaPubkey?: string;
    telegramId?: string;
    discordId?: string;
    twitterId?: string;
    ip?: string;
};

export type RecommenderMetrics = {
    recommenderId: string;
    trustScore: number;
    totalRecommendations: number;
    successfulRecs: number;
    avgTokenPerformance: number;
    riskScore: number;
    consistencyScore: number;
    virtualConfidence: number;
    lastActiveDate: Date;
    trustDecay: number;
    lastUpdated: Date;
};

export type TokenPerformance = {
    tokenAddress: string;
    symbol: string;
    priceChange24h: number;
    volumeChange24h: number;
    trade_24h_change: number;
    liquidity: number;
    liquidityChange24h: number;
    holderChange24h: number;
    rugPull: boolean;
    isScam: boolean;
    marketCapChange24h: number;
    sustainedGrowth: boolean;
    rapidDump: boolean;
    suspiciousVolume: boolean;
    validationTrust: number;
    balance: number;
    initialMarketCap: number;
    lastUpdated: Date;
};

export type TokenRecommendation = {
    id: string; // UUID
    recommenderId: string;
    tokenAddress: string;
    timestamp: Date;
    initialMarketCap?: number;
    initialLiquidity?: number;
    initialPrice?: number;
};
export type RecommenderMetricsHistory = {
    historyId: string; // UUID
    recommenderId: string;
    trustScore: number;
    totalRecommendations: number;
    successfulRecs: number;
    avgTokenPerformance: number;
    riskScore: number;
    consistencyScore: number;
    virtualConfidence: number;
    trustDecay: number;
    recordedAt: Date;
};

export type TradePerformance = {
    token_address: string;
    recommender_id: string;
    buy_price: number;
    sell_price: number;
    buy_timeStamp: string;
    sell_timeStamp: string;
    buy_amount: number;
    sell_amount: number;
    buy_sol: number;
    received_sol: number;
    buy_value_usd: number;
    sell_value_usd: number;
    profit_usd: number;
    profit_percent: number;
    buy_market_cap: number;
    sell_market_cap: number;
    market_cap_change: number;
    buy_liquidity: number;
    sell_liquidity: number;
    liquidity_change: number;
    last_updated: string;
    rapidDump: boolean;
};

export type Transaction = {
    tokenAddress: string;
    transactionHash: string;
    type: "buy" | "sell";
    amount: number;
    price: number;
    isSimulation: boolean;
    timestamp: string;
};

export interface TrustScoreAdapter {
    // Recommender Methods
    addRecommender(recommender: Recommender): Promise<string | null>;
    getRecommender(identifier: string): Promise<Recommender | null>;
    getOrCreateRecommender(
        recommender: Recommender
    ): Promise<Recommender | null>;
    getOrCreateRecommenderWithDiscordId(
        discordId: string
    ): Promise<Recommender | null>;
    getOrCreateRecommenderWithTelegramId(
        telegramId: string
    ): Promise<Recommender | null>;

    // Recommender Metrics Methods
    initializeRecommenderMetrics(recommenderId: string): Promise<boolean>;
    getRecommenderMetrics(
        recommenderId: string
    ): Promise<RecommenderMetrics | null>;
    updateRecommenderMetrics(metrics: RecommenderMetrics): Promise<void>;
    logRecommenderMetricsHistory(recommenderId: string): Promise<void>;
    getRecommenderMetricsHistory(
        recommenderId: string
    ): Promise<RecommenderMetricsHistory[]>;

    // Token Performance Methods
    upsertTokenPerformance(performance: TokenPerformance): Promise<boolean>;
    getTokenPerformance(tokenAddress: string): Promise<TokenPerformance | null>;
    updateTokenBalance(tokenAddress: string, balance: number): Promise<boolean>;
    getTokenBalance(tokenAddress: string): Promise<number>;
    getAllTokenPerformancesWithBalance(): Promise<TokenPerformance[]>;
    calculateValidationTrust(tokenAddress: string): Promise<number>;

    // Token Recommendations Methods
    addTokenRecommendation(
        recommendation: TokenRecommendation
    ): Promise<boolean>;
    getRecommendationsByRecommender(
        recommenderId: string
    ): Promise<TokenRecommendation[]>;
    getRecommendationsByToken(
        tokenAddress: string
    ): Promise<TokenRecommendation[]>;
    getRecommendationsByDateRange(
        startDate: Date,
        endDate: Date
    ): Promise<TokenRecommendation[]>;

    // Trade Performance Methods
    addTradePerformance(
        trade: TradePerformance,
        isSimulation: boolean
    ): Promise<boolean>;
    updateTradePerformanceOnSell(
        tokenAddress: string,
        recommenderId: string,
        buyTimeStamp: string,
        sellDetails: {
            sell_price: number;
            sell_timeStamp: string;
            sell_amount: number;
            received_sol: number;
            sell_value_usd: number;
            profit_usd: number;
            profit_percent: number;
            sell_market_cap: number;
            market_cap_change: number;
            sell_liquidity: number;
            liquidity_change: number;
            rapidDump: boolean;
            sell_recommender_id: string | null;
        },
        isSimulation: boolean
    ): Promise<boolean>;
    getTradePerformance(
        tokenAddress: string,
        recommenderId: string,
        buyTimeStamp: string,
        isSimulation: boolean
    ): Promise<TradePerformance | null>;
    getLatestTradePerformance(
        tokenAddress: string,
        recommenderId: string,
        isSimulation: boolean
    ): Promise<TradePerformance | null>;

    // Transaction Methods
    addTransaction(transaction: Transaction): Promise<boolean>;
    getTransactionsByToken(tokenAddress: string): Promise<Transaction[]>;

    // Cleanup
    close(): Promise<void>;
}
