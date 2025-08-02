import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
dotenv.config();

const SUI_RPC = process.env.SUI_RPC as string;
const SUI_KEYPAIR = process.env.SUI_KEYPAIR as string;
const FUSION_LOCKER_PACKAGE =
  process.env.FUSION_LOCKER_PACKAGE ||
  "0xfc2cd9bf4cc4135ec27dbf8e12f9ec37690c95f47a98b5406feb09aa060bcaf8";

async function main() {
  console.log(
    "🔓 Completing the cross-chain swap by revealing secret on Sui...\n"
  );

  // Read the generated secret
  const secretInfo = JSON.parse(
    fs.readFileSync("./generatedSecret.json", "utf8")
  );
  const secret = secretInfo.secret;
  const secretBytes = Uint8Array.from(Buffer.from(secret.slice(2), "hex"));
  const txDigest = secretInfo.txDigest;
  let sharedLockerIdFromFile: string | undefined = secretInfo.lockerId;

  console.log("Secret to reveal:", secret);
  console.log("Original Sui tx:", txDigest);

  const provider = new SuiClient({ url: SUI_RPC });
  const kp = Ed25519Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(SUI_KEYPAIR))
  );

  // Find the SharedLocker object from the transaction that created it
  console.log("Looking for SharedLocker object...");

  const txDetails = await provider.getTransactionBlock({
    digest: txDigest,
    options: { showObjectChanges: true },
  });

  let sharedLockerId: string | undefined = sharedLockerIdFromFile;
  for (const change of txDetails.objectChanges || []) {
    if (
      (change.type === "created" ||
        change.type === "shared" ||
        change.type === "sharedObject") &&
      typeof change.objectType === "string" &&
      change.objectType.includes("shared_locker::SharedLocker")
    ) {
      sharedLockerId = (change as any).objectId;
      console.log("✅ Found SharedLocker:", sharedLockerId);
      break;
    }
  }

  if (!sharedLockerId) {
    console.error("❌ Could not find SharedLocker object ID");
    return;
  }

  // Reveal the secret by claiming the locker
  console.log("\n🎯 Revealing secret on Sui (simulating resolver claim)...");

  // We must reference the *shared object* with its initial version.
  const lockerMeta = await provider.getObject({
    id: sharedLockerId,
    options: { showContent: false, showOwner: true },
  });
  console.log("Locker metadata:", JSON.stringify(lockerMeta, null, 2));
  const initialVersion = Number(
    (lockerMeta as any).data?.owner?.Shared?.initial_shared_version ??
      (lockerMeta as any).data?.version ??
      (lockerMeta as any).version ??
      1
  );
  console.log("Initial version:", initialVersion);

  const tx = new Transaction();
  console.log("Creating objectRef with:", {
    objectId: sharedLockerId,
    initialSharedVersion: initialVersion,
    mutable: true,
  });
  tx.moveCall({
    target: `${FUSION_LOCKER_PACKAGE}::shared_locker::claim_shared`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      tx.object(sharedLockerId),
      tx.pure.vector("u8", Array.from(secretBytes)),
      tx.pure.address(kp.getPublicKey().toSuiAddress()),
      tx.object("0x6"),
    ],
  });
  tx.setGasBudget(BigInt(20_000_000));

  try {
    console.log("Executing transaction...");
    const result = await provider.signAndExecuteTransaction({
      signer: kp,
      transaction: tx,
      options: { showEvents: true, showEffects: true },
    });

    console.log("✅ Secret revealed on Sui!");
    console.log("Transaction digest:", result.digest);
    console.log("Events emitted:", result.events?.length || 0);

    // Check for SecretRevealed event
    for (const event of result.events || []) {
      if (event.type.includes("SecretRevealed")) {
        console.log("🎉 SecretRevealed event found!");
        console.log("Event data:", event.parsedJson);
      }
    }

    console.log(
      "\n📡 The relayer should now pick up this event and submit the secret to Ethereum!"
    );
    console.log(
      "🔗 Sui transaction: https://suiscan.xyz/testnet/tx/" + result.digest
    );
  } catch (error: any) {
    console.error("❌ Failed to reveal secret:", error.message);
    console.error("Full error:", error);
    if (error.message.includes("E_CLAIM_TOO_EARLY")) {
      console.log("⏰ Timelock not yet expired, waiting...");
    } else if (error.message.includes("E_HASH_MISMATCH")) {
      console.log("🔐 Hash mismatch - secret doesn't match hashlock");
    }
  }
}

main().catch(console.error);
