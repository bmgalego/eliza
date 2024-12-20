import bs58 from "bs58";
import {
    Connection,
    Keypair,
    PublicKey,
    VersionedTransaction,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import {
    ActionExample,
    generateObjectDeprecated,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
    type Action,
    composeContext,
} from "@ai16z/eliza";
import { getWalletKey } from "../keypairUtils.ts";
import { walletProvider, WalletProvider } from "../providers/wallet.ts";
import { getTokenDecimals } from "./swapUtils.ts";
import { JupiterClient } from "../clients.ts";
import { SOL_ADDRESS } from "../constants.ts";

async function swapToken(
    connection: Connection,
    walletPublicKey: PublicKey,
    inputTokenCA: string,
    outputTokenCA: string,
    amount: number
): Promise<any> {
    try {
        // Get the decimals for the input token
        const decimals =
            inputTokenCA === SOL_ADDRESS
                ? new BigNumber(9)
                : new BigNumber(
                      await getTokenDecimals(connection, inputTokenCA)
                  );

        console.log("Decimals:", decimals.toString());

        // Use BigNumber for adjustedAmount: amount * (10 ** decimals)
        const amountBN = new BigNumber(amount);
        const adjustedAmount = amountBN.multipliedBy(
            new BigNumber(10).pow(decimals)
        );

        console.log("Fetching quote with params:", {
            inputMint: inputTokenCA,
            outputMint: outputTokenCA,
            amount: adjustedAmount,
        });

        const quote = await JupiterClient.getQuote(
            inputTokenCA,
            outputTokenCA,
            adjustedAmount.toString()
        );

        console.log("Quote received:", { quote });

        const swap = await JupiterClient.swap(
            quote,
            walletPublicKey.toString()
        );

        console.log("Swap transaction received", { swap });
        return swap;
    } catch (error) {
        console.error("Error in swapToken:", error);
        throw error;
    }
}

const swapTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "inputTokenSymbol": "SOL",
    "outputTokenSymbol": "USDC",
    "inputTokenCA": "So11111111111111111111111111111111111111112",
    "outputTokenCA": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": 1.5
}
\`\`\`

{{recentMessages}}

Given the recent messages and wallet information below:

{{walletInfo}}

Extract the following information about the requested token swap:
- Input token symbol (the token being sold)
- Output token symbol (the token being bought)
- Input token contract address if provided
- Output token contract address if provided
- Amount to swap

Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined. The result should be a valid JSON object with the following schema:
\`\`\`json
{
    "inputTokenSymbol": string | null,
    "outputTokenSymbol": string | null,
    "inputTokenCA": string | null,
    "outputTokenCA": string | null,
    "amount": number | string | null
}
\`\`\``;

// if we get the token symbol but not the CA, check walet for matching token, and if we have, get the CA for it

// get all the tokens in the wallet using the wallet provider
async function getTokensInWallet(runtime: IAgentRuntime) {
    const walletInfo =
        await WalletProvider.createFromRuntime(runtime).fetchPortfolioValue();
    const items = walletInfo.items;
    return items;
}

