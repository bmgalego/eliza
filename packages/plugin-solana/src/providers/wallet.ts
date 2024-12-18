import { IAgentRuntime, Memory, Provider, State } from "@ai16z/eliza";
import { PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { Prices, WalletPortfolio, WalletPortfolioItem } from "../types";
import { BirdeyeClient, CoingeckoClient } from "../clients";

export class WalletProvider {
    static createFromRuntime(runtime: IAgentRuntime): WalletProvider {
        const address = runtime.getSetting("SOLANA_PUBLIC_KEY");

        if (!address) {
            throw new Error("SOLANA_PUBLIC_KEY not configured");
        }

        return new this(runtime, new PublicKey(address));
    }

    constructor(
        private runtime: IAgentRuntime,
        private walletPublicKey: PublicKey
    ) {}

    async getFormattedPortfolio(): Promise<string> {
        try {
            const [portfolio, prices] = await Promise.all([
                this.fetchPortfolioValue(),
                BirdeyeClient.createFromRuntime(this.runtime).fetchPrices(),
            ]);

            return this.formatPortfolio(portfolio, prices);
        } catch (error) {
            console.error("Error generating portfolio report:", error);
            return "Unable to fetch wallet information. Please try again later.";
        }
    }

    async fetchPortfolioValue(): Promise<WalletPortfolio> {
        return await BirdeyeClient.createFromRuntime(
            this.runtime
        ).fetchPortfolioValue(this.walletPublicKey.toBase58(), {
            chain: "solana",
            expires: "5m", // TODO: configure this
        });
    }

    async getTokensInWallet(): Promise<WalletPortfolioItem[]> {
        const walletInfo = await this.fetchPortfolioValue();
        return walletInfo.items;
    }

    // check if the token symbol is in the wallet
    async getTokenFromWallet(tokenSymbol: string) {
        try {
            const items = await this.getTokensInWallet();
            const token = items.find((item) => item.symbol === tokenSymbol);

            if (token) {
                return token.address;
            } else {
                return null;
            }
        } catch (error) {
            console.error("Error checking token in wallet:", error);
            return null;
        }
    }

    formatPortfolio(portfolio: WalletPortfolio, prices: Prices): string {
        let output = "";
        output += `Wallet Address: ${this.walletPublicKey.toBase58()}\n\n`;

        const totalUsdFormatted = new BigNumber(portfolio.totalUsd).toFixed(2);
        const totalSolFormatted = portfolio.totalSol;

        output += `Total Value: $${totalUsdFormatted} (${totalSolFormatted} SOL)\n\n`;
        output += "Token Balances:\n";

        const nonZeroItems = portfolio.items.filter((item) =>
            new BigNumber(item.uiAmount).isGreaterThan(0)
        );

        if (nonZeroItems.length === 0) {
            output += "No tokens found with non-zero balance\n";
        } else {
            for (const item of nonZeroItems) {
                const valueUsd = new BigNumber(item.valueUsd).toFixed(2);
                output += `${item.name} (${item.symbol}): ${new BigNumber(
                    item.uiAmount
                ).toFixed(6)} ($${valueUsd} | ${item.valueSol} SOL)\n`;
            }
        }

        output += "\nMarket Prices:\n";
        output += `SOL: $${new BigNumber(prices.solana.usd).toFixed(2)}\n`;
        output += `BTC: $${new BigNumber(prices.bitcoin.usd).toFixed(2)}\n`;
        output += `ETH: $${new BigNumber(prices.ethereum.usd).toFixed(2)}\n`;

        return output;
    }
}

export const walletProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string | null> => {
        try {
            const provider = WalletProvider.createFromRuntime(runtime);
            return await provider.getFormattedPortfolio();
        } catch (error) {
            console.error("Error in wallet provider:", error);
            return null;
        }
    },
};
