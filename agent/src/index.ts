import { SqliteDatabaseAdapter } from "@ai16z/adapter-sqlite";
import { DirectClientInterface } from "@ai16z/client-direct";
import { TelegramClientInterface } from "@ai16z/client-telegram";
import { TwitterClientInterface } from "@ai16z/client-twitter";
import {
    DbCacheAdapter,
    ICacheManager,
    IDatabaseCacheAdapter,
    stringToUuid,
    AgentRuntime,
    CacheManager,
    Character,
    IAgentRuntime,
    ModelProviderName,
    elizaLogger,
    settings,
    IDatabaseAdapter,
    Client,
    Plugin,
    UUID,
} from "@ai16z/eliza";
import { bootstrapPlugin } from "@ai16z/plugin-bootstrap";
import { createNodePlugin, NodePlugin } from "@ai16z/plugin-node";
import { solanaPlugin } from "@ai16z/plugin-solana";
import Database from "better-sqlite3";
import fs from "fs";
import readline from "readline";
import yargs from "yargs";
import path from "path";
import { fileURLToPath } from "url";

import type { DirectClient } from "@ai16z/client-direct";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export function parseArguments(): {
    character?: string;
    characters?: string;
} {
    try {
        return yargs(process.argv.slice(2))
            .option("character", {
                type: "string",
                description: "Path to the character JSON file",
            })
            .option("characters", {
                type: "string",
                description:
                    "Comma separated list of paths to character JSON files",
            })
            .parseSync();
    } catch (error) {
        console.error("Error parsing arguments:", error);
        return {};
    }
}

export function getTokenForProvider(
    provider: ModelProviderName,
    character: Character
) {
    switch (provider) {
        case ModelProviderName.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        default:
            throw new Error("INVALID MODEL");
    }
}

function initializeDatabase(dataDir: string) {
    if (process.env.POSTGRES_URL) {
        // const db = new PostgresDatabaseAdapter({
        //     connectionString: process.env.POSTGRES_URL,
        // });
        // return db;
    } else {
        const filePath =
            process.env.SQLITE_FILE ?? path.resolve(dataDir, "db.sqlite");
        const db = new SqliteDatabaseAdapter(new Database(filePath));
        return db;
    }
}

export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    const clients: Client[] = [];
    const clientTypes =
        character.clients?.map((str) => str.toLowerCase()) || [];

    if (clientTypes.includes("telegram")) {
        const telegramClient = await TelegramClientInterface.start(runtime);
        if (telegramClient) clients.push(telegramClient as Client);
    }

    if (clientTypes.includes("twitter")) {
        const twitterClients = await TwitterClientInterface.start(runtime);
        clients.push(twitterClients as Client);
    }

    if (character.plugins?.length > 0) {
        for (const plugin of character.plugins) {
            if (plugin.clients) {
                for (const client of plugin.clients) {
                    await client.start(runtime);
                    clients.push(client);
                }
            }
        }
    }

    return clients;
}

let nodePlugin: NodePlugin;

export function createAgent(
    character: Character,
    db: IDatabaseAdapter,
    cache: ICacheManager,
    token: string
) {
    elizaLogger.success(
        elizaLogger.successesTitle,
        "Creating runtime for character",
        character.name
    );

    nodePlugin ??= createNodePlugin();

    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        plugins: [bootstrapPlugin, nodePlugin, solanaPlugin].filter(
            Boolean
        ) as Plugin[],
        providers: [],
        actions: [],
        services: [],
        managers: [],
        cacheManager: cache,
    });
}

function intializeDbCache(character: Character, db: IDatabaseCacheAdapter) {
    return new CacheManager(new DbCacheAdapter(db, character.id!));
}

async function startAgent(character: Character) {
    elizaLogger.log("Starting Agent: ", character.name);

    try {
        character.id ??= stringToUuid(character.name);
        character.username ??= character.name;

        const token = getTokenForProvider(character.modelProvider, character);
        const dataDir = path.join(__dirname, "../data");

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        const db = initializeDatabase(dataDir)!;

        await db.init();

        const cache = intializeDbCache(character, db);
        const runtime = createAgent(character, db, cache, token!);

        return runtime;
    } catch (error) {
        elizaLogger.error(
            `Error starting agent for character ${character.name}:`,
            error
        );
        console.error(error);
        throw error;
    }
}

async function handleUserInput(
    rl: readline.Interface,
    agentId: UUID,
    roomId: string,
    input: string
) {
    if (input.toLowerCase() === "exit") {
        rl.close();
        process.exit(0);
    }

    try {
        const serverPort = parseInt(settings.SERVER_PORT || "3000");

        const response = await fetch(
            `http://localhost:${serverPort}/${agentId}/message`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: input,
                    userId: "user",
                    userName: "User",
                    roomId,
                }),
            }
        );

        const data = await response.json();
        data.forEach((message) => console.log(`${"Agent"}: ${message.text}`));
    } catch (error) {
        console.error("Error fetching response:", error);
    }
}

function chat(rl: readline.Interface, agentId: UUID, roomId: UUID) {
    rl.question("You: ", async (input) => {
        await handleUserInput(rl, agentId, roomId, input);
        chat(rl, agentId, roomId); // Loop back to ask another question
    });
}

async function start() {
    const directClient = (await DirectClientInterface.start()) as DirectClient;
    const character = (await import("./character")).character;
    character.id ??= stringToUuid(character.name);
    const pmarca = await startAgent(character);

    directClient.registerAgent(pmarca);

    await pmarca.initialize();

    await initializeClients(character, pmarca);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.on("SIGINT", () => {
        rl.close();
        process.exit(0);
    });

    chat(rl, character.id!, stringToUuid("test-" + Date.now()));
}

start().catch((err) => {
    console.error(err);
});
