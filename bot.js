import { Connection, PublicKey } from "@solana/web3.js";
import { getRaydiumPools, getTokenInfo, checkHoneypotRisk, checkWhaleRisk, checkTaxRate, checkDeveloperHistory, checkVolumeAndHolders } from "./raydiumUtils";
import { buyToken, sellToken } from "./tradingFunctions";
import { signTransactionWithPhantom } from "./phantomIntegration";
import { sendTelegramNotification } from "./telegramUtils";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const TAKE_PROFIT_MULTIPLIER = 2; // Take profit when price doubles
const STOP_LOSS_MULTIPLIER = 0.7; // Stop loss at 30% drop
const MAX_TRADE_AMOUNT = 0.5; // Maximum SOL per trade
const SLIPPAGE_TOLERANCE = 0.02; // 2% slippage tolerance
const WHITELISTED_POOLS = ["EXAMPLE_POOL_ADDRESS1", "EXAMPLE_POOL_ADDRESS2"]; // Add trusted pool addresses

async function reconnect() {
    console.log("Attempting to reconnect...");
    let retries = 0;
    while (retries < 10) {
        try {
            await connection.getEpochInfo();
            console.log("Reconnected successfully!");
            return;
        } catch (error) {
            console.log(`Reconnect attempt ${retries + 1} failed. Retrying in 5 seconds...`);
            await new Promise(res => setTimeout(res, 5000));
            retries++;
        }
    }
    console.log("Failed to reconnect after 10 attempts. Exiting bot.");
    process.exit(1);
}

async function snipeNewToken() {
    console.log("Scanning for new tokens on Raydium...");
    try {
        const pools = await getRaydiumPools();
        for (let pool of pools) {
            if (!WHITELISTED_POOLS.includes(pool.tokenMintAddress)) {
                console.log(`Skipping ${pool.symbol} - Not in whitelist.`);
                continue;
            }

            const tokenInfo = await getTokenInfo(pool.tokenMintAddress);
            
            if (!tokenInfo || tokenInfo.liquidity < 5000) continue;
            
            const isHoneypot = await checkHoneypotRisk(pool.tokenMintAddress);
            const isWhaleRisk = await checkWhaleRisk(pool.tokenMintAddress);
            const taxRate = await checkTaxRate(pool.tokenMintAddress);
            const isDevRisk = await checkDeveloperHistory(pool.tokenMintAddress);
            const isLowVolume = await checkVolumeAndHolders(pool.tokenMintAddress);
            
            if (isHoneypot || isWhaleRisk || taxRate > 10 || isDevRisk || isLowVolume) {
                console.log(`Skipping ${pool.symbol} - Risk detected (Honeypot: ${isHoneypot}, Whale: ${isWhaleRisk}, Tax: ${taxRate}%, Dev History: ${isDevRisk}, Low Volume: ${isLowVolume})`);
                continue;
            }
            
            console.log(`Attempting to buy ${pool.symbol}...`);
            const buyTx = await buyToken(pool.tokenMintAddress, Math.min(0.1, MAX_TRADE_AMOUNT), SLIPPAGE_TOLERANCE); 
            const signedBuyTx = await signTransactionWithPhantom(buyTx);
            await connection.sendRawTransaction(signedBuyTx.serialize(), { skipPreflight: true, preflightCommitment: "confirmed" });
            console.log(`Purchased ${pool.symbol} successfully!`);
            sendTelegramNotification(`Purchased ${pool.symbol}`);

            await monitorAndSell(pool.tokenMintAddress);
        }
    } catch (error) {
        console.log("Connection error detected, attempting to reconnect...");
        await reconnect();
        await snipeNewToken();
    }
}

async function monitorAndSell(tokenAddress) {
    console.log(`Monitoring ${tokenAddress} for take profit or stop loss...");
    let initialPrice = await getTokenPrice(tokenAddress);
    while (true) {
        try {
            let currentPrice = await getTokenPrice(tokenAddress);
            if (currentPrice >= initialPrice * TAKE_PROFIT_MULTIPLIER) {
                console.log(`Selling ${tokenAddress} - Take profit reached!");
                sendTelegramNotification(`Take profit hit for ${tokenAddress}`);
                await executeSell(tokenAddress);
                break;
            }
            if (currentPrice <= initialPrice * STOP_LOSS_MULTIPLIER) {
                console.log(`Selling ${tokenAddress} - Stop loss triggered!");
                sendTelegramNotification(`Stop loss hit for ${tokenAddress}`);
                await executeSell(tokenAddress);
                break;
            }
            await new Promise(res => setTimeout(res, 5000));
        } catch (error) {
            console.log("Connection error while monitoring. Attempting to reconnect...");
            await reconnect();
        }
    }
}

async function executeSell(tokenAddress) {
    try {
        const sellTx = await sellToken(tokenAddress, "ALL");
        const signedSellTx = await signTransactionWithPhantom(sellTx);
        await connection.sendRawTransaction(signedSellTx.serialize(), { skipPreflight: true, preflightCommitment: "confirmed" });
        console.log(`Sold ${tokenAddress} successfully!");
    } catch (error) {
        console.log("Connection error during sell. Attempting to reconnect...");
        await reconnect();
        await executeSell(tokenAddress);
    }
}

snipeNewToken().catch(console.error);
