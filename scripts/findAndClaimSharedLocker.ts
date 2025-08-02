import dotenv from "dotenv";
import fs from "fs";
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

dotenv.config();

const { SUI_RPC, SUI_KEYPAIR, FUSION_LOCKER_PACKAGE, SUI_ADDRESS } =
  process.env as Record<string, string>;

async function main() {
  const provider = new SuiClient({ url: SUI_RPC });
  const kp = Ed25519Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(SUI_KEYPAIR))
  );
  const myAddress = kp.getPublicKey().toSuiAddress();

  // Read the secret info
  const secretInfo = JSON.parse(
    fs.readFileSync("./generatedSecret.json", "utf8")
  );
  const secret = secretInfo.secret;
  const secretBytes = Uint8Array.from(Buffer.from(secret.slice(2), "hex"));

  console.log("Looking for SharedLocker objects...");
  console.log("Secret:", secret);
  console.log("TX Digest:", secretInfo.txDigest);

  // Get transaction details to find the SharedLocker
  const txInfo = await provider.getTransactionBlock({
    digest: secretInfo.txDigest,
    options: { showObjectChanges: true, showEvents: true },
  });

  console.log("\nTransaction object changes:");
  let sharedLockerId: string | undefined;

  for (const change of txInfo.objectChanges || []) {
    console.log("- Change:", change.type, (change as any).objectType);
    if (
      (change.type === "created" || change.type === "shared") &&
      typeof (change as any).objectType === "string" &&
      (change as any).objectType.includes("shared_locker::SharedLocker")
    ) {
      sharedLockerId = (change as any).objectId;
      console.log("✅ Found SharedLocker ID:", sharedLockerId);
      break;
    }
  }

  if (!sharedLockerId) {
    console.log("❌ Could not find SharedLocker object ID");
    return;
  }

  // Update the mapping
  const mappingPath = "./secretMapping.json";
  let mapping: any = {};
  if (fs.existsSync(mappingPath)) {
    mapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
  }

  const hashlockKeccak = secretInfo.hash_keccak;
  if (!mapping[hashlockKeccak]) {
    mapping[hashlockKeccak] = {};
  }
  mapping[hashlockKeccak].lockerId = sharedLockerId;

  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
  console.log("✅ Updated mapping with SharedLocker ID");

  // Now claim the SharedLocker
  console.log("\n🔓 Claiming SharedLocker...");

  const claimTx = new Transaction();
  claimTx.moveCall({
    target: `${FUSION_LOCKER_PACKAGE}::shared_locker::claim_shared`,
    typeArguments: ["0x2::sui::SUI"],
    arguments: [
      claimTx.object(sharedLockerId),
      claimTx.pure(secretBytes),
      claimTx.pure.address(SUI_ADDRESS || myAddress),
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

  if (claimResult.events && claimResult.events.length > 0) {
    for (const event of claimResult.events) {
      console.log("Event:", event.type);
      if (event.type.includes("SrcSecretRevealed")) {
        console.log("🎉 SrcSecretRevealed event found!");
        console.log("Event data:", event.parsedJson);
      }
    }
  }
}

main().catch(console.error);
