import { TrustScoreDatabase, TokenPerformance } from "@ai16z/plugin-trustdb";
import { IAgentRuntime } from "@ai16z/eliza";
import * as amqp from "amqplib";
import { Sonar, TrustScoreBeClient } from "../clients.ts";
import { TrustScoreManager } from "./trustScoreProvider.ts";
import { SellDecision } from "../types.ts";
import { WalletProvider } from "./wallet.ts";

export class SimulationSellingService {
    private readonly trustManager: TrustScoreManager;
    private readonly trustScoreDb: TrustScoreDatabase;

    private readonly backend?: TrustScoreBeClient;
    private readonly sonar?: Sonar;

    private amqpConnection?: amqp.Connection;
    private amqpChannel?: amqp.Channel;

    private runningProcesses: Set<string> = new Set();

    private wallet: WalletProvider;

    constructor(
        runtime: IAgentRuntime,
        trustManager: TrustScoreManager,
        trustScoreDb: TrustScoreDatabase,
        backend?: TrustScoreBeClient,
        sonar?: Sonar
    ) {
        this.trustManager = trustManager;
        this.trustScoreDb = trustScoreDb;

        this.backend = backend;
        this.sonar = sonar;

        this.wallet = WalletProvider.createFromRuntime(runtime);

        const amqpUrl = runtime.getSetting("AMQP_URL") ?? undefined;
        if (amqpUrl) this.initializeRabbitMQ(amqpUrl);
        // this.runtime = runtime;
    }

    public async startService() {
        // starting the service
        console.log("Starting SellingService...");
        await this.startListeners();
    }

    public async startListeners() {
        // scanning recommendations and selling
        console.log("Scanning for token performances...");
        const tokenPerformances =
            await this.trustScoreDb.getAllTokenPerformancesWithBalance();

        await this.processTokenPerformances(
            tokenPerformances,
            this.wallet.publicKey.toBase58()
        );
    }

    /**
     * Initializes the RabbitMQ connection and starts consuming messages.
     * @param amqpUrl The RabbitMQ server URL.
     */
    private async initializeRabbitMQ(amqpUrl: string) {
        try {
            this.amqpConnection = await amqp.connect(amqpUrl);
            this.amqpChannel = await this.amqpConnection.createChannel();
            console.log("Connected to RabbitMQ");
            // Start consuming messages
            this.consumeMessages();
        } catch (error) {
            console.error("Failed to connect to RabbitMQ:", error);
        }
    }

    /**
     * Sets up the consumer for the specified RabbitMQ queue.
     */
    private async consumeMessages() {
        const queue = "process_eliza_simulation";
        await this.amqpChannel.assertQueue(queue, { durable: true });
        this.amqpChannel.consume(
            queue,
            (msg) => {
                if (msg !== null) {
                    const content = msg.content.toString();
                    this.processMessage(content);
                    this.amqpChannel.ack(msg);
                }
            },
            { noAck: false }
        );
        console.log(`Listening for messages on queue: ${queue}`);
    }

    /**
     * Processes incoming messages from RabbitMQ.
     * @param message The message content as a string.
     */
    private async processMessage(message: string) {
        try {
            const { tokenAddress, amount, sell_recommender_id } =
                JSON.parse(message);

            console.log(
                `Received message for token ${tokenAddress} to sell ${amount}`
            );

            // todo: update token performance?
            const tokenPerformance =
                await this.trustScoreDb.getTokenPerformance(tokenAddress);

            if (!tokenPerformance) return;

            const recomender = await this.trustManager.getOrCreateRecommender({
                id: sell_recommender_id,
                address: sell_recommender_id,
            });

            const decision: SellDecision = {
                tokenPerformance: tokenPerformance,
                amountToSell: amount,
                recommender: recomender,
            };

            // Execute the sell
            await this.executeSellDecision(decision);

            // Remove from running processes after completion
            this.runningProcesses.delete(tokenAddress);
        } catch (error) {
            console.error("Error processing message:", error);
        }
    }

    /**
     * Executes a single sell decision.
     * @param decision The sell decision containing token performance and amount to sell.
     */
    private async executeSellDecision(decision: SellDecision) {
        const { tokenPerformance, amountToSell } = decision;
        const { tokenAddress } = tokenPerformance;

        try {
            console.log(
                `Executing sell for token ${tokenPerformance.symbol}: ${amountToSell}`
            );

            // Update the sell details

            const recommender = await this.trustManager.getOrCreateRecommender(
                decision.recommender
            );

            // Update sell details in the database
            const sellDetailsData = await this.trustManager.updateSellDetails({
                tokenAddress,
                amount: amountToSell,
                recommender,
                timestamp: new Date().toISOString(),
                isSimulation: true,
            });

            console.log("Sell order executed successfully", sellDetailsData);

            // check if balance is zero and remove token from running processes
            const balance =
                await this.trustScoreDb.getTokenBalance(tokenAddress);

            if (balance === 0) {
                this.runningProcesses.delete(tokenAddress);
            }
            // stop the process in the sonar backend
            await this.sonar?.stopProcess(tokenAddress);
        } catch (error) {
            console.error(
                `Error executing sell for token ${tokenAddress}:`,
                error
            );
        }
    }

    private async processTokenPerformances(
        tokenPerformances: TokenPerformance[],
        walletAddress: string
    ) {
        //  To Do: logic when to sell and how much
        console.log("Deciding when to sell and how much...");
        const runningProcesses = this.runningProcesses;
        // remove running processes from tokenPerformances
        tokenPerformances = tokenPerformances.filter(
            (tp) => !runningProcesses.has(tp.tokenAddress)
        );

        // start the process in the sonar backend
        await Promise.all(
            tokenPerformances.map(async (tokenPerformance) => {
                const [tokenRecommendation] =
                    await this.trustScoreDb.getRecommendationsByToken(
                        tokenPerformance.tokenAddress
                    );

                const process = await this.sonar?.startProcess(
                    tokenPerformance.tokenAddress,
                    tokenPerformance.balance,
                    true,
                    tokenRecommendation.recommenderId,
                    tokenPerformance.initialMarketCap,
                    walletAddress
                );

                if (process) {
                    this.runningProcesses.add(tokenPerformance.tokenAddress);
                }
                // }
            })
        );
    }

    public async processTokenPerformance(
        tokenAddress: string,
        recommenderId: string,
        walletAddress: string
    ) {
        try {
            const runningProcesses = this.runningProcesses;
            // check if token is already being processed
            if (runningProcesses.has(tokenAddress)) {
                console.log(`Token ${tokenAddress} is already being processed`);
                return;
            }
            const tokenPerformance =
                await this.trustScoreDb.getTokenPerformance(tokenAddress);

            if (!tokenPerformance) return;

            const process = await this.sonar?.startProcess(
                tokenAddress,
                tokenPerformance.balance,
                true,
                recommenderId,
                tokenPerformance.initialMarketCap,
                walletAddress
            );

            if (process) {
                this.runningProcesses.add(tokenAddress);
            }
        } catch (error) {
            console.error(
                `Error getting token performance for token ${tokenAddress}:`,
                error
            );
        }
    }
}
