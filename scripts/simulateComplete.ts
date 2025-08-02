import dotenv from "dotenv";
import { ethers, type Log } from "ethers";
import fs from "fs";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY as string;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC as string;

async function main() {
  console.log("🎯 Simulating complete cross-chain swap...\n");

  // Read the generated secret
  const secretInfo = JSON.parse(
    fs.readFileSync("./generatedSecret.json", "utf8")
  );
  const secret = secretInfo.secret;
  const secretHashKeccak = secretInfo.hash_keccak;

  console.log("Secret:", secret);
  console.log("Hash:", secretHashKeccak);

  // Get the escrow address from mapping
  const mapping = JSON.parse(fs.readFileSync("./secretMapping.json", "utf8"));
  const escrowData = mapping[secretHashKeccak];

  if (!escrowData || !escrowData.escrowAddress) {
    console.error("❌ No escrow found for this secret hash");
    return;
  }

  const escrowAddress = escrowData.escrowAddress;
  const immutables = escrowData.immutables;

  console.log("Ethereum escrow address:", escrowAddress);
  console.log("Immutables:", immutables);

  // Connect to Ethereum
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  // Check escrow balance before
  const balanceBefore = await provider.getBalance(escrowAddress);
  console.log(
    "Escrow balance before:",
    ethers.formatEther(balanceBefore),
    "ETH"
  );

  // Prepare withdraw call
  const escrowAbi = [
    "function withdraw(bytes32 secret, (bytes32,bytes32,address,address,address,uint256,uint256,uint256) immutables) external",
    "event EscrowWithdrawal(bytes32 secret)",
  ];

  const escrow = new ethers.Contract(escrowAddress, escrowAbi, wallet);

  // Prepare immutables tuple
  const immutablesTuple = [
    immutables.orderHash,
    immutables.hashlock,
    immutables.maker,
    immutables.taker,
    immutables.token,
    immutables.amount,
    immutables.safetyDeposit,
    immutables.timelocks,
  ];

  console.log("\n🔓 Submitting secret to Ethereum escrow...");

  try {
    // Check wallet balance before
    const walletBalanceBefore = await provider.getBalance(wallet.address);
    console.log(
      "Wallet balance before:",
      ethers.formatEther(walletBalanceBefore),
      "ETH"
    );

    const tx = await escrow.withdraw(secret, immutablesTuple);
    console.log("Transaction sent:", tx.hash);

    const receipt = await tx.wait();
    console.log("✅ Transaction confirmed in block:", receipt.blockNumber);

    // Check balances after
    const balanceAfter = await provider.getBalance(escrowAddress);
    const walletBalanceAfter = await provider.getBalance(wallet.address);

    console.log("\n💰 Results:");
    console.log(
      "Escrow balance after:",
      ethers.formatEther(balanceAfter),
      "ETH"
    );
    console.log(
      "Wallet balance after:",
      ethers.formatEther(walletBalanceAfter),
      "ETH"
    );
    console.log(
      "ETH transferred:",
      ethers.formatEther(walletBalanceAfter - walletBalanceBefore),
      "ETH"
    );

    // Check for events
    const events = receipt.logs.filter((log: Log) => {
      try {
        const parsed = escrow.interface.parseLog({
          topics: log.topics,
          data: log.data,
        });
        return parsed?.name === "EscrowWithdrawal";
      } catch {
        return false;
      }
    });

    if (events.length > 0) {
      console.log("🎉 EscrowWithdrawal event emitted!");
    }

    console.log("\n🎊 CROSS-CHAIN SWAP COMPLETED SUCCESSFULLY!");
    console.log(
      "🔗 Ethereum transaction: https://sepolia.etherscan.io/tx/" + tx.hash
    );
  } catch (error: any) {
    console.error("❌ Failed to withdraw:", error.message);

    if (error.message.includes("InvalidSecret")) {
      console.log("🔐 Secret doesn't match the hashlock");
    } else if (error.message.includes("InvalidTime")) {
      console.log("⏰ Outside withdrawal time window");
    } else if (error.message.includes("InvalidCaller")) {
      console.log("👤 Only taker can withdraw");
    }
  }
}

main().catch(console.error);
