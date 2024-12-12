import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import { SOL_ADDRESS, USDC_ADDRESS } from "../constants";

async function getTokenBalance(
    connection: Connection,
    walletPublicKey: PublicKey,
    tokenMintAddress: PublicKey
): Promise<number> {
    const tokenAccountAddress = await getAssociatedTokenAddress(
        tokenMintAddress,
        walletPublicKey
    );

    try {
        const tokenAccount = await getAccount(connection, tokenAccountAddress);
        const tokenAmount = tokenAccount.amount as unknown as number;
        return tokenAmount;
    } catch (error) {
        console.error(
            `Error retrieving balance for token: ${tokenMintAddress.toBase58()}`,
            error
        );
        return 0;
    }
}

async function getTokenBalances(
    connection: Connection,
    walletPublicKey: PublicKey
): Promise<{ [tokenName: string]: number }> {
    const tokenBalances: { [tokenName: string]: number } = {};

    // Add the token mint addresses you want to retrieve balances for
    const tokenMintAddresses = [
        new PublicKey(USDC_ADDRESS), // USDC
        new PublicKey(SOL_ADDRESS), // SOL
        // Add more token mint addresses as needed
    ];

    for (const mintAddress of tokenMintAddresses) {
        const tokenName = getTokenName(mintAddress);
        const balance = await getTokenBalance(
            connection,
            walletPublicKey,
            mintAddress
        );
        tokenBalances[tokenName] = balance;
    }

    return tokenBalances;
}

function getTokenName(mintAddress: PublicKey): string {
    // Implement a mapping of mint addresses to token names
    const tokenNameMap: { [mintAddress: string]: string } = {
        [USDC_ADDRESS]: "USDC",
        [SOL_ADDRESS]: "SOL",
        // Add more token mint addresses and their corresponding names
    };

    return tokenNameMap[mintAddress.toBase58()] || "Unknown Token";
}

export { getTokenBalance, getTokenBalances };