// check if the token symbol is in the wallet
async function getTokenFromWallet(runtime: IAgentRuntime, tokenSymbol: string) {
    try {
        const items = await getTokensInWallet(runtime);
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

// swapToken should took CA, not symbol

export const executeSwap: Action = {
    name: "EXECUTE_SWAP",
    similes: ["SWAP_TOKENS", "TOKEN_SWAP", "TRADE_TOKENS", "EXCHANGE_TOKENS"],
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        // Check if the necessary parameters are provided in the message
        console.log("Message:", message);
        return true;
    },
    description: "Perform a token swap.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        // composeState
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        const walletInfo = await walletProvider.get(runtime, message, state);

        state.walletInfo = walletInfo;

        const swapContext = composeContext({
            state,
            template: swapTemplate,
        });

        const response = await generateObjectDeprecated({
            runtime,
            context: swapContext,
            modelClass: ModelClass.LARGE,
        });

        console.log("Response:", response);
        // const type = response.inputTokenSymbol?.toUpperCase() === "SOL" ? "buy" : "sell";

        // Add SOL handling logic
        if (response.inputTokenSymbol?.toUpperCase() === "SOL") {
            response.inputTokenCA = SOL_ADDRESS;
        }

        if (response.outputTokenSymbol?.toUpperCase() === "SOL") {
            response.outputTokenCA = SOL_ADDRESS;
        }

        // if both contract addresses are set, lets execute the swap
        // TODO: try to resolve CA from symbol based on existing symbol in wallet
        if (!response.inputTokenCA && response.inputTokenSymbol) {
            console.log(
                `Attempting to resolve CA for input token symbol: ${response.inputTokenSymbol}`
            );

            response.inputTokenCA = await getTokenFromWallet(
                runtime,
                response.inputTokenSymbol
            );

            if (response.inputTokenCA) {
                console.log(`Resolved inputTokenCA: ${response.inputTokenCA}`);
            } else {
                console.log("No contract addresses provided, skipping swap");
                const responseMsg = {
                    text: "I need the contract addresses to perform the swap",
                };
                callback?.(responseMsg);
                return true;
            }
        }

        if (!response.outputTokenCA && response.outputTokenSymbol) {
            console.log(
                `Attempting to resolve CA for output token symbol: ${response.outputTokenSymbol}`
            );

            response.outputTokenCA = await getTokenFromWallet(
                runtime,
                response.outputTokenSymbol
            );

            if (response.outputTokenCA) {
                console.log(
                    `Resolved outputTokenCA: ${response.outputTokenCA}`
                );
            } else {
                console.log("No contract addresses provided, skipping swap");
                const responseMsg = {
                    text: "I need the contract addresses to perform the swap",
                };
                await callback?.(responseMsg);
                return true;
            }
        }

        if (!response.amount) {
            console.log("No amount provided, skipping swap");
            const responseMsg = {
                text: "I need the amount to perform the swap",
            };
            await callback?.(responseMsg);
            return true;
        }

        // TODO: if response amount is half, all, etc, semantically retrieve amount and return as number
        if (!response.amount) {
            console.log("Amount is not a number, skipping swap");
            const responseMsg = {
                text: "The amount must be a number",
            };
            await callback?.(responseMsg);
            return true;
        }
        try {
            const connection = new Connection(
                "https://api.mainnet-beta.solana.com"
            );
            const { publicKey: walletPublicKey } = await getWalletKey(
                runtime,
                false
            );

            // const provider = new WalletProvider(connection, walletPublicKey);

            console.log("Wallet Public Key:", walletPublicKey);
            console.log("inputTokenSymbol:", response.inputTokenCA);
            console.log("outputTokenSymbol:", response.outputTokenCA);
            console.log("amount:", response.amount);

            const swapResult = await swapToken(
                connection,
                walletPublicKey!,
                response.inputTokenCA as string,
                response.outputTokenCA as string,
                response.amount as number
            );

            console.log("Deserializing transaction...");
            const transactionBuf = Buffer.from(
                swapResult.swapTransaction,
                "base64"
            );
            const transaction =
                VersionedTransaction.deserialize(transactionBuf);

            console.log("Preparing to sign transaction...");

            console.log("Creating keypair...");
            const { keypair } = await getWalletKey(runtime, true);
            // Verify the public key matches what we expect
            if (keypair!.publicKey.toBase58() !== walletPublicKey!.toBase58()) {
                throw new Error(
                    "Generated public key doesn't match expected public key"
                );
            }

            console.log("Signing transaction...");
            transaction.sign([keypair!]);

            console.log("Sending transaction...");

            const latestBlockhash = await connection.getLatestBlockhash();

            const txid = await connection.sendTransaction(transaction, {
                skipPreflight: false,
                maxRetries: 3,
                preflightCommitment: "confirmed",
            });

            console.log("Transaction sent:", txid);

            // Confirm transaction using the blockhash
            const confirmation = await connection.confirmTransaction(
                {
                    signature: txid,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                },
                "confirmed"
            );

            if (confirmation.value.err) {
                throw new Error(
                    `Transaction failed: ${confirmation.value.err}`
                );
            }

            if (confirmation.value.err) {
                throw new Error(
                    `Transaction failed: ${confirmation.value.err}`
                );
            }

            console.log("Swap completed successfully!");
            console.log(`Transaction ID: ${txid}`);

            const responseMsg = {
                text: `Swap completed successfully! Transaction ID: ${txid}`,
            };

            await callback?.(responseMsg);

            return true;
        } catch (error) {
            console.error("Error during token swap:", error);
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    inputTokenSymbol: "SOL",
                    outputTokenSymbol: "USDC",
                    amount: 0.1,
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Swapping 0.1 SOL for USDC...",
                    action: "TOKEN_SWAP",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Swap completed successfully! Transaction ID: ...",
                },
            },
        ],
        // Add more examples as needed
    ] as ActionExample[][],
} as Action;
