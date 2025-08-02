import dotenv from "dotenv";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { ethers } from "ethers";
import { blake2b } from "@noble/hashes/blake2b";
import { randomBytes } from "crypto";
import fs from "fs";
import { execSync } from "child_process";

dotenv.config();

const SUI_RPC = process.env.SUI_RPC as string;
const SUI_KEYPAIR = process.env.SUI_KEYPAIR as string;
const FUSION_LOCKER_PACKAGE = process.env.FUSION_LOCKER_PACKAGE as string;
const PRIVATE_KEY = process.env.PRIVATE_KEY as string;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC as string;
const ESCROW_FACTORY = process.env.ESCROW_FACTORY as string;

async function main() {
  console.log("🚀 Starting end-to-end Fusion+ test...\n");

  // 1. Generate secret and create Sui locker
  console.log("1️⃣ Creating Sui locker...");
  const secret = randomBytes(32);
  const secretHex = "0x" + Buffer.from(secret).toString("hex");
  const secretHashBlake = blake2b(secret, { dkLen: 32 });
  const secretHashKeccak = ethers.id(secretHex);

  const provider = new SuiClient({ url: SUI_RPC });
  const kp = Ed25519Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(SUI_KEYPAIR))
  );

  const coins = await provider.getCoins({
    owner: kp.getPublicKey().toSuiAddress(),
  });
  const coin = coins.data.sort(
    (a: any, b: any) => Number(b.balance) - Number(a.balance)
  )[0];

  const durationMs = 60 * 60 * 1000; // 1 hour
  const tx = new Transaction();
  tx.moveCall({
    target: `${FUSION_LOCKER_PACKAGE}::shared_locker::maker_lock`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.object(coin.coinObjectId),
      tx.pure(secretHashBlake),
      tx.pure.u64(durationMs),
      tx.pure.address("0x0"),
      tx.object("0x6"),
    ],
  });
  tx.setGasBudget(20_000_000);

  const result = await provider.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showObjectChanges: true, showEvents: true },
  });

  console.log("✅ Sui locker created. Digest:", result.digest);

  // Find the SharedLocker ID from events
  let lockerId: string | undefined;
  for (const event of result.events || []) {
    if (event.type.includes("shared_locker")) {
      console.log("Locker event:", event);
    }
  }

  // Store secret info
  const secretInfo = {
    secret: secretHex,
    hash_blake: "0x" + Buffer.from(secretHashBlake).toString("hex"),
    hash_keccak: secretHashKeccak,
    lockerId: lockerId,
    txDigest: result.digest,
  };

  fs.writeFileSync(
    "./generatedSecret.json",
    JSON.stringify(secretInfo, null, 2)
  );
  console.log("Secret stored:", secretHex);

  // 2. Deploy Ethereum escrow
  console.log("\n2️⃣ Deploying Ethereum escrow...");
  const forgeEnv = {
    ...process.env,
    HASHLOCK: secretHashKeccak,
    ESCROW_FACTORY,
    TOKEN: "0x0000000000000000000000000000000000000000",
    AMOUNT: "100000000000000",
    SAFETY_DEPOSIT_ETH: "10000000000000",
    MAKER: "0xFB6a372F2F51a002b390D18693075157A459641F",
  };

  process.chdir("..");
  execSync(
    "forge script script/DeployDstEscrow.s.sol:DeployDstEscrow --rpc-url " +
      SEPOLIA_RPC +
      " --private-key " +
      PRIVATE_KEY +
      " --broadcast --silent",
    {
      env: forgeEnv,
      stdio: "inherit",
    }
  );
  process.chdir("scripts");

  // Get escrow address
  const escrowAddress = execSync(
    `cast call ${ESCROW_FACTORY} "addressOfEscrowDst((bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256))" "(0x0000000000000000000000000000000000000000000000000000000000000000,${secretHashKeccak},1435325369699722995980193414450557866241668244511,1435325369699722995980193414450557866241668244511,0,100000000000000,10000000000000,22974192351690631792139114581139757570668377365542984315043840)" --rpc-url ${SEPOLIA_RPC}`,
    { encoding: "utf8" }
  ).trim();

  const cleanAddress = "0x" + escrowAddress.slice(-40);
  console.log("✅ Ethereum escrow deployed at:", cleanAddress);

  // Update mapping
  const mapping = JSON.parse(fs.readFileSync("./secretMapping.json", "utf8"));
  mapping[secretHashKeccak] = {
    escrowAddress: cleanAddress,
    immutables: {
      orderHash:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      hashlock: secretHashKeccak,
      maker: "0xFB6a372F2F51a002b390D18693075157A459641F",
      taker: "0xFB6a372F2F51a002b390D18693075157A459641F",
      token: "0x0000000000000000000000000000000000000000",
      amount: "100000000000000",
      safetyDeposit: "10000000000000",
      timelocks:
        "22974192351690631792139114581139757570668377365542984315043840",
    },
  };
  fs.writeFileSync("./secretMapping.json", JSON.stringify(mapping, null, 2));

  // 3. Reveal secret on Sui (simulate resolver claiming)
  console.log("\n3️⃣ Revealing secret on Sui...");

  // We need to find the SharedLocker object ID from recent transactions
  const recentTxs = await provider.queryTransactionBlocks({
    filter: { FromAddress: kp.getPublicKey().toSuiAddress() },
    limit: 5,
    options: { showObjectChanges: true },
  });

  let sharedLockerId: string | undefined;
  for (const txBlock of recentTxs.data) {
    for (const change of txBlock.objectChanges || []) {
      if (
        change.type === "created" &&
        typeof change.objectType === "string" &&
        change.objectType.includes("shared_locker::SharedLocker")
      ) {
        sharedLockerId = (change as any).objectId;
        break;
      }
    }
    if (sharedLockerId) break;
  }

  if (sharedLockerId) {
    console.log("Found SharedLocker ID:", sharedLockerId);

    const claimTx = new Transaction();
    claimTx.moveCall({
      target: `${FUSION_LOCKER_PACKAGE}::shared_locker::claim_shared`,
      typeArguments: ["0x2::sui::SUI"],
      arguments: [
        claimTx.object(sharedLockerId),
        claimTx.pure(secret),
        claimTx.pure.address(kp.getPublicKey().toSuiAddress()),
        claimTx.object("0x6"),
      ],
    });
    claimTx.setGasBudget(20_000_000);

    const claimResult = await provider.signAndExecuteTransaction({
      signer: kp,
      transaction: claimTx,
      options: { showEvents: true },
    });

    console.log("✅ Secret revealed on Sui! Digest:", claimResult.digest);
    console.log("Events emitted:", claimResult.events?.length || 0);

    // 4. Simulate relayer picking up the secret and submitting to Ethereum
    console.log("\n4️⃣ Submitting secret to Ethereum escrow...");

    const ethProvider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
    const ethWallet = new ethers.Wallet(PRIVATE_KEY, ethProvider);

    const escrowAbi = [
      "function withdraw(bytes32 secret, (bytes32,bytes32,address,address,address,uint256,uint256,uint256) immutables) external",
    ];

    const escrow = new ethers.Contract(cleanAddress, escrowAbi, ethWallet);
    const immutables = [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      secretHashKeccak,
      "0xFB6a372F2F51a002b390D18693075157A459641F",
      "0xFB6a372F2F51a002b390D18693075157A459641F",
      "0x0000000000000000000000000000000000000000",
      "100000000000000",
      "10000000000000",
      "22974192351690631792139114581139757570668377365542984315043840",
    ];

    const withdrawTx = await escrow.withdraw(secretHex, immutables);
    await withdrawTx.wait();

    console.log("✅ Secret submitted to Ethereum! Tx hash:", withdrawTx.hash);
    console.log("\n🎉 End-to-end test completed successfully!");
    console.log("💰 Funds have been transferred on both chains");
  } else {
    console.log("❌ Could not find SharedLocker object ID");
  }
}

main().catch(console.error);
